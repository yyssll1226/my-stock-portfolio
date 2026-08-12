// functions/api/stock.js (Cloudflare Pages 內建後端)
export async function onRequest(context) {
    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
    };

    if (context.request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
        // 1. 直連 TWSE 台灣證券交易所官方 MIS API (加權 tse_t00, 櫃買 otc_o00, 3檔ETF)
        const exCh = "tse_t00.tw|otc_o00.tw|tse_00980A.tw|tse_00981A.tw|tse_00982A.tw";
        const misUrl = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0`;

        const twseRes = await fetch(misUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://mis.twse.com.tw/stock/fibest.jsp'
            }
        });

        const data = await twseRes.json();
        const results = {};

        // 取得台灣時間當天 YYYYMMDD
        const now = new Date();
        const taiwanTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));
        const yyyy = taiwanTime.getUTCFullYear();
        const mm = String(taiwanTime.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(taiwanTime.getUTCDate()).padStart(2, '0');
        const todayStr = `${yyyy}${mm}${dd}`;

        if (data.msgArray && Array.isArray(data.msgArray)) {
            data.msgArray.forEach(item => {
                const code = item.c;
                const isToday = (item.d === todayStr);
                const yesterday = parseFloat(item.y || 0);

                let price = null;
                if (item.z && item.z !== '-') {
                    price = parseFloat(item.z);
                } else if (item.pz && item.pz !== '-') {
                    price = parseFloat(item.pz);
                } else if (yesterday > 0) {
                    price = yesterday;
                }

                let change = null;
                let pct = null;

                if (price !== null && yesterday > 0) {
                    change = price - yesterday;
                    pct = (change / yesterday) * 100;
                }

                let key = code;
                let displayName = item.n || code;
                if (code === 't00') {
                    key = 'TAIEX';
                    displayName = '加權指數'; // 強制簡化為「加權指數」
                }
                if (code === 'o00') {
                    key = 'TWO';
                    displayName = '櫃買指數';
                }

                results[key] = {
                    name: displayName,
                    price: price,
                    change: change,
                    pct: pct,
                    isToday: isToday,
                    date: item.d,
                    time: item.t
                };
            });
        }

        // 2. 台指期 (TX) - 第一優先：TAIFEX 期交所官方即時 API ➔ 第二備援：FinMind ➔ 均失敗：傳回 null (顯示 --)
        let txResult = null;

        // 【第一優先】向 TAIFEX 台灣期貨交易所官方 API 請求 (補齊必備防護標頭 Origin & Referer)
        try {
            const taifexUrl = "https://mis.taifex.com.tw/futures/api/getFutureInfo";
            const taifexRes = await fetch(taifexUrl, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Origin': 'https://mis.taifex.com.tw',
                    'Referer': 'https://mis.taifex.com.tw/futures/m/futQuote'
                },
                body: JSON.stringify({ MarketType: '0', SymbolID: ['TX'] })
            });

            if (taifexRes.ok) {
                const txJson = await taifexRes.json();
                let q = null;
                if (txJson && txJson.RtData) {
                    if (txJson.RtData.Quote) {
                        q = txJson.RtData.Quote;
                    } else if (Array.isArray(txJson.RtData.QuoteList) && txJson.RtData.QuoteList.length > 0) {
                        q = txJson.RtData.QuoteList[0];
                    }
                }

                if (q) {
                    const priceStr = (q.CLastPrice && q.CLastPrice !== '-') ? q.CLastPrice : q.CRefPrice;
                    const price = parseFloat(priceStr || 0);
                    const yesterday = parseFloat(q.CRefPrice || price);

                    if (!isNaN(price) && price > 10000 && !isNaN(yesterday) && yesterday > 0) {
                        const change = price - yesterday;
                        const pct = (change / yesterday) * 100;
                        txResult = { name: '台指期', price: price, change: change, pct: pct };
                    }
                }
            }
        } catch (e) {
            console.warn("TAIFEX 官方期貨 API 擷取未成功，嘗試 FinMind 備援...", e);
        }

        // 【第二備援】FinMind 期貨資料庫 API
        if (!txResult) {
            try {
                const startDate = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
                const futUrl = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanFuturesDaily&data_id=TX&start_date=${startDate}`;
                const futRes = await fetch(futUrl);
                if (futRes.ok) {
                    const futJson = await futRes.json();
                    if (futJson.data && futJson.data.length > 0) {
                        const txData = futJson.data.filter(d => (d.close || d.settlement_price) && parseFloat(d.close || d.settlement_price) > 10000);
                        if (txData.length > 0) {
                            const len = txData.length;
                            const latest = txData[len - 1];
                            const price = parseFloat(latest.close || latest.settlement_price || 0);
                            let prevPrice = price;
                            if (len >= 2) prevPrice = parseFloat(txData[len - 2].close || txData[len - 2].settlement_price || price);

                            const change = price - prevPrice;
                            const pct = prevPrice > 0 ? (change / prevPrice) * 100 : 0;

                            if (price > 10000) {
                                txResult = { name: '台指期', price: price, change: change, pct: pct };
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn("FinMind 期貨 API 亦無法取得", e);
            }
        }

        // 兩者均無法取得有效資料時，堅決回傳 null (前端顯示 --，絕不套用加權指數點數)
        results['TX'] = txResult || { name: '台指期', price: null, change: null, pct: null };

        return new Response(
            JSON.stringify({ success: true, source: "TWSE & TAIFEX Official", data: results }),
            {
                status: 200,
                headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    "Cache-Control": "no-store, no-cache, must-revalidate",
                    ...corsHeaders
                }
            }
        );

    } catch (error) {
        return new Response(
            JSON.stringify({ success: false, error: error.message }),
            {
                status: 500,
                headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders }
            }
        );
    }
}
