// functions/api/stock.js (Cloudflare Pages 內建後端 - 嚴格無快取、真實盤中即時行情)
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

    const results = {};
    let txFromTwse = false;

    // 取得台灣時間 (UTC+8)
    const now = new Date();
    const taiwanTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));
    const yyyy = taiwanTime.getUTCFullYear();
    const mm = String(taiwanTime.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(taiwanTime.getUTCDate()).padStart(2, '0');
    const todayStr = `${yyyy}${mm}${dd}`;
    const queryTimestamp = now.toISOString();

    console.log(`[行情查詢] 查詢時間 (UTC): ${queryTimestamp}, 台灣日期: ${todayStr}`);

    // ================= 1. TWSE MIS 官方 API 查詢 (第一順位) =================
    try {
        // 包含加權(t00)、櫃買(o00)、3檔ETF，以及 TX 期貨相關頻道
        // 加入 &_=時間戳記 徹底杜絕伺服器端與中繼節點快取
        const exCh = "tse_t00.tw|otc_o00.tw|tse_00980A.tw|tse_00981A.tw|tse_00982A.tw|fut_TX.tw|fut_TXF.tw|taifex_t00.tw";
        const misUrl = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0&_=${Date.now()}`;

        const twseRes = await fetch(misUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://mis.twse.com.tw/stock/fibest.jsp',
                'Cache-Control': 'no-cache'
            }
        });

        if (!twseRes.ok) {
            console.warn(`TWSE MIS HTTP Error: ${twseRes.status}`);
        } else {
            const data = await twseRes.json();
            console.log("TWSE MIS msgArray length:", data.msgArray?.length || 0);

            if (data.msgArray && Array.isArray(data.msgArray)) {
                // (A) 處理加權指數、櫃買指數、3檔 ETF
                data.msgArray.forEach(item => {
                    const code = item.c;
                    const yesterday = parseFloat(item.y || 0);
                    let priceFieldUsed = null;
                    let price = null;

                    // 優先採用當盤成交價 z，次選最近成交價 pz (絕對不以昨收 y 冒充現價)
                    if (item.z && item.z !== '-') {
                        price = parseFloat(item.z);
                        priceFieldUsed = 'z (當盤成交價)';
                    } else if (item.pz && item.pz !== '-') {
                        price = parseFloat(item.pz);
                        priceFieldUsed = 'pz (最近成交價)';
                    }

                    const isToday = (item.d === todayStr);
                    let change = null;
                    let pct = null;

                    if (Number.isFinite(price) && price > 0 && Number.isFinite(yesterday) && yesterday > 0) {
                        change = price - yesterday;
                        pct = (change / yesterday) * 100;
                    }

                    let key = code;
                    let displayName = item.n || code;
                    if (code === 't00') { key = 'TAIEX'; displayName = '加權指數'; }
                    if (code === 'o00') { key = 'TWO'; displayName = '櫃買指數'; }

                    if (key === 'TAIEX' || key === 'TWO' || STOCKS[key]) {
                        console.log(`[TWSE 商品] ${displayName}(${key}) 欄位: ${priceFieldUsed || '無盤中成交'}, 原始價格: ${price}, 昨收(y): ${yesterday}, 漲跌: ${change}, 漲幅: ${pct}%`);

                        results[key] = {
                            name: displayName,
                            price: (Number.isFinite(price) && price > 0) ? price : null,
                            change: change,
                            pct: pct,
                            isToday: isToday,
                            date: item.d || null,
                            time: item.t || null
                        };
                    }
                });

                // (B) 專門尋找 TWSE MIS 中的 TX
                const txItem = data.msgArray.find(item => {
                    const ch = String(item.ch || item.ex || '').toLowerCase();
                    const code = String(item.c || '').toUpperCase();
                    return code === 'TX' || code === 'TXF' || ch.includes('fut_tx') || ch.includes('taifex');
                });

                console.log("TWSE TX item 原始資料:", txItem || null);

                if (txItem) {
                    let txPrice = null;
                    let txFieldUsed = null;
                    if (txItem.z && txItem.z !== '-') {
                        txPrice = parseFloat(txItem.z);
                        txFieldUsed = 'z';
                    } else if (txItem.pz && txItem.pz !== '-') {
                        txPrice = parseFloat(txItem.pz);
                        txFieldUsed = 'pz';
                    }

                    const txYesterday = parseFloat(txItem.y || 0);

                    if (Number.isFinite(txPrice) && txPrice > 0) {
                        let change = null;
                        let pct = null;
                        if (Number.isFinite(txYesterday) && txYesterday > 0) {
                            change = txPrice - txYesterday;
                            pct = (change / txYesterday) * 100;
                        }

                        console.log(`[TWSE TX] 採用欄位: ${txFieldUsed}, 原始價: ${txPrice}, 昨收: ${txYesterday}, 漲跌: ${change}, 漲幅: ${pct}%`);

                        results["TX"] = {
                            name: "台指期",
                            price: txPrice,
                            change: change,
                            pct: pct,
                            source: "TWSE MIS",
                            date: txItem.d || null,
                            time: txItem.t || null
                        };
                        txFromTwse = true;
                    }
                }
            }
        }
    } catch (e) {
        console.warn("TWSE MIS API 執行失敗:", e);
    }

    console.log(`[TX 狀態] TWSE MIS 是否成功取得 TX? -> ${txFromTwse}`);

    // ================= 2. FinMind TaiwanFuturesDaily Fallback (第二順位) =================
    // 嚴格規定：只有當 txFromTwse === false 時才執行 FinMind
    if (!txFromTwse) {
        try {
            const startDate = new Date(now.getTime() - 25 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            const futUrl = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanFuturesDaily&data_id=TX&start_date=${startDate}&_=${Date.now()}`;
            const futRes = await fetch(futUrl, { headers: { 'Cache-Control': 'no-cache' } });

            if (!futRes.ok) {
                const errorText = await futRes.text();
                console.warn("FinMind TX HTTP error:", futRes.status, errorText);
            } else {
                const futJson = await futRes.json();
                console.log("FinMind TX 原始總筆數:", futJson.data?.length || 0);

                if (futJson.data && Array.isArray(futJson.data) && futJson.data.length > 0) {
                    // 過濾 futures_id === "TX" 且 contract_date 為 6 位數字 (排除價差合約)
                    const validRows = futJson.data.filter(d => {
                        const isTx = (d.futures_id === "TX" || d.future_id === "TX" || !d.futures_id);
                        const isSingleMonth = /^\d{6}$/.test(String(d.contract_date || ''));
                        return isTx && isSingleMonth && getUsablePrice(d) !== null;
                    });

                    if (validRows.length > 0) {
                        // 日期去重並排序，取最新日期
                        const dates = [...new Set(
                            validRows
                                .map(row => String(row.date).slice(0, 10))
                                .filter(Boolean)
                        )].sort();

                        const latestDate = dates[dates.length - 1];
                        console.log("FinMind TX 最新日期:", latestDate);

                        // 找最新日期的近月主力合約
                        const latestDayRows = validRows
                            .filter(row => String(row.date).slice(0, 10) === latestDate)
                            .sort((a, b) => String(a.contract_date).localeCompare(String(b.contract_date)));

                        const frontMonth = latestDayRows[0].contract_date;
                        console.log("FinMind TX 近月主力合約:", frontMonth);

                        // 取得近月合約的今日與前一交易日紀錄
                        const contractRows = validRows.filter(row => row.contract_date === frontMonth);
                        const contractDates = [...new Set(
                            contractRows
                                .map(row => String(row.date).slice(0, 10))
                                .filter(Boolean)
                        )].sort();

                        const todayDate = contractDates[contractDates.length - 1];
                        const previousDate = contractDates.length >= 2 ? contractDates[contractDates.length - 2] : null;

                        const todayRows = contractRows.filter(row => String(row.date).slice(0, 10) === todayDate);
                        const previousRows = previousDate ? contractRows.filter(row => String(row.date).slice(0, 10) === previousDate) : [];

                        // 優先選取 position 盤別 (日盤/一般盤)
                        const todayRow = selectBestSessionRow(todayRows);
                        const previousRow = selectBestSessionRow(previousRows);

                        console.log("FinMind TX 今日盤別選取列:", todayRow);
                        console.log("FinMind TX 前日盤別選取列:", previousRow);

                        if (todayRow) {
                            const price = getUsablePrice(todayRow);
                            const prevPrice = previousRow ? getUsablePrice(previousRow) : null;

                            if (Number.isFinite(price) && price > 0) {
                                let change = null;
                                let pct = null;

                                if (Number.isFinite(prevPrice) && prevPrice > 0) {
                                    change = price - prevPrice;
                                    pct = (change / prevPrice) * 100;
                                }

                                console.log(`[FinMind TX 輸出] 價格: ${price}, 昨收: ${prevPrice}, 漲跌: ${change}, 漲幅: ${pct}%`);

                                results["TX"] = {
                                    name: "台指期",
                                    price: price,
                                    change: change,
                                    pct: pct,
                                    source: "FinMind",
                                    date: todayDate,
                                    contract: frontMonth
                                };
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.warn("FinMind TX fallback 執行失敗:", e);
        }
    }

    // 規範 15: 如果兩個來源都失敗，明確給予 null (絕對不拿 TAIEX 冒充)
    if (!results["TX"]) {
        results["TX"] = {
            name: "台指期",
            price: null,
            change: null,
            pct: null,
            source: null
        };
    }

    // 確保所有 ETF 與指數若無資料皆為標準格式 (回傳 null 顯示 --)
    Object.keys(STOCKS).forEach(code => {
        if (!results[code]) {
            results[code] = { price: null, change: null, pct: null };
        }
    });
    ['TAIEX', 'TWO'].forEach(key => {
        if (!results[key]) {
            results[key] = { name: key === 'TAIEX' ? '加權指數' : '櫃買指數', price: null, change: null, pct: null };
        }
    });

    console.log("[最終輸出 API 數據]", JSON.stringify(results));

    // 回傳嚴格防快取標頭
    return new Response(
        JSON.stringify({
            success: true,
            source: txFromTwse ? "TWSE MIS" : (results["TX"].source || "FinMind"),
            data: results
        }),
        {
            status: 200,
            headers: corsHeaders
        }
    );
}

// 輔助函數：取得可用價格 (優先 close，其次 settlement_price)
function getUsablePrice(row) {
    if (!row) return null;
    const close = Number(row.close);
    if (Number.isFinite(close) && close > 0) return close;

    const settlement = Number(row.settlement_price);
    if (Number.isFinite(settlement) && settlement > 0) return settlement;

    return null;
}

// 輔助函數：優先選取 position 盤別 (日盤/一般盤)
function selectBestSessionRow(rows) {
    const usableRows = rows.filter(row => getUsablePrice(row) !== null);
    if (usableRows.length === 0) return null;

    const positionRow = usableRows.find(row => row.trading_session === "position");
    if (positionRow) return positionRow;

    const afterMarketRow = usableRows.find(row => row.trading_session === "after_market");
    return afterMarketRow || usableRows[0];
}
