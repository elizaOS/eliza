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
import { getTopGainersLosersTemplate } from "../templates/gainersLosers";

interface TopGainerLoserItem {
    id: string;
    symbol: string;
    name: string;
    image: string;
    market_cap_rank: number;
    usd: number;
    usd_24h_vol: number;
    usd_1h_change?: number;
    usd_24h_change?: number;
    usd_7d_change?: number;
    usd_14d_change?: number;
    usd_30d_change?: number;
    usd_60d_change?: number;
    usd_1y_change?: number;
}

interface TopGainersLosersResponse {
    top_gainers: TopGainerLoserItem[];
    top_losers: TopGainerLoserItem[];
}

const DurationEnum = z.enum(["1h", "24h", "7d", "14d", "30d", "60d", "1y"]);
//type Duration = z.infer<typeof DurationEnum>;

export const GetTopGainersLosersSchema = z.object({
    vs_currency: z.string().default("usd"),
    duration: DurationEnum.default("24h"),
    top_coins: z.string().default("1000")
});

export type GetTopGainersLosersContent = z.infer<typeof GetTopGainersLosersSchema> & Content;

export const isGetTopGainersLosersContent = (obj: any): obj is GetTopGainersLosersContent => {
    return GetTopGainersLosersSchema.safeParse(obj).success;
};

export default {
    name: "GET_TOP_GAINERS_LOSERS",
    similes: [
        "TOP_MOVERS",
        "BIGGEST_GAINERS",
        "BIGGEST_LOSERS",
        "PRICE_CHANGES",
        "BEST_WORST_PERFORMERS",
    ],
    // eslint-disable-next-line
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        await validateCoingeckoConfig(runtime);
        return true;
    },
    description: "Get list of top gaining and losing cryptocurrencies by price change",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting CoinGecko GET_TOP_GAINERS_LOSERS handler...");

        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        try {
            elizaLogger.log("Composing gainers/losers context...");
            const context = composeContext({
                state,
                template: getTopGainersLosersTemplate,
            });

            elizaLogger.log("Generating content from template...");
            const result = await generateObject({
                runtime,
                context,
                modelClass: ModelClass.LARGE,
                schema: GetTopGainersLosersSchema
            });

            if (!isGetTopGainersLosersContent(result.object)) {
                elizaLogger.error("Invalid gainers/losers request format");
                return false;
            }

            const content = result.object;
            elizaLogger.log("Generated content:", content);

            // Fetch data from CoinGecko
            const config = await validateCoingeckoConfig(runtime);
            const { baseUrl, apiKey, headerKey } = getApiConfig(config);

            elizaLogger.log("Fetching top gainers/losers data...");
            elizaLogger.log("API request params:", {
                vs_currency: content.vs_currency,
                duration: content.duration,
                top_coins: content.top_coins
            });

            const response = await axios.get<TopGainersLosersResponse>(
                `${baseUrl}/coins/top_gainers_losers`,
                {
                    headers: {
                        'accept': 'application/json',
                        [headerKey]: apiKey
                    },
                    params: {
                        vs_currency: content.vs_currency,
                        duration: content.duration,
                        top_coins: content.top_coins
                    }
                }
            );

            if (!response.data) {
                throw new Error("No data received from CoinGecko API");
            }

            // Format the response text
            const responseText = [
                'Top Gainers:',
                ...response.data.top_gainers.map((coin, index) => {
                    const changeKey = `usd_${content.duration}_change` as keyof TopGainerLoserItem;
                    const change = coin[changeKey] as number;
                    return `${index + 1}. ${coin.name} (${coin.symbol.toUpperCase()})` +
                        ` | $${coin.usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 })}` +
                        ` | ${change >= 0 ? '+' : ''}${change.toFixed(2)}%` +
                        `${coin.market_cap_rank ? ` | Rank #${coin.market_cap_rank}` : ''}`;
                }),
                '',
                'Top Losers:',
                ...response.data.top_losers.map((coin, index) => {
                    const changeKey = `usd_${content.duration}_change` as keyof TopGainerLoserItem;
                    const change = coin[changeKey] as number;
                    return `${index + 1}. ${coin.name} (${coin.symbol.toUpperCase()})` +
                        ` | $${coin.usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 })}` +
                        ` | ${change >= 0 ? '+' : ''}${change.toFixed(2)}%` +
                        `${coin.market_cap_rank ? ` | Rank #${coin.market_cap_rank}` : ''}`;
                })
            ].join('\n');

            if (callback) {
                callback({
                    text: responseText,
                    content: {
                        data: response.data,
                        params: {
                            vs_currency: content.vs_currency,
                            duration: content.duration,
                            top_coins: content.top_coins
                        }
                    }
                });
            }

            return true;
        } catch (error) {
            elizaLogger.error("Error in GET_TOP_GAINERS_LOSERS handler:", error);

            let errorMessage;
            if (error.response?.status === 429) {
                errorMessage = "Rate limit exceeded. Please try again later.";
            } else if (error.response?.status === 403) {
                errorMessage = "This endpoint requires a CoinGecko Pro API key. Please upgrade your plan to access this data.";
            } else if (error.response?.status === 400) {
                errorMessage = "Invalid request parameters. Please check your input.";
            } else {
                errorMessage = `Error fetching top gainers/losers data: ${error.message}`;
            }

            if (callback) {
                callback({
                    text: errorMessage,
                    content: {
                        error: error.message,
                        statusCode: error.response?.status,
                        params: error.config?.params,
                        requiresProPlan: error.response?.status === 403
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
                    text: "What are the top gaining and losing cryptocurrencies?",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll check the top gainers and losers for you.",
                    action: "GET_TOP_GAINERS_LOSERS",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Here are the top gainers and losers:\nTop Gainers:\n1. Bitcoin (BTC) | $45,000 | +5.2% | Rank #1\n{{dynamic}}",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show me the best and worst performing crypto today",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll fetch the current top movers in the crypto market.",
                    action: "GET_TOP_GAINERS_LOSERS",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Here are today's best and worst performers:\n{{dynamic}}",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;