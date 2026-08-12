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

    const STOCKS = {
        '00980A': '主動野村臺灣優選',
        '00981A': '主動統一台股增長',
        '00982A': '主動群益台灣強棒'
    };

    const results = {};
    let txFromTwse = false;

    // 取得台灣時間當天 YYYYMMDD
    const now = new Date();
    const taiwanTime = new Date(now.getTime() + (8 * 60 * 60 * 1000)); // UTC+8
    const yyyy = taiwanTime.getUTCFullYear();
    const mm = String(taiwanTime.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(taiwanTime.getUTCDate()).padStart(2, '0');
    const todayStr = `${yyyy}${mm}${dd}`;

    // ================= 1. TWSE MIS 官方 API 查詢 (第一順位) =================
    try {
        // 規範 1: 加入 TX 對應的 TWSE/TAIFEX 頻道 (fut_TX, fut_TXF, taifex_t00)
        const exCh = "tse_t00.tw|otc_o00.tw|tse_00980A.tw|tse_00981A.tw|tse_00982A.tw|fut_TX.tw|fut_TXF.tw|taifex_t00.tw";
        const misUrl = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0`;

        const twseRes = await fetch(misUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://mis.twse.com.tw/stock/fibest.jsp'
            }
        });

        // 規範 16: HTTP error 處理
        if (!twseRes.ok) {
            console.warn(`TWSE MIS HTTP Error: ${twseRes.status}`);
        } else {
            const data = await twseRes.json();
            // 規範 17: Debug Log
            console.log("TWSE MIS msgArray length:", data.msgArray?.length || 0);

            if (data.msgArray && Array.isArray(data.msgArray)) {
                // 處理股票與大盤指數 (TAIEX, TWO, ETF)
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
                    if (code === 't00') { key = 'TAIEX'; displayName = '加權指數'; }
                    if (code === 'o00') { key = 'TWO'; displayName = '櫃買指數'; }

                    if (key === 'TAIEX' || key === 'TWO' || STOCKS[key]) {
                        results[key] = {
                            name: displayName,
                            price: price,
                            change: change,
                            pct: pct,
                            isToday: isToday,
                            date: item.d,
                            time: item.t
                        };
                    }
                });

                // 規範 2: 尋找 TWSE MIS 中的 TX
                const txItem = data.msgArray.find(item => {
                    const ch = String(item.ch || item.ex || '').toLowerCase();
                    const code = String(item.c || '').toUpperCase();
                    return code === 'TX' || code === 'TXF' || ch.includes('fut_tx') || ch.includes('taifex');
                });

                // 規範 17: Debug Log
                console.log("TWSE TX item:", txItem || null);

                // 規範 3: 確認 TWSE 抓到的 TX 是否為有效價格
                if (txItem) {
                    let txPrice = null;
                    if (txItem.z && txItem.z !== '-') {
                        txPrice = parseFloat(txItem.z);
                    } else if (txItem.pz && txItem.pz !== '-') {
                        txPrice = parseFloat(txItem.pz);
                    }

                    const txYesterday = parseFloat(txItem.y || 0);

                    if (Number.isFinite(txPrice) && txPrice > 0) {
                        // 規範 4: 優先使用 TWSE API 本身資料計算漲跌
                        let change = null;
                        let pct = null;
                        if (Number.isFinite(txYesterday) && txYesterday > 0) {
                            change = txPrice - txYesterday;
                            pct = (change / txYesterday) * 100;
                        }

                        // 規範 5: TWSE 成功後，寫入 results 並記錄成功狀態
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

    // 規範 17: Debug Log
    console.log("TX source from TWSE?", txFromTwse);

    // ================= 2. FinMind Fallback (第二順位，僅當 TWSE 沒 TX 時執行) =================
    // 規範 5 & 6 & 19: TWSE 成功則絕對不執行；TWSE 無 TX 才執行 FinMind
    if (!txFromTwse) {
        try {
            const startDate = new Date(now.getTime() - 25 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            const futUrl = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanFuturesDaily&data_id=TX&start_date=${startDate}`;
            const futRes = await fetch(futUrl);

            // 規範 16: HTTP error 紀錄
            if (!futRes.ok) {
                const errorText = await futRes.text();
                console.warn("FinMind TX HTTP error:", futRes.status, errorText);
            } else {
                const futJson = await futRes.json();
                // 規範 17: Debug Log
                console.log("FinMind TX rows:", futJson.data?.length || 0);

                if (futJson.data && Array.isArray(futJson.data) && futJson.data.length > 0) {
                    // 規範 8: 過濾 futures_id === "TX" 且 contract_date 為 6 位數字 (排除價差合約如 202608/202609)
                    const validRows = futJson.data.filter(d => {
                        const isTx = (d.futures_id === "TX" || d.future_id === "TX" || !d.futures_id);
                        const isSingleMonth = /^\d{6}$/.test(String(d.contract_date || ''));
                        return isTx && isSingleMonth && getUsablePrice(d) !== null;
                    });

                    if (validRows.length > 0) {
                        // 規範 11: 找所有有效日期，去重並排序，取最新日期
                        const dates = [...new Set(
                            validRows
                                .map(row => String(row.date).slice(0, 10))
                                .filter(Boolean)
                        )].sort();

                        const latestDate = dates[dates.length - 1];
                        console.log("FinMind TX latest date:", latestDate);

                        // 規範 12: 找最新日期的近月主力合約
                        const latestDayRows = validRows
                            .filter(row => String(row.date).slice(0, 10) === latestDate)
                            .sort((a, b) => String(a.contract_date).localeCompare(String(b.contract_date)));

                        const frontMonth = latestDayRows[0].contract_date;
                        console.log("FinMind TX front month:", frontMonth);

                        // 規範 13: 找今日與前一交易日紀錄
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

                        // 規範 10: 優先選取 position 盤別
                        const todayRow = selectBestSessionRow(todayRows);
                        const previousRow = selectBestSessionRow(previousRows);

                        console.log("FinMind TX today row:", todayRow);
                        console.log("FinMind TX previous row:", previousRow);

                        if (todayRow) {
                            const price = getUsablePrice(todayRow);
                            const prevPrice = previousRow ? getUsablePrice(previousRow) : price;

                            if (Number.isFinite(price) && price > 0) {
                                let change = null;
                                let pct = null;

                                if (Number.isFinite(prevPrice) && prevPrice > 0) {
                                    change = price - prevPrice;
                                    pct = (change / prevPrice) * 100;
                                }

                                // 規範 14: 建立 FinMind TX 結果
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

    // 規範 20: 保留原本 API 回傳格式
    return new Response(
        JSON.stringify({
            success: true,
            source: txFromTwse ? "TWSE MIS" : (results["TX"].source || "FinMind"),
            data: results
        }),
        {
            status: 200,
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": "no-store, no-cache, must-revalidate",
                ...corsHeaders
            }
        }
    );
}

// 規範 9: 取得可用價格輔助函數 (優先 close，其次 settlement_price)
function getUsablePrice(row) {
    if (!row) return null;
    const close = Number(row.close);
    if (Number.isFinite(close) && close > 0) return close;

    const settlement = Number(row.settlement_price);
    if (Number.isFinite(settlement) && settlement > 0) return settlement;

    return null;
}

// 規範 10: 優先選取 position 盤別 (日盤/一般盤)
function selectBestSessionRow(rows) {
    const usableRows = rows.filter(row => getUsablePrice(row) !== null);
    if (usableRows.length === 0) return null;

    const positionRow = usableRows.find(row => row.trading_session === "position");
    if (positionRow) return positionRow;

    const afterMarketRow = usableRows.find(row => row.trading_session === "after_market");
    return afterMarketRow || usableRows[0];
}
