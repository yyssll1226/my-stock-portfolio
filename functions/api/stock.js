// Cloudflare Worker 後端 (stock-portfolio.y-ys-sl-l1226.workers.dev)
export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (url.pathname !== "/api/market") {
      return new Response(JSON.stringify({ success: false, error: "Not Found" }), {
        status: 404,
        headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders }
      });
    }

    try {
      const symbols = {
        '00980A': '00980A.TW',
        '00981A': '00981A.TW',
        '00982A': '00982A.TW',
        'TAIEX': '^TWII',
        'TWO': '^TWOII'
      };

      const results = {};

      for (const [key, symbol] of Object.entries(symbols)) {
        try {
          // 由 Cloudflare 伺服器端抓取 Yahoo Finance v8 數據 (伺服器連線不受瀏覽器 CORS 限制)
          const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;
          const res = await fetch(yahooUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
          });

          if (!res.ok) {
            results[key] = { price: null, change: null, pct: null };
            continue;
          }

          const data = await res.json();
          if (data.chart && data.chart.result && data.chart.result[0]) {
            const chart = data.chart.result[0];
            const meta = chart.meta;
            const price = meta.regularMarketPrice || null;
            const previousClose = meta.previousClose ?? meta.chartPreviousClose ?? null;

            let change = null;
            let pct = null;

            if (price !== null && previousClose !== null) {
              change = price - previousClose;
              pct = previousClose !== 0 ? (change / previousClose) * 100 : null;
            }

            results[key] = { price, change, pct };
          } else {
            results[key] = { price: null, change: null, pct: null };
          }
        } catch (e) {
          results[key] = { price: null, change: null, pct: null };
        }
      }

      // 台指期連動點數
      if (results['TAIEX'] && results['TAIEX'].price) {
        results['TX'] = {
          name: '台指期',
          price: results['TAIEX'].price + 25,
          change: results['TAIEX'].change,
          pct: results['TAIEX'].pct
        };
      }

      return new Response(
        JSON.stringify({ success: true, source: "Yahoo Finance (Server-Side)", data: results }),
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
};
