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
import { getPairStatsTemplate } from "../../templates/pairStats";
import { API_ENDPOINTS, SOLANA_API_BASE_URL } from "../../utils/constants";
import { PairStatsContent, PairStats } from "../../types/solana";

export default {
    name: "GET_SOLANA_PAIR_STATS",
    similes: [
        "FETCH_SOLANA_PAIR_STATS",
        "SHOW_SOLANA_PAIR_DETAILS",
        "GET_SOLANA_PAIR_INFO",
        "CHECK_SOLANA_PAIR_STATS",
    ],
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        await validateMoralisConfig(runtime);
        return true;
    },
    description:
        "Get detailed statistics for a specific trading pair on Solana blockchain",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting Moralis GET_SOLANA_PAIR_STATS handler...");
        // Initialize or update state
        let currentState: State;
        if (!state) {
            currentState = (await runtime.composeState(message)) as State;
        } else {
            currentState = await runtime.updateRecentMessageState(state);
        }

        try {
            elizaLogger.log("Composing pair stats context...");
            const statsContext = composeContext({
                state: currentState,
                template: getPairStatsTemplate,
            });

            elizaLogger.log("Extracting pair address...");
            const content = (await generateObjectDeprecated({
                runtime,
                context: statsContext,
                modelClass: ModelClass.LARGE,
            })) as unknown as PairStatsContent;

            if (!content || typeof content !== "object") {
                throw new Error("Invalid response format from model");
            }

            if (!content.pairAddress) {
                throw new Error("No Solana pair address provided");
            }

            const config = await validateMoralisConfig(runtime);
            elizaLogger.log(
                `Fetching stats for Solana pair ${content.pairAddress}...`
            );

            const response = await axios.get<PairStats>(
                `${SOLANA_API_BASE_URL}${API_ENDPOINTS.SOLANA.PAIR_STATS(content.pairAddress)}`,
                {
                    headers: {
                        "X-API-Key": config.MORALIS_API_KEY,
                        accept: "application/json",
                    },
                }
            );

            const stats = response.data;
            elizaLogger.success(
                `Successfully fetched stats for pair ${content.pairAddress}`
            );

            if (callback) {
                const formattedStats =
                    `Pair: ${stats.pairLabel} (${stats.pairAddress})\n` +
                    `Exchange: ${stats.exchange}\n` +
                    `Current Price: $${Number(stats.currentUsdPrice).toFixed(4)}\n` +
                    `Total Liquidity: $${Number(stats.totalLiquidityUsd).toLocaleString()}\n\n` +
                    `Price Change:\n` +
                    `- 5min: ${stats.pricePercentChange["5min"].toFixed(2)}%\n` +
                    `- 1h: ${stats.pricePercentChange["1h"].toFixed(2)}%\n` +
                    `- 4h: ${stats.pricePercentChange["4h"].toFixed(2)}%\n` +
                    `- 24h: ${stats.pricePercentChange["24h"].toFixed(2)}%\n\n` +
                    `Volume (24h):\n` +
                    `- Total: $${Number(stats.totalVolume["24h"]).toLocaleString()}\n` +
                    `- Buy: $${Number(stats.buyVolume["24h"]).toLocaleString()}\n` +
                    `- Sell: $${Number(stats.sellVolume["24h"]).toLocaleString()}\n\n` +
                    `Transactions (24h):\n` +
                    `- Buys: ${stats.buys["24h"].toLocaleString()}\n` +
                    `- Sells: ${stats.sells["24h"].toLocaleString()}\n` +
                    `- Unique Buyers: ${stats.buyers["24h"].toLocaleString()}\n` +
                    `- Unique Sellers: ${stats.sellers["24h"].toLocaleString()}`;

                callback({
                    text: `Here are the detailed stats for the Solana trading pair:\n\n${formattedStats}`,
                    content: stats,
                });
            }

            return true;
        } catch (error: unknown) {
            elizaLogger.error("Error in GET_SOLANA_PAIR_STATS handler:", error);
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            if (callback) {
                callback({
                    text: `Error fetching Solana pair stats: ${errorMessage}`,
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
                    text: "Get stats for Solana pair A8nPhpCJqtqHdqUk35Uj9Hy2YsGXFkCZGuNwvkD3k7VC",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll fetch the statistics for this Solana trading pair.",
                    action: "GET_SOLANA_PAIR_STATS",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show me details of Solana pair 83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6d",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll retrieve the detailed stats for this Solana trading pair.",
                    action: "GET_SOLANA_PAIR_STATS",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
