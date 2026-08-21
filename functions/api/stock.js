// functions/api/stock.js (診斷專用版 - 原始 Response 完整監測與結構定位)
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
        'TX': { name: '台指期', price: null, change: null, pct: null, source: null, debugTrace: null },
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

    const txErrors = [];

    // 帶有 Timeout (4秒) 與防快取的安全 fetch 函式
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

    // ================= 1. TWSE MIS 官方 API 查詢 (維持不變：加權、櫃買、3檔主動 ETF) =================
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

    // ================= 2. TX 診斷專用測試流程 =================

    // 【診斷 1】Anue - TFE:TXFM0:FUTURE (全時段主力)
    if (results["TX"].price === null) {
        try {
            const anueUrl1 = `https://ws.api.cnyes.com/ws/api/v1/quote/quotes/TFE:TXFM0:FUTURE?_=${Date.now()}`;
            const res = await fetchWithTimeout(anueUrl1, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Cache-Control': 'no-cache'
                }
            }, 3500);

            const rawText = await res.text();
            console.log("[TX:Anue-TXFM0] HTTP Status:", res.status);
            console.log("[TX:Anue-TXFM0] Content-Type:", res.headers.get("content-type"));
            console.log("[TX:Anue-TXFM0] Raw response (10000字截取):", rawText.slice(0, 10000));

            if (res.ok) {
                let anueJson = null;
                try {
                    anueJson = JSON.parse(rawText);
                    console.log("[TX:Anue-TXFM0] JSON Root Keys:", Object.keys(anueJson));
                    if (anueJson.data) {
                        console.log("[TX:Anue-TXFM0] JSON data Type:", Array.isArray(anueJson.data) ? "Array" : typeof anueJson.data);
                        console.log("[TX:Anue-TXFM0] JSON data 內容:", JSON.stringify(anueJson.data).slice(0, 5000));
                    }
                } catch (pe) {
                    console.warn("[TX:Anue-TXFM0] JSON Parse 失敗:", pe.message);
                }
            } else {
                txErrors.push(`Anue-TXFM0 HTTP ${res.status}`);
            }
        } catch (e) {
            console.warn("[TX:Anue-TXFM0] Fetch 拋出錯誤:", e.message || e);
            txErrors.push(`Anue-TXFM0 Error: ${e.message || e}`);
        }
    }

    // 【診斷 2】Anue - TFE:TXF00:FUTURE (一般主力)
    if (results["TX"].price === null) {
        try {
            const anueUrl2 = `https://ws.api.cnyes.com/ws/api/v1/quote/quotes/TFE:TXF00:FUTURE?_=${Date.now()}`;
            const res = await fetchWithTimeout(anueUrl2, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Cache-Control': 'no-cache'
                }
            }, 3500);

            const rawText = await res.text();
            console.log("[TX:Anue-TXF00] HTTP Status:", res.status);
            console.log("[TX:Anue-TXF00] Content-Type:", res.headers.get("content-type"));
            console.log("[TX:Anue-TXF00] Raw response (10000字截取):", rawText.slice(0, 10000));

            if (res.ok) {
                let anueJson = null;
                try {
                    anueJson = JSON.parse(rawText);
                    console.log("[TX:Anue-TXF00] JSON Root Keys:", Object.keys(anueJson));
                    if (anueJson.data) {
                        console.log("[TX:Anue-TXF00] JSON data Type:", Array.isArray(anueJson.data) ? "Array" : typeof anueJson.data);
                        console.log("[TX:Anue-TXF00] JSON data 內容:", JSON.stringify(anueJson.data).slice(0, 5000));
                    }
                } catch (pe) {
                    console.warn("[TX:Anue-TXF00] JSON Parse 失敗:", pe.message);
                }
            } else {
                txErrors.push(`Anue-TXF00 HTTP ${res.status}`);
            }
        } catch (e) {
            console.warn("[TX:Anue-TXF00] Fetch 拋出錯誤:", e.message || e);
            txErrors.push(`Anue-TXF00 Error: ${e.message || e}`);
        }
    }

    // 【診斷 3】Yahoo 奇摩期貨端點 (WTX&)
    if (results["TX"].price === null) {
        try {
            const yUrl = `https://tw.stock.yahoo.com/_td-stock/api/resource/FuturesServices.futureIndexQuotes;symbol=WTX%26?_=${Date.now()}`;
            const res = await fetchWithTimeout(yUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Cache-Control': 'no-cache'
                }
            }, 3500);

            const rawText = await res.text();
            console.log("[TX:YahooTW] HTTP Status:", res.status);
            console.log("[TX:YahooTW] Content-Type:", res.headers.get("content-type"));
            console.log("[TX:YahooTW] Raw response (10000字截取):", rawText.slice(0, 10000));

            if (res.ok) {
                let yJson = null;
                try {
                    yJson = JSON.parse(rawText);
                    console.log("[TX:YahooTW] JSON Root Keys:", Object.keys(yJson));
                    console.log("[TX:YahooTW] JSON Preview:", JSON.stringify(yJson).slice(0, 5000));
                } catch (pe) {
                    console.warn("[TX:YahooTW] JSON Parse 失敗:", pe.message);
                }
            } else {
                txErrors.push(`YahooTW HTTP ${res.status}`);
            }
        } catch (e) {
            console.warn("[TX:YahooTW] Fetch 拋出錯誤:", e.message || e);
            txErrors.push(`YahooTW Error: ${e.message || e}`);
        }
    }

    // 【診斷 4】FinMind 歷史資料庫檢查
    if (results["TX"].price === null) {
        try {
            const startDate = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            const futUrl = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanFuturesDaily&data_id=TX&start_date=${startDate}&_=${Date.now()}`;
            const res = await fetchWithTimeout(futUrl, {
                headers: { 'Cache-Control': 'no-cache' }
            }, 3500);

            const rawText = await res.text();
            console.log("[TX:FinMind] HTTP Status:", res.status);
            console.log("[TX:FinMind] Raw response (前2000字):", rawText.slice(0, 2000));

            if (res.ok) {
                try {
                    const futJson = JSON.parse(rawText);
                    console.log("[TX:FinMind] 資料筆數 (msg/status/data.length):", futJson.msg, futJson.status, futJson.data?.length);
                    if (futJson.data && futJson.data.length > 0) {
                        console.log("[TX:FinMind] 最後 2 筆原始資料結構:", JSON.stringify(futJson.data.slice(-2)));
                    }
                } catch (pe) {
                    console.warn("[TX:FinMind] JSON Parse 失敗:", pe.message);
                }
            } else {
                txErrors.push(`FinMind HTTP ${res.status}`);
            }
        } catch (e) {
            console.warn("[TX:FinMind] Fetch 拋出錯誤:", e.message || e);
            txErrors.push(`FinMind Error: ${e.message || e}`);
        }
    }

    // 彙整最終診斷狀態
    results["TX"] = {
        name: "台指期",
        price: null,
        change: null,
        pct: null,
        source: null,
        debugTrace: txErrors.join(" | ") || "All Diagnostic Requests Completed"
    };

    console.log("[TX 診斷結論] Trace:", results["TX"].debugTrace);

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
