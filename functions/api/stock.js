// functions/api/stock.js (Cloudflare Pages 內建後端 - 嚴格無快取、修復台指期多通道即時跳動與 ETF)
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

        const twseRes = await fetch(misUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Referer': 'https://mis.twse.com.tw/stock/fibest.jsp',
                'Cache-Control': 'no-cache'
            }
        });

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
        console.warn("TWSE MIS 查詢失敗:", e);
    }

    // ================= 2. 台指期 (TX) 即時跳動行情抓取 (多重順位) =================

    // 【順位 A】：玩股網 Wantgoo 全球/台指即時 API (支援日盤與夜盤秒級跳動)
    if (results["TX"].price === null) {
        try {
            const wantgooUrl = `https://www.wantgoo.com/global/api/getglobaldefault?_=${Date.now()}`;
            const wgRes = await fetch(wantgooUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Referer': 'https://www.wantgoo.com/global',
                    'Cache-Control': 'no-cache'
                }
            });

            if (wgRes.ok) {
                const wgData = await wgRes.json();
                if (Array.isArray(wgData)) {
                    // 優先找 WTX&(台指期) 或 WTXP&(台指期盤後/夜盤) 或 WTXM&(合併盤)
                    const txItem = wgData.find(item => item.id === 'WTX&') ||
                                   wgData.find(item => item.id === 'WTXP&') ||
                                   wgData.find(item => item.id === 'WTXM&') ||
                                   wgData.find(item => String(item.name || '').includes('台指期'));

                    if (txItem) {
                        const price = parseFloat(String(txItem.deal || txItem.price || '').replace(/,/g, ''));
                        const change = parseFloat(String(txItem.change || '').replace(/,/g, ''));
                        let pct = parseFloat(String(txItem.percentage || txItem.changeRate || '').replace(/,/g, '').replace(/%/g, ''));

                        if (Number.isFinite(price) && price > 0) {
                            if (!Number.isFinite(pct) && Number.isFinite(change)) {
                                const prev = price - change;
                                pct = prev > 0 ? (change / prev) * 100 : 0;
                            }

                            results["TX"] = {
                                name: "台指期",
                                price: price,
                                change: Number.isFinite(change) ? change : 0,
                                pct: Number.isFinite(pct) ? pct : 0,
                                source: "Wantgoo"
                            };
                        }
                    }
                }
            }
        } catch (e) {
            console.warn("Wantgoo 台指期抓取失敗:", e);
        }
    }

    // 【順位 B】：鉅亨網 Anue 即時行情 API 備援
    if (results["TX"].price === null) {
        try {
            const anueUrl = `https://ws.api.cnyes.com/ws/api/v1/quote/quotes/TFE:TXF00:FUTURE?column=200010,200026,200027,200031,200044&_=${Date.now()}`;
            const anueRes = await fetch(anueUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Cache-Control': 'no-cache'
                }
            });

            if (anueRes.ok) {
                const anueJson = await anueRes.json();
                const quote = anueJson?.data?.["TFE:TXF00:FUTURE"] || anueJson?.data?.[0];
                if (quote) {
                    const price = parseFloat(quote["200026"] || quote.price || 0);
                    const change = parseFloat(quote["200027"] || quote.change || 0);
                    const pct = parseFloat(quote["200044"] || quote.changePercent || 0);

                    if (Number.isFinite(price) && price > 0) {
                        results["TX"] = {
                            name: "台指期",
                            price: price,
                            change: change,
                            pct: pct,
                            source: "Anue"
                        };
                    }
                }
            }
        } catch (e) {
            console.warn("Anue 台指期抓取失敗:", e);
        }
    }

    // 【順位 C】：FinMind 期貨資料庫 (歷史收盤保底，無盤中跳動但保證有數值)
    if (results["TX"].price === null) {
        try {
            const startDate = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            const futUrl = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanFuturesDaily&data_id=TX&start_date=${startDate}&_=${Date.now()}`;
            const futRes = await fetch(futUrl, { headers: { 'Cache-Control': 'no-cache' } });

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
                    }
                }
            }
        } catch (e) {
            console.warn("FinMind TX 備援失敗:", e);
        }
    }

    // 規範：若全部失敗回傳 null，前端渲染 --
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
