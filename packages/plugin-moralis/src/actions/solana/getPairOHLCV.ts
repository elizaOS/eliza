import {
    ActionExample,
    composeContext,
    elizaLogger,
    generateObjectDeprecated,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
    type Action,
} from "@elizaos/core";
import axios from "axios";
import { validateMoralisConfig } from "../../environment";
import { getPairOHLCVTemplate } from "../../templates/pairOHLCV";
import { API_ENDPOINTS, SOLANA_API_BASE_URL } from "../../utils/constants";
import { OHLCVParams, OHLCVResponse } from "../../types/solana";

export default {
    name: "GET_SOLANA_PAIR_OHLCV",
    similes: [
        "FETCH_SOLANA_PAIR_HISTORY",
        "GET_SOLANA_PRICE_HISTORY",
        "SHOW_SOLANA_PAIR_CANDLES",
        "CHECK_SOLANA_PRICE_CHART",
    ],
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        await validateMoralisConfig(runtime);
        return true;
    },
    description:
        "Get OHLCV (price history) data for a specific trading pair on Solana blockchain",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting Moralis GET_SOLANA_PAIR_OHLCV handler...");

        // Initialize or update state
        let currentState: State;
        if (!state) {
            currentState = (await runtime.composeState(message)) as State;
        } else {
            currentState = await runtime.updateRecentMessageState(state);
        }

        try {
            elizaLogger.log("Composing OHLCV request context...");
            const ohlcvContext = composeContext({
                state: currentState,
                template: getPairOHLCVTemplate,
            });

            elizaLogger.log("Extracting OHLCV parameters...");
            const content = (await generateObjectDeprecated({
                runtime,
                context: ohlcvContext,
                modelClass: ModelClass.LARGE,
            })) as unknown as OHLCVParams & {
                pairAddress: string;
                displayCandles?: number;
            };

            if (!content || typeof content !== "object") {
                throw new Error("Invalid response format from model");
            }

            if (!content.pairAddress) {
                throw new Error("No Solana pair address provided");
            }

            // Get current date if not provided
            const now = new Date();
            const defaultFromDate = new Date(
                now.getTime() - 7 * 24 * 60 * 60 * 1000
            )
                .toISOString()
                .split("T")[0];
            const defaultToDate = now.toISOString().split("T")[0];

            const params = {
                timeframe: content.timeframe || "1h",
                currency: content.currency || "usd",
                fromDate: content.fromDate || defaultFromDate,
                toDate: content.toDate || defaultToDate,
                limit: content.limit || 168, // Default to 1 week of hourly data
            };

            elizaLogger.log("Request params:", params);

            const config = await validateMoralisConfig(runtime);
            const url = `${SOLANA_API_BASE_URL}${API_ENDPOINTS.SOLANA.PAIR_OHLCV(content.pairAddress)}`;
            elizaLogger.log(`Making request to: ${url}`);

            const response = await axios.get<OHLCVResponse>(url, {
                params,
                headers: {
                    "X-API-Key": config.MORALIS_API_KEY,
                    accept: "application/json",
                },
            });

            elizaLogger.log("API Response:", response.data);

            if (!response.data.result || !Array.isArray(response.data.result)) {
                throw new Error("Invalid response format from API");
            }

            const candles = response.data.result;

            if (candles.length === 0) {
                if (callback) {
                    callback({
                        text: "No price history data available for this Solana trading pair in the specified time range.",
                        content: {
                            candles: [],
                            pairAddress: content.pairAddress,
                            timeframe: params.timeframe,
                            currency: params.currency,
                        },
                    });
                }
                return true;
            }

            elizaLogger.success(
                `Successfully fetched ${candles.length} OHLCV candles for pair ${content.pairAddress}`
            );

            if (callback) {
                const timeframe = params.timeframe;
                const currency = params.currency.toUpperCase();

                // Sort candles by timestamp in descending order
                const sortedCandles = [...candles].sort(
                    (a, b) =>
                        new Date(b.timestamp).getTime() -
                        new Date(a.timestamp).getTime()
                );

                let summaryText =
                    `Here's the ${timeframe} price history in ${currency} for the Solana trading pair ` +
                    `from ${params.fromDate} to ${params.toDate}:\n\n`;

                // Add price range summary
                const priceRange = {
                    min: Math.min(...candles.map((c) => c.low)),
                    max: Math.max(...candles.map((c) => c.high)),
                };
                summaryText += `Price Range: $${priceRange.min.toFixed(4)} - $${priceRange.max.toFixed(4)}\n`;

                // Calculate period returns
                const firstCandle = sortedCandles[sortedCandles.length - 1];
                const lastCandle = sortedCandles[0];
                const periodReturn =
                    ((lastCandle.close - firstCandle.open) / firstCandle.open) *
                    100;
                summaryText += `Period Return: ${periodReturn.toFixed(2)}%\n`;

                // Add volume summary
                const totalVolume = candles.reduce(
                    (sum, c) => sum + c.volume,
                    0
                );
                summaryText += `Total Volume: $${Math.round(totalVolume).toLocaleString()}\n`;

                // Add total trades
                const totalTrades = candles.reduce(
                    (sum, c) => sum + c.trades,
                    0
                );
                summaryText += `Total Trades: ${totalTrades.toLocaleString()}\n\n`;

                // Get display count (default 5, max 100)
                const displayCount = Math.min(content.displayCandles || 5, 100);
                summaryText += `Latest ${displayCount} candles:\n`;

                // Add latest candles
                for (const candle of sortedCandles.slice(0, displayCount)) {
                    const date = new Date(candle.timestamp).toLocaleString();
                    summaryText +=
                        `\nTime: ${date}\n` +
                        `Open: $${candle.open.toFixed(4)}, High: $${candle.high.toFixed(4)}, ` +
                        `Low: $${candle.low.toFixed(4)}, Close: $${candle.close.toFixed(4)}\n` +
                        `Volume: $${Math.round(candle.volume).toLocaleString()}, ` +
                        `Trades: ${candle.trades.toLocaleString()}`;
                }

                callback({
                    text: summaryText,
                    content: {
                        candles: sortedCandles,
                        pairAddress: content.pairAddress,
                        timeframe,
                        currency,
                        fromDate: params.fromDate,
                        toDate: params.toDate,
                        displayCount,
                    },
                });
            }

            return true;
        } catch (error: unknown) {
            elizaLogger.error("Error in GET_SOLANA_PAIR_OHLCV handler:", error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (callback) {
                callback({
                    text: `Error fetching Solana pair OHLCV data: ${errorMessage}`,
                    content: { error: errorMessage },
                });
            }
            return false;
        }
    },

    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show me last 15 candles for Solana pair A8nPhpCJqtqHdqUk35Uj9Hy2YsGXFkCZGuNwvkD3k7VC",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll retrieve the last 15 candlesticks for this Solana trading pair.",
                    action: "GET_SOLANA_PAIR_OHLCV",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Get hourly candlesticks for past 2 days for Solana pair A8nPhpCJqtqHdqUk35Uj9Hy2YsGXFkCZGuNwvkD3k7VC",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll fetch the hourly price history for this Solana trading pair.",
                    action: "GET_SOLANA_PAIR_OHLCV",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
