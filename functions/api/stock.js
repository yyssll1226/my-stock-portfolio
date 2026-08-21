// functions/api/stock.js (Cloudflare Pages 內建後端 - 嚴格無快取、全時段即時台指期與 ETF)
export async function onRequest(context) {
    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0"
    };

    if (context.request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    const STOCKS = {
        '00980A': '主動野村臺灣優選',
        '00981A': '主動統一台股增長',
        '00982A': '主動群益台灣強棒'
    };

    const results = {
        'TAIEX': { name: '加權指數', price: null, change: null, pct: null },
        'TWO': { name: '櫃買指數', price: null, change: null, pct: null },
        'TX': { name: '台指期', price: null, change: null, pct: null, source: null },
        '00980A': { price: null, change: null, pct: null },
        '00981A': { price: null, change: null, pct: null },
        '00982A': { price: null, change: null, pct: null }
    };

    const now = new Date();
    const taiwanTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));
    const yyyy = taiwanTime.getUTCFullYear();
    const mm = String(taiwanTime.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(taiwanTime.getUTCDate()).padStart(2, '0');
    const todayStr = `${yyyy}${mm}${dd}`;

    // 輔助函式：帶有超時與防快取的 fetch
    async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, {
                ...options,
                signal: controller.signal,
                cf: {
                    cacheTtl: 0,
                    cacheEverything: false
                }
            });
            clearTimeout(timeoutId);
            return res;
        } catch (e) {
            clearTimeout(timeoutId);
            throw e;
        }
    }

    // ================= 1. TWSE MIS 官方 API 查詢 (加權、櫃買、3檔主動 ETF) =================
    try {
        const channels = [
            "tse_t00.tw",
            "otc_o00.tw",
            "tse_00980a.tw", "tse_00980A.tw", "otc_00980a.tw",
            "tse_00981a.tw", "tse_00981A.tw", "otc_00981a.tw",
            "tse_00982a.tw", "tse_00982A.tw", "otc_00982a.tw"
        ];
        const misUrl = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(channels.join('|'))}&json=1&delay=0&_=${Date.now()}`;

        const twseRes = await fetchWithTimeout(misUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Referer': 'https://mis.twse.com.tw/stock/fibest.jsp',
                'Cache-Control': 'no-cache'
            }
        }, 4000);

        if (twseRes.ok) {
            const data = await twseRes.json();
            if (data.msgArray && Array.isArray(data.msgArray)) {
                data.msgArray.forEach(item => {
                    const rawCode = String(item.c || '').trim();
                    const upperCode = rawCode.toUpperCase();
                    const yesterday = parseFloat(item.y || 0);

                    let price = null;
                    if (item.z && item.z !== '-') {
                        price = parseFloat(item.z);
                    } else if (item.pz && item.pz !== '-') {
                        price = parseFloat(item.pz);
                    }

                    const isToday = (item.d === todayStr);
                    let change = null;
                    let pct = null;

                    if (Number.isFinite(price) && price > 0 && Number.isFinite(yesterday) && yesterday > 0) {
                        change = price - yesterday;
                        pct = (change / yesterday) * 100;
                    }

                    let key = null;
                    let displayName = item.n || upperCode;

                    if (upperCode === 'T00') {
                        key = 'TAIEX';
                        displayName = '加權指數';
                    } else if (upperCode === 'O00') {
                        key = 'TWO';
                        displayName = '櫃買指數';
                    } else if (STOCKS[upperCode]) {
                        key = upperCode;
                        displayName = STOCKS[upperCode];
                    }

                    if (key && Number.isFinite(price) && price > 0) {
                        results[key] = {
                            name: displayName,
                            price: price,
                            change: change,
                            pct: pct,
                            isToday: isToday,
                            date: item.d || null,
                            time: item.t || null
                        };
                    }
                });
            }
        }
    } catch (e) {
        console.warn("[TWSE MIS] 查詢異常:", e.message || e);
    }

    // ================= 2. 台指期 (TX) 即時跳動行情抓取 =================

    // 【來源 1：鉅亨網 Anue 即時報價 (支援日盤與夜盤連續合約)】
    if (results["TX"].price === null) {
        try {
            // 查詢 TFE:TXFM0:FUTURE (全時段主力) 與 TFE:TXF00:FUTURE (一般主力)
            const anueUrl = `https://ws.api.cnyes.com/ws/api/v1/quote/quotes/TFE:TXFM0:FUTURE,TFE:TXF00:FUTURE?column=200010,200026,200027,200031,200044&_=${Date.now()}`;
            const anueRes = await fetchWithTimeout(anueUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Cache-Control': 'no-cache'
                }
            }, 3500);

            console.log(`[TX:Anue] HTTP Status: ${anueRes.status}`);

            if (anueRes.ok) {
                const anueJson = await anueRes.json();
                const dataPayload = anueJson?.data;

                // 鉅亨網回傳可能是陣列或以代碼為 key 的物件
                let quoteList = [];
                if (Array.isArray(dataPayload)) {
                    quoteList = dataPayload;
                } else if (dataPayload && typeof dataPayload === 'object') {
                    quoteList = Object.values(dataPayload);
                }

                for (const q of quoteList) {
                    const p = parseFloat(q?.["200026"] || q?.price || 0);
                    const c = parseFloat(q?.["200027"] || q?.change || 0);
                    const pctVal = parseFloat(q?.["200044"] || q?.changePercent || 0);

                    if (Number.isFinite(p) && p > 0) {
                        results["TX"] = {
                            name: "台指期",
                            price: p,
                            change: Number.isFinite(c) ? c : 0,
                            pct: Number.isFinite(pctVal) ? pctVal : 0,
                            source: "Anue"
                        };
                        console.log(`[TX:Anue] 成功取得報價 -> 價格: ${p}, 漲跌: ${c}, 漲幅: ${pctVal}%`);
                        break;
                    }
                }
            }
        } catch (e) {
            console.warn("[TX:Anue] 查詢失敗或逾時:", e.message || e);
        }
    }

    // 【來源 2：Yahoo 奇摩期貨即時端點備援 (日盤/夜盤)】
    if (results["TX"].price === null) {
        try {
            const yUrl = `https://tw.stock.yahoo.com/_td-stock/api/resource/FuturesServices.futureIndexQuotes;symbol=WTX%26?_=${Date.now()}`;
            const yRes = await fetchWithTimeout(yUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Cache-Control': 'no-cache'
                }
            }, 3500);

            console.log(`[TX:YahooTW] HTTP Status: ${yRes.status}`);

            if (yRes.ok) {
                const yJson = await yRes.json();
                const quoteObj = yJson?.data?.list?.[0] || yJson?.list?.[0] || yJson?.data;
                const p = parseFloat(quoteObj?.price || quoteObj?.regularMarketPrice || 0);
                const c = parseFloat(quoteObj?.change || 0);
                const pctVal = parseFloat(quoteObj?.changePercent || quoteObj?.regularMarketChangePercent || 0);

                if (Number.isFinite(p) && p > 0) {
                    results["TX"] = {
                        name: "台指期",
                        price: p,
                        change: Number.isFinite(c) ? c : 0,
                        pct: Number.isFinite(pctVal) ? pctVal : 0,
                        source: "YahooTW"
                    };
                    console.log(`[TX:YahooTW] 成功取得報價 -> 價格: ${p}, 漲跌: ${c}, 漲幅: ${pctVal}%`);
                }
            }
        } catch (e) {
            console.warn("[TX:YahooTW] 查詢失敗或逾時:", e.message || e);
        }
    }

    // 【來源 3：FinMind 期貨資料庫 (歷史保底，無盤中跳動)】
    if (results["TX"].price === null) {
        try {
            const startDate = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            const futUrl = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanFuturesDaily&data_id=TX&start_date=${startDate}&_=${Date.now()}`;
            const futRes = await fetchWithTimeout(futUrl, {
                headers: { 'Cache-Control': 'no-cache' }
            }, 3500);

            console.log(`[TX:FinMind] HTTP Status: ${futRes.status}`);

            if (futRes.ok) {
                const futJson = await futRes.json();
                if (futJson.data && Array.isArray(futJson.data) && futJson.data.length > 0) {
                    const validRows = futJson.data.filter(d => {
                        const isTx = (d.futures_id === "TX" || d.future_id === "TX" || !d.futures_id);
                        const isSingleMonth = /^\d{6}$/.test(String(d.contract_date || ''));
                        const p = Number(d.close || d.settlement_price || 0);
                        return isTx && isSingleMonth && p > 0;
                    });

                    if (validRows.length > 0) {
                        const dates = [...new Set(validRows.map(r => String(r.date).slice(0, 10)))].sort();
                        const latestDate = dates[dates.length - 1];
                        const latestDayRows = validRows.filter(r => String(r.date).slice(0, 10) === latestDate)
                            .sort((a, b) => String(a.contract_date).localeCompare(String(b.contract_date)));

                        const front = latestDayRows[0];
                        const price = Number(front.close || front.settlement_price);

                        const prevDate = dates.length >= 2 ? dates[dates.length - 2] : null;
                        const prevRows = prevDate ? validRows.filter(r => String(r.date).slice(0, 10) === prevDate && r.contract_date === front.contract_date) : [];
                        const prevPrice = prevRows.length > 0 ? Number(prevRows[0].close || prevRows[0].settlement_price) : price;

                        const change = price - prevPrice;
                        const pct = prevPrice > 0 ? (change / prevPrice) * 100 : 0;

                        results["TX"] = {
                            name: "台指期",
                            price: price,
                            change: change,
                            pct: pct,
                            source: "FinMind"
                        };
                        console.log(`[TX:FinMind] 成功取得保底價格 -> 價格: ${price}`);
                    }
                }
            }
        } catch (e) {
            console.warn("[TX:FinMind] 備援查詢失敗:", e.message || e);
        }
    }

    // 嚴格規範：若所有來源皆失敗，回傳 null
    if (!results["TX"] || results["TX"].price === null) {
        results["TX"] = { name: "台指期", price: null, change: null, pct: null, source: null };
    }

    return new Response(
        JSON.stringify({
            success: true,
            data: results
        }),
        {
            status: 200,
            headers: corsHeaders
        }
    );
}
