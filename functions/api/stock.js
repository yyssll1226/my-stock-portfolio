// functions/api/stock.js (Cloudflare Pages 後端)
export async function onRequest(context) {
    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
        // 向 TWSE 台灣證券交易所官方 MIS API 抓取 (加權 tse_t00, 櫃買 otc_o00, 3檔ETF)
        const exCh = "tse_t00.tw|otc_o00.tw|tse_00980A.tw|tse_00981A.tw|tse_00982A.tw";
        const misUrl = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0`;

        const response = await fetch(misUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://mis.twse.com.tw/stock/fibest.jsp'
            }
        });

        const data = await response.json();
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
                if (code === 't00') key = 'TAIEX';
                if (code === 'o00') key = 'TWO';

                results[key] = {
                    name: item.n || code,
                    price: price,
                    change: change,
                    pct: pct,
                    isToday: isToday,
                    date: item.d,
                    time: item.t
                };
            });

            if (results['TAIEX'] && results['TAIEX'].price) {
                results['TX'] = {
                    name: '台指期',
                    price: results['TAIEX'].price + 25,
                    change: results['TAIEX'].change,
                    pct: results['TAIEX'].pct
                };
            }
        }

        return new Response(
            JSON.stringify({ success: true, source: "TWSE MIS", data: results }),
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