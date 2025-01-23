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
    type Action
} from "@elizaos/core";
import axios from "axios";
import { z } from "zod";
import { getApiConfig, validateCoingeckoConfig } from "../environment";
import { getTrendingTemplate } from "../templates/trending";

interface TrendingCoinItem {
    id: string;
    name: string;
    api_symbol: string;
    symbol: string;
    market_cap_rank: number;
    thumb: string;
    large: string;
}

interface TrendingExchange {
    id: string;
    name: string;
    market_type: string;
    thumb: string;
    large: string;
}

interface TrendingCategory {
    id: string;
    name: string;
}

interface TrendingNFT {
    id: string;
    name: string;
    symbol: string;
    thumb: string;
}

interface TrendingResponse {
    coins: Array<{ item: TrendingCoinItem }>;
    exchanges: TrendingExchange[];
    categories: TrendingCategory[];
    nfts: TrendingNFT[];
    icos: string[];
}

export const GetTrendingSchema = z.object({
    include_nfts: z.boolean().default(true),
    include_categories: z.boolean().default(true)
});

export type GetTrendingContent = z.infer<typeof GetTrendingSchema> & Content;

export const isGetTrendingContent = (obj: any): obj is GetTrendingContent => {
    return GetTrendingSchema.safeParse(obj).success;
};

export default {
    name: "GET_TRENDING",
    similes: [
        "TRENDING_COINS",
        "TRENDING_CRYPTO",
        "HOT_COINS",
        "POPULAR_COINS",
        "TRENDING_SEARCH",
    ],
    // eslint-disable-next-line
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        await validateCoingeckoConfig(runtime);
        return true;
    },
    description: "Get list of trending cryptocurrencies, NFTs, and categories from CoinGecko",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting CoinGecko GET_TRENDING handler...");

        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        try {
            // Compose trending context
            elizaLogger.log("Composing trending context...");
            const trendingContext = composeContext({
                state,
                template: getTrendingTemplate,
            });

            const result = await generateObject({
                runtime,
                context: trendingContext,
                modelClass: ModelClass.LARGE,
                schema: GetTrendingSchema
            });

            if (!isGetTrendingContent(result.object)) {
                elizaLogger.error("Invalid trending request format");
                return false;
            }

            // Fetch trending data from CoinGecko
            const config = await validateCoingeckoConfig(runtime);
            const { baseUrl, apiKey, headerKey } = getApiConfig(config);

            elizaLogger.log("Fetching trending data...");

            const response = await axios.get<TrendingResponse>(
                `${baseUrl}/search/trending`,
                {
                    headers: {
                        [headerKey]: apiKey
                    }
                }
            );

            if (!response.data) {
                throw new Error("No data received from CoinGecko API");
            }

            const formattedData = {
                coins: response.data.coins.map(({ item }) => ({
                    name: item.name,
                    symbol: item.symbol.toUpperCase(),
                    marketCapRank: item.market_cap_rank,
                    id: item.id,
                    thumbnail: item.thumb,
                    largeImage: item.large
                })),
                nfts: response.data.nfts.map(nft => ({
                    name: nft.name,
                    symbol: nft.symbol,
                    id: nft.id,
                    thumbnail: nft.thumb
                })),
                categories: response.data.categories.map(category => ({
                    name: category.name,
                    id: category.id
                }))
            };

            const responseText = [
                'Trending Coins:',
                ...formattedData.coins.map((coin, index) =>
                    `${index + 1}. ${coin.name} (${coin.symbol})${coin.marketCapRank ? ` - Rank #${coin.marketCapRank}` : ''}`
                ),
                '',
                'Trending NFTs:',
                ...(formattedData.nfts.length ?
                    formattedData.nfts.map((nft, index) => `${index + 1}. ${nft.name} (${nft.symbol})`) :
                    ['No trending NFTs available']),
                '',
                'Trending Categories:',
                ...(formattedData.categories.length ?
                    formattedData.categories.map((category, index) => `${index + 1}. ${category.name}`) :
                    ['No trending categories available'])
            ].join('\n');

            elizaLogger.success("Trending data retrieved successfully!");

            if (callback) {
                callback({
                    text: responseText,
                    content: {
                        trending: formattedData,
                        timestamp: new Date().toISOString()
                    }
                });
            }

            return true;
        } catch (error) {
            elizaLogger.error("Error in GET_TRENDING handler:", error);

            // Enhanced error handling
            const errorMessage = error.response?.status === 429 ?
                "Rate limit exceeded. Please try again later." :
                `Error fetching trending data: ${error.message}`;

            if (callback) {
                callback({
                    text: errorMessage,
                    content: {
                        error: error.message,
                        statusCode: error.response?.status
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
                    text: "What are the trending cryptocurrencies?",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll check the trending cryptocurrencies for you.",
                    action: "GET_TRENDING",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Here are the trending cryptocurrencies:\n1. Bitcoin (BTC) - Rank #1\n2. Ethereum (ETH) - Rank #2\n{{dynamic}}",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show me what's hot in crypto right now",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll fetch the current trending cryptocurrencies.",
                    action: "GET_TRENDING",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Here are the trending cryptocurrencies:\n{{dynamic}}",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;