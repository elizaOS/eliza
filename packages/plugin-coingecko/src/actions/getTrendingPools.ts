import {
    type ActionExample,
    composeContext,
    type Content,
    elizaLogger,
    generateObject,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State,
    type Action,
} from "@elizaos/core";
import axios from "axios";
import { z } from "zod";
import { getApiConfig, validateCoingeckoConfig } from "../environment";
import { getTrendingPoolsTemplate } from "../templates/trendingPools";

interface TrendingPool {
    id: string;
    type: string;
    attributes: {
        name: string;
        market_cap_usd: string;
        fdv_usd: string;
        reserve_in_usd: string;
        pool_created_at: string;
    };
}

interface TrendingPoolsResponse {
    data: TrendingPool[];
}

export const GetTrendingPoolsSchema = z.object({
    limit: z.number().min(1).max(100).default(10),
});

export type GetTrendingPoolsContent = z.infer<typeof GetTrendingPoolsSchema> &
    Content;

export const isGetTrendingPoolsContent = (
    obj: any,
): obj is GetTrendingPoolsContent => {
    return GetTrendingPoolsSchema.safeParse(obj).success;
};

export default {
    name: "GET_TRENDING_POOLS",
    similes: ["TRENDING_POOLS", "HOT_POOLS", "POPULAR_POOLS", "TOP_POOLS"],
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        await validateCoingeckoConfig(runtime);
        return true;
    },
    description: "Get list of trending pools from CoinGecko's onchain data",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback,
    ): Promise<boolean> => {
        elizaLogger.log("Starting CoinGecko GET_TRENDING_POOLS handler...");

        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        try {
            elizaLogger.log("Composing trending pools context...");
            const trendingContext = composeContext({
                state,
                template: getTrendingPoolsTemplate,
            });

            const result = await generateObject({
                runtime,
                context: trendingContext,
                modelClass: ModelClass.LARGE,
                schema: GetTrendingPoolsSchema,
            });

            if (!isGetTrendingPoolsContent(result.object)) {
                elizaLogger.error("Invalid trending pools request format");
                return false;
            }

            // Fetch trending pools data from CoinGecko
            const config = await validateCoingeckoConfig(runtime);
            const { baseUrl, apiKey, headerKey } = getApiConfig(config);

            elizaLogger.log("Fetching trending pools data...");

            const response = await axios.get<TrendingPoolsResponse>(
                `${baseUrl}/onchain/networks/trending_pools?include=base_token,dex`,
                {
                    headers: {
                        [headerKey]: apiKey,
                    },
                },
            );

            if (!response.data) {
                throw new Error("No data received from CoinGecko API");
            }

            const formattedData = response.data.data.map((pool) => ({
                name: pool.attributes.name,
                marketCap: Number(
                    pool.attributes.market_cap_usd,
                ).toLocaleString("en-US", {
                    style: "currency",
                    currency: "USD",
                }),
                fdv: Number(pool.attributes.fdv_usd).toLocaleString("en-US", {
                    style: "currency",
                    currency: "USD",
                }),
                reserveUSD: Number(
                    pool.attributes.reserve_in_usd,
                ).toLocaleString("en-US", {
                    style: "currency",
                    currency: "USD",
                }),
                createdAt: new Date(
                    pool.attributes.pool_created_at,
                ).toLocaleDateString(),
            }));

            const responseText = [
                "Trending Pools Overview:",
                "",
                ...formattedData.map((pool, index) =>
                    [
                        `${index + 1}. ${pool.name}`,
                        `   Market Cap: ${pool.marketCap}`,
                        `   FDV: ${pool.fdv}`,
                        `   Reserve: ${pool.reserveUSD}`,
                        `   Created: ${pool.createdAt}`,
                        "",
                    ].join("\n"),
                ),
            ].join("\n");

            elizaLogger.success("Trending pools data retrieved successfully!");

            if (callback) {
                callback({
                    text: responseText,
                    content: {
                        trendingPools: formattedData,
                        timestamp: new Date().toISOString(),
                    },
                });
            }

            return true;
        } catch (error) {
            elizaLogger.error("Error in GET_TRENDING_POOLS handler:", error);

            const errorMessage =
                error.response?.status === 429
                    ? "Rate limit exceeded. Please try again later."
                    : `Error fetching trending pools data: ${error.message}`;

            if (callback) {
                callback({
                    text: errorMessage,
                    content: {
                        error: error.message,
                        statusCode: error.response?.status,
                    },
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
                    text: "Show me trending liquidity pools",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll check the trending liquidity pools for you.",
                    action: "GET_TRENDING_POOLS",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Here are the trending liquidity pools:\n1. MELANIA / USDC\n   Market Cap: $954,636,707\n   FDV: $6,402,478,508\n   Reserve: $363,641,037\n   Created: 1/19/2025\n2. TRUMP / USDC\n   Market Cap: $8,844,297,825\n   FDV: $43,874,068,484\n   Reserve: $718,413,745\n   Created: 1/17/2025",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "What are the top hottest dex pools?",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll fetch the top hottest DEX pools for you.",
                    action: "GET_TRENDING_POOLS",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Here are the top 5 hottest DEX pools:\n1. TRUMP / USDC\n   Market Cap: $8,844,297,825\n   FDV: $43,874,068,484\n   Reserve: $718,413,745\n   Created: 1/17/2025\n2. MELANIA / USDC\n   Market Cap: $954,636,707\n   FDV: $6,402,478,508\n   Reserve: $363,641,037\n   Created: 1/19/2025",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "List all trading pools with highest volume",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll get all the trending trading pools for you.",
                    action: "GET_TRENDING_POOLS",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Here are all trending trading pools:\n1. MELANIA / USDC\n   Market Cap: $954,636,707\n   FDV: $6,402,478,508\n   Reserve: $363,641,037\n   Created: 1/19/2025\n2. TRUMP / USDC\n   Market Cap: $8,844,297,825\n   FDV: $43,874,068,484\n   Reserve: $718,413,745\n   Created: 1/17/2025",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
