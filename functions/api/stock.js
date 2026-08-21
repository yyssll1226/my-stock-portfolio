// functions/api/stock.js (Cloudflare Pages 內建後端 - 嚴格無快取、精準鎖定 TX 主力近月與收盤行情)
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

    // 計算台灣時間 (UTC+8)
    const now = new Date();
    const taiwanTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));
    const yyyy = taiwanTime.getUTCFullYear();
    const mm = String(taiwanTime.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(taiwanTime.getUTCDate()).padStart(2, '0');
    const todayStr = `${yyyy}${mm}${dd}`;
    const todayYm = `${yyyy}${mm}`;

    // 帶有 5 秒 Timeout 與強制防快取的 fetch 函式
    async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, {
                ...options,
                signal: controller.signal,
                cf: { cacheTtl: 0, cacheEverything: false }
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
        }, 4500);

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

    // ================= 2. 台指期 (TX) 精確行情獲取 =================
    let txContract = null;
    let txSession = null;

    // 【來源 1：鉅亨網 Anue 即時行情 (5秒超時保護)】
    if (results["TX"].price === null) {
        const symbols = ["TFE:TXFM0:FUTURE", "TFE:TXF00:FUTURE"];
        for (const sym of symbols) {
            if (results["TX"].price !== null) break;
            try {
                const anueUrl = `https://ws.api.cnyes.com/ws/api/v1/quote/quotes/${sym}?_=${Date.now()}`;
                const anueRes = await fetchWithTimeout(anueUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Cache-Control': 'no-cache'
                    }
                }, 4500);

                if (anueRes.ok) {
                    const anueJson = await anueRes.json();
                    let quotes = [];
                    if (Array.isArray(anueJson?.data)) quotes = anueJson.data;
                    else if (anueJson?.data && typeof anueJson.data === 'object') quotes = Object.values(anueJson.data);

                    const q = quotes.find(item => item?.code === sym || item?.symbol === sym) || quotes[0];
                    if (q) {
                        const p = Number(q["200026"] ?? q.price ?? q.close ?? 0);
                        const c = Number(q["200027"] ?? q.change ?? 0);
                        const pctVal = Number(q["200044"] ?? q.changePercent ?? 0);

                        if (Number.isFinite(p) && p > 0) {
                            results["TX"] = {
                                name: "台指期",
                                price: p,
                                change: Number.isFinite(c) ? c : null,
                                pct: Number.isFinite(pctVal) ? pctVal : null,
                                source: "Anue"
                            };
                            txContract = sym;
                            txSession = "即時/收盤";
                            break;
                        }
                    }
                }
            } catch (e) {
                console.warn(`[TX:Anue] 查詢 ${sym} 失敗:`, e.message || e);
            }
        }
    }

    // 【來源 2：Yahoo 奇摩期貨端點備援】
    if (results["TX"].price === null) {
        try {
            const yUrl = `https://tw.stock.yahoo.com/_td-stock/api/resource/FuturesServices.futureIndexQuotes;symbol=WTX%26?_=${Date.now()}`;
            const yRes = await fetchWithTimeout(yUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Cache-Control': 'no-cache'
                }
            }, 4000);

            if (yRes.ok) {
                const yJson = await yRes.json();
                const quoteObj = yJson?.data?.list?.[0] || yJson?.list?.[0];
                const p = Number(quoteObj?.price || quoteObj?.regularMarketPrice || 0);
                const c = Number(quoteObj?.change || 0);
                const pctVal = Number(quoteObj?.changePercent || 0);

                if (Number.isFinite(p) && p > 0) {
                    results["TX"] = {
                        name: "台指期",
                        price: p,
                        change: Number.isFinite(c) ? c : null,
                        pct: Number.isFinite(pctVal) ? pctVal : null,
                        source: "Yahoo"
                    };
                    txContract = "WTX&";
                    txSession = "即時/收盤";
                }
            }
        } catch (e) {
            console.warn("[TX:Yahoo] 查詢失敗:", e.message || e);
        }
    }

    // 【來源 3：FinMind 期貨資料庫 (合約精準判斷 + 日盤優先)】
    if (results["TX"].price === null) {
        try {
            const startDate = new Date(now.getTime() - 25 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            const futUrl = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanFuturesDaily&data_id=TX&start_date=${startDate}&_=${Date.now()}`;
            const futRes = await fetchWithTimeout(futUrl, {
                headers: { 'Cache-Control': 'no-cache' }
            }, 4500);

            if (futRes.ok) {
                const futJson = await futRes.json();
                if (futJson.data && Array.isArray(futJson.data) && futJson.data.length > 0) {
                    // 1. 嚴格過濾單一月份合約 (排除跨月價差)
                    const singleMonthRows = futJson.data.filter(d => {
                        const isTx = (d.futures_id === "TX" || d.future_id === "TX");
                        const isSingleMonth = /^\d{6}$/.test(String(d.contract_date || ''));
                        const hasPrice = Number(d.close) > 0;
                        return isTx && isSingleMonth && hasPrice;
                    });

                    if (singleMonthRows.length > 0) {
                        const dates = [...new Set(singleMonthRows.map(r => String(r.date).slice(0, 10)))].sort();
                        const latestDate = dates[dates.length - 1];

                        // 取得最新日期的所有記錄
                        const dayRows = singleMonthRows.filter(r => String(r.date).slice(0, 10) === latestDate);

                        // 印出完整的 dayRows 供 Cloudflare Log 查核
                        console.log("[TX:FinMind] latest rows:", JSON.stringify(dayRows, null, 2));

                        // 判斷主力近月合約：篩選合約月份 >= 當前年月的合約，並取最小月份 (即當期主力合約，如 202609)
                        const validFutureMonths = dayRows
                            .filter(r => String(r.contract_date) >= todayYm)
                            .sort((a, b) => String(a.contract_date).localeCompare(String(b.contract_date)));

                        const targetContractDate = validFutureMonths.length > 0
                            ? validFutureMonths[0].contract_date
                            : dayRows[0].contract_date;

                        // 取得該主力合約在當天的紀錄
                        const targetContractRows = dayRows.filter(r => r.contract_date === targetContractDate);

                        // 盤別判定：若有日盤 position 優先採用，否則採用 after_market
                        const positionRow = targetContractRows.find(r => r.trading_session === 'position');
                        const selectedRow = positionRow || targetContractRows[0];

                        if (selectedRow && Number(selectedRow.close) > 0) {
                            const p = Number(selectedRow.close);
                            const c = Number.isFinite(Number(selectedRow.spread)) ? Number(selectedRow.spread) : null;
                            const pctVal = Number.isFinite(Number(selectedRow.spread_per)) ? Number(selectedRow.spread_per) : null;
                            const session = selectedRow.trading_session === 'after_market' ? '夜盤' : '日盤';

                            results["TX"] = {
                                name: "台指期",
                                price: p,
                                change: c,
                                pct: pctVal,
                                source: `FinMind (${selectedRow.contract_date} ${session})`
                            };
                            txContract = selectedRow.contract_date;
                            txSession = session;
                        }
                    }
                }
            }
        } catch (e) {
            console.warn("[TX:FinMind] 備援解析失敗:", e.message || e);
        }
    }

    // 格式防護：若所有來源皆失敗，明確回傳 null
    if (!results["TX"] || results["TX"].price === null) {
        results["TX"] = { name: "台指期", price: null, change: null, pct: null, source: null };
    }

    // 依要求輸出標準化 Structured Log
    console.log(`[TX] price=${results["TX"].price} contract=${txContract || 'N/A'} session=${txSession || 'N/A'} source=${results["TX"].source || 'None'}`);

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
