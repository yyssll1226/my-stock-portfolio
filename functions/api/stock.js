// functions/api/stock.js (Cloudflare Pages 內建後端 - 嚴格無快取、修復 ETF 代碼大小寫與台指期盤中即時跳動)
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

    // 取得台灣時間 (UTC+8)
    const now = new Date();
    const taiwanTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));
    const yyyy = taiwanTime.getUTCFullYear();
    const mm = String(taiwanTime.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(taiwanTime.getUTCDate()).padStart(2, '0');
    const todayStr = `${yyyy}${mm}${dd}`;

    // ================= 1. TWSE MIS 官方 API 查詢 (加權、櫃買、3檔主動 ETF) =================
    try {
        // 包含小寫與大寫頻道，確保 100% 命中 TWSE 內部頻道
        const channels = [
            "tse_t00.tw",
            "otc_o00.tw",
            "tse_00980a.tw", "tse_00980A.tw", "otc_00980a.tw",
            "tse_00981a.tw", "tse_00981A.tw", "otc_00981a.tw",
            "tse_00982a.tw", "tse_00982A.tw", "otc_00982a.tw"
        ];
        const exCh = channels.join("|");
        const misUrl = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0&_=${Date.now()}`;

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
                    const upperCode = rawCode.toUpperCase(); // 強制轉大寫比對，徹底解決 00980a vs 00980A 問題
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

    // ================= 2. TAIFEX 期交所官方即時 API 抓取「台指期 TX」(第一順位即時盤) =================
    try {
        // 先抓一般日盤 (MarketType: "0")，若無則抓盤後夜盤 (MarketType: "1")
        for (const mType of ["0", "1"]) {
            if (results["TX"].price !== null) break;

            const taifexRes = await fetch("https://mis.taifex.com.tw/futures/api/getQuoteList", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "Referer": "https://mis.taifex.com.tw/futures/RegularSession/EquityIndices/Futures/"
                },
                body: JSON.stringify({
                    MarketType: mType,
                    SymbolType: "F",
                    KindID: "1",
                    CID: "TXF",
                    ExpireMonth: "",
                    RowSize: "全部",
                    PageNo: "",
                    SortColumn: "",
                    AscDesc: "A"
                })
            });

            if (taifexRes.ok) {
                const taifexJson = await taifexRes.json();
                const list = taifexJson?.RtData?.QuoteList;
                if (Array.isArray(list) && list.length > 0) {
                    // 過濾出主力近月合約 (單月合約，排除價差)
                    const validContracts = list.filter(c => {
                        const price = parseFloat(c.CLastPrice || c.CBidPrice1 || 0);
                        return price > 0 && String(c.SymbolID || '').startsWith('TX');
                    });

                    if (validContracts.length > 0) {
                        // 取近月主力合約
                        const front = validContracts[0];
                        const txPrice = parseFloat(front.CLastPrice || front.CBidPrice1);
                        const refPrice = parseFloat(front.CRefPrice || 0);

                        let change = null;
                        let pct = null;
                        if (Number.isFinite(txPrice) && txPrice > 0 && Number.isFinite(refPrice) && refPrice > 0) {
                            change = txPrice - refPrice;
                            pct = (change / refPrice) * 100;
                        }

                        results["TX"] = {
                            name: "台指期",
                            price: txPrice,
                            change: change,
                            pct: pct,
                            source: mType === "0" ? "TAIFEX 日盤" : "TAIFEX 夜盤",
                            contract: front.DispEName || front.SymbolID
                        };
                    }
                }
            }
        }
    } catch (e) {
        console.warn("TAIFEX 期交所 API 抓取失敗:", e);
    }

    // ================= 3. Yahoo Finance 即時 API 備援 (台指期 & 缺失的 ETF) =================
    // 如果台指期或任何 ETF 仍為 null，透過 Yahoo Finance 進行秒級備援
    const symbolsToBackup = [];
    if (results["TX"].price === null) symbolsToBackup.push({ key: "TX", symbol: "WTX=F", name: "台指期" });
    
    Object.keys(STOCKS).forEach(code => {
        if (results[code].price === null) {
            symbolsToBackup.push({ key: code, symbol: `${code}.TW`, name: STOCKS[code] });
        }
    });

    if (symbolsToBackup.length > 0) {
        await Promise.all(symbolsToBackup.map(async (target) => {
            try {
                const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(target.symbol)}?interval=1m&range=1d&_=${Date.now()}`;
                const yRes = await fetch(yUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                });

                if (yRes.ok) {
                    const yData = await yRes.json();
                    const meta = yData?.chart?.result?.[0]?.meta;
                    if (meta && Number.isFinite(meta.regularMarketPrice) && meta.regularMarketPrice > 0) {
                        const price = meta.regularMarketPrice;
                        const prevClose = meta.chartPreviousClose || meta.previousClose || price;
                        const change = price - prevClose;
                        const pct = prevClose > 0 ? (change / prevClose) * 100 : 0;

                        results[target.key] = {
                            name: target.name,
                            price: price,
                            change: change,
                            pct: pct,
                            source: "Yahoo Finance"
                        };
                    }
                }
            } catch (err) {
                console.warn(`Yahoo Finance 備援抓取 ${target.symbol} 失敗:`, err);
            }
        }));
    }

    // 回傳嚴格防快取標頭
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
