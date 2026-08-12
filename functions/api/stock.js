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
        // 1. 直連 TWSE 台灣證券交易所官方 MIS API (保持原樣完全不動)
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
                    price = resolverYesterdayPrice(yesterday);
                }

                function resolverYesterdayPrice(yPrice) {
                    return yPrice;
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
                    displayName = '加權指數';
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

        // 2. 只單獨修正台指期 (TX)：精確抓取當月近月主力合約
        try {
            const startDate = new Date(now.getTime() - 25 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            const futUrl = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanFuturesDaily&data_id=TX&start_date=${startDate}`;
            const futRes = await fetch(futUrl);
            
            if (futRes.ok) {
                const futJson = await futRes.json();
                if (futJson.data && futJson.data.length > 0) {
                    // 過濾有效近月合約紀錄
                    const validRows = futJson.data.filter(d => {
                        const p = parseFloat(d.close || d.settlement_price || 0);
                        return p > 10000 && p < 35000 && d.contract_date && d.contract_date.length === 6;
                    });

                    if (validRows.length > 0) {
                        // 找到最新日期的近月主力合約 (如 202608)
                        const latestDate = validRows[validRows.length - 1].date;
                        const latestDayRows = validRows.filter(d => d.date === latestDate);
                        latestDayRows.sort((a, b) => a.contract_date.localeCompare(b.contract_date));
                        const frontMonth = latestDayRows[0].contract_date;

                        // 抓取該近月合約算當日價位與漲跌
                        const contractRows = validRows.filter(d => d.contract_date === frontMonth);
                        const len = contractRows.length;
                        if (len > 0) {
                            const todayRow = contractRows[len - 1];
                            const prevRow = len >= 2 ? contractRows[len - 2] : todayRow;

                            const price = parseFloat(todayRow.close || todayRow.settlement_price || 0);
                            const prevPrice = parseFloat(prevRow.close || prevRow.settlement_price || price);

                            if (price > 10000) {
                                const change = price - prevPrice;
                                const pct = prevPrice > 0 ? (change / prevPrice) * 100 : 0;
                                results['TX'] = { name: '台指期', price: price, change: change, pct: pct };
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.warn("台指期近月合約抓取失敗", e);
        }

        // 若台指期抓取失敗，維持 null (前端呈現 --，絕不拿加權指數填充)
        if (!results['TX']) {
            results['TX'] = { name: '台指期', price: null, change: null, pct: null };
        }

        return new Response(
            JSON.stringify({ success: true, source: "TWSE & FinMind Futures", data: results }),
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
