// functions/api/stock.js (Cloudflare Pages 內建後端 - 精準修正 TX 日盤 45148 與夜盤時段判斷)
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

    async function fetchWithTimeout(url, options = {}, timeoutMs = 3500) {
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

    // ================= 2. 台指期 (TX) 行情獲取 =================

    // 【來源 1】鉅亨網 Anue 即時報價 (盤中最新日盤與即時行情)
    if (results["TX"].price === null) {
        try {
            const anueUrl = `https://ws.api.cnyes.com/ws/api/v1/quote/quotes/TFE:TXFM0:FUTURE,TFE:TXF00:FUTURE?_=${Date.now()}`;
            const anueRes = await fetchWithTimeout(anueUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Cache-Control': 'no-cache'
                }
            }, 3000);

            if (anueRes.ok) {
                const anueJson = await anueRes.json();
                let rawList = [];
                if (Array.isArray(anueJson?.data)) rawList = anueJson.data;
                else if (anueJson?.data && typeof anueJson.data === 'object') rawList = Object.values(anueJson.data);

                for (const q of rawList) {
                    // 鉅亨網報價可能為數字或字串，容錯轉型
                    const p = Number(q?.["200026"] ?? q?.price ?? q?.close ?? 0);
                    const c = Number(q?.["200027"] ?? q?.change ?? 0);
                    const pctVal = Number(q?.["200044"] ?? q?.changePercent ?? 0);

                    if (Number.isFinite(p) && p > 0) {
                        results["TX"] = {
                            name: "台指期",
                            price: p,
                            change: c,
                            pct: pctVal,
                            source: "Anue"
                        };
                        break;
                    }
                }
            }
        } catch (e) {
            // Anue 異常時靜默切換
        }
    }

    // 【來源 2】Yahoo 奇摩期貨即時端點
    if (results["TX"].price === null) {
        try {
            const yUrl = `https://tw.stock.yahoo.com/_td-stock/api/resource/FuturesServices.futureIndexQuotes;symbol=WTX%26?_=${Date.now()}`;
            const yRes = await fetchWithTimeout(yUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Cache-Control': 'no-cache'
                }
            }, 3000);

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
                        change: c,
                        pct: pctVal,
                        source: "Yahoo"
                    };
                }
            }
        } catch (e) {
            // Yahoo 失敗靜默切換
        }
    }

    // 【來源 3】FinMind 期貨資料庫 (日盤優先 + 主力合約判斷)
    if (results["TX"].price === null) {
        try {
            const startDate = new Date(now.getTime() - 25 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            const futUrl = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanFuturesDaily&data_id=TX&start_date=${startDate}&_=${Date.now()}`;
            const futRes = await fetchWithTimeout(futUrl, {
                headers: { 'Cache-Control': 'no-cache' }
            }, 3500);

            if (futRes.ok) {
                const futJson = await futRes.json();
                if (futJson.data && Array.isArray(futJson.data) && futJson.data.length > 0) {
                    // 1. 過濾單月份合約
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
                        let dayRows = singleMonthRows.filter(r => String(r.date).slice(0, 10) === latestDate);

                        // 若當天有日盤(position)，優先挑選日盤；否則才採用夜盤(after_market)
                        const positionRows = dayRows.filter(r => r.trading_session === 'position');
                        if (positionRows.length > 0) {
                            dayRows = positionRows;
                        }

                        // 依成交量排序挑選主力合約
                        dayRows.sort((a, b) => (Number(b.volume) || 0) - (Number(a.volume) || 0));
                        const activeContract = dayRows[0];

                        if (activeContract && Number(activeContract.close) > 0) {
                            const p = Number(activeContract.close);
                            const c = Number(activeContract.spread || 0);
                            const pctVal = Number(activeContract.spread_per || 0);
                            const session = activeContract.trading_session === 'after_market' ? '夜盤' : '日盤';

                            results["TX"] = {
                                name: "台指期",
                                price: p,
                                change: c,
                                pct: pctVal,
                                source: `FinMind (${activeContract.contract_date} ${session})`
                            };
                        }
                    }
                }
            }
        } catch (e) {
            console.warn("[TX:FinMind] 解析失敗:", e.message || e);
        }
    }

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
