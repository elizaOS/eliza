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
import { getCategoriesData } from '../providers/categoriesProvider';
import { getMarketsTemplate } from "../templates/markets";

interface CategoryItem {
    category_id: string;
    name: string;
}

export function formatCategory(category: string | undefined, categories: CategoryItem[]): string | undefined {
    if (!category) return undefined;

    const normalizedInput = category.toLowerCase().trim();

    // First try to find exact match by category_id
    const exactMatch = categories.find(c => c.category_id === normalizedInput);
    if (exactMatch) {
        return exactMatch.category_id;
    }

    // Then try to find match by name
    const nameMatch = categories.find(c =>
        c.name.toLowerCase() === normalizedInput ||
        c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') === normalizedInput
    );
    if (nameMatch) {
        return nameMatch.category_id;
    }

    // Try to find partial matches
    const partialMatch = categories.find(c =>
        c.name.toLowerCase().includes(normalizedInput) ||
        c.category_id.includes(normalizedInput)
    );
    if (partialMatch) {
        return partialMatch.category_id;
    }

    return undefined;
}

/**
 * Interface for CoinGecko /coins/markets endpoint response
 * @see https://docs.coingecko.com/reference/coins-markets
 */
export interface CoinMarketData {
    id: string;
    symbol: string;
    name: string;
    image: string;
    current_price: number;
    market_cap: number;
    market_cap_rank: number;
    fully_diluted_valuation: number;
    total_volume: number;
    high_24h: number;
    low_24h: number;
    price_change_24h: number;
    price_change_percentage_24h: number;
    market_cap_change_24h: number;
    market_cap_change_percentage_24h: number;
    circulating_supply: number;
    total_supply: number;
    max_supply: number;
    ath: number;
    ath_change_percentage: number;
    ath_date: string;
    atl: number;
    atl_change_percentage: number;
    atl_date: string;
    last_updated: string;
}

export const GetMarketsSchema = z.object({
    vs_currency: z.string().default('usd'),
    category: z.string().optional(),
    order: z.enum(['market_cap_desc', 'market_cap_asc', 'volume_desc', 'volume_asc']).default('market_cap_desc'),
    per_page: z.number().min(1).max(250).default(20),
    page: z.number().min(1).default(1),
    sparkline: z.boolean().default(false)
});

export type GetMarketsContent = z.infer<typeof GetMarketsSchema> & Content;

export const isGetMarketsContent = (obj: any): obj is GetMarketsContent => {
    return GetMarketsSchema.safeParse(obj).success;
};

export default {
    name: "GET_MARKETS",
    similes: [
        "MARKET_OVERVIEW",
        "TOP_RANKINGS",
        "MARKET_LEADERBOARD",
        "CRYPTO_RANKINGS",
        "BEST_PERFORMING_COINS",
        "TOP_MARKET_CAPS"
    ],
    // eslint-disable-next-line
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        await validateCoingeckoConfig(runtime);
        return true;
    },
    // Comprehensive endpoint for market rankings, supports up to 250 coins per request
    description: "Get ranked list of top cryptocurrencies sorted by market metrics (without specifying coins)",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting CoinGecko GET_MARKETS handler...");

        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        try {
            const config = await validateCoingeckoConfig(runtime);
            const { baseUrl, apiKey, headerKey } = getApiConfig(config);

            // Get categories through the provider
            const categories = await getCategoriesData(runtime);

            // Compose markets context with categories
            const marketsContext = composeContext({
                state,
                template: getMarketsTemplate.replace('{{categories}}',
                    categories.map(c => `- ${c.name} (ID: ${c.category_id})`).join('\n')
                ),
            });

            const result = await generateObject({
                runtime,
                context: marketsContext,
                modelClass: ModelClass.SMALL,
                schema: GetMarketsSchema
            });

            if (!isGetMarketsContent(result.object)) {
                elizaLogger.error("Invalid market data format received");
                return false;
            }

            const content = result.object;
            elizaLogger.log("Content from template:", content);

            // If template returns null, this is not a markets request
            if (!content) {
                return false;
            }

            const formattedCategory = formatCategory(content.category, categories);
            if (content.category && !formattedCategory) {
                throw new Error(`Invalid category: ${content.category}. Please choose from the available categories.`);
            }

            elizaLogger.log("Making API request with params:", {
                url: `${baseUrl}/coins/markets`,
                category: formattedCategory,
                vs_currency: content.vs_currency,
                order: content.order,
                per_page: content.per_page,
                page: content.page
            });

            const response = await axios.get<CoinMarketData[]>(
                `${baseUrl}/coins/markets`,
                {
                    headers: {
                        'accept': 'application/json',
                        [headerKey]: apiKey
                    },
                    params: {
                        vs_currency: content.vs_currency,
                        category: formattedCategory,
                        order: content.order,
                        per_page: content.per_page,
                        page: content.page,
                        sparkline: content.sparkline
                    }
                }
            );

            if (!response.data?.length) {
                throw new Error("No market data received from CoinGecko API");
            }

            const formattedData = response.data.map(coin => ({
                name: coin.name,
                symbol: coin.symbol.toUpperCase(),
                marketCapRank: coin.market_cap_rank,
                currentPrice: coin.current_price,
                priceChange24h: coin.price_change_24h,
                priceChangePercentage24h: coin.price_change_percentage_24h,
                marketCap: coin.market_cap,
                volume24h: coin.total_volume,
                high24h: coin.high_24h,
                low24h: coin.low_24h,
                circulatingSupply: coin.circulating_supply,
                totalSupply: coin.total_supply,
                maxSupply: coin.max_supply,
                lastUpdated: coin.last_updated
            }));

            const categoryDisplay = content.category ?
                `${categories.find(c => c.category_id === formattedCategory)?.name.toUpperCase() || content.category.toUpperCase()} ` : '';

            const responseText = [
                `Top ${formattedData.length} ${categoryDisplay}Cryptocurrencies by ${content.order === 'volume_desc' || content.order === 'volume_asc' ? 'Volume' : 'Market Cap'}:`,
                ...formattedData.map((coin, index) =>
                    `${index + 1}. ${coin.name} (${coin.symbol})` +
                    ` | $${coin.currentPrice.toLocaleString()}` +
                    ` | ${coin.priceChangePercentage24h.toFixed(2)}%` +
                    ` | MCap: $${(coin.marketCap / 1e9).toFixed(2)}B`
                )
            ].join('\n');

            elizaLogger.success("Market data retrieved successfully!");

            if (callback) {
                callback({
                    text: responseText,
                    content: {
                        markets: formattedData,
                        params: {
                            vs_currency: content.vs_currency,
                            category: content.category,
                            order: content.order,
                            per_page: content.per_page,
                            page: content.page
                        },
                        timestamp: new Date().toISOString()
                    }
                });
            }

            return true;
        } catch (error) {
            elizaLogger.error("Error in GET_MARKETS handler:", error);

            let errorMessage;
            if (error.response?.status === 429) {
                errorMessage = "Rate limit exceeded. Please try again later.";
            } else if (error.response?.status === 403) {
                errorMessage = "This endpoint requires a CoinGecko Pro API key. Please upgrade your plan to access this data.";
            } else if (error.response?.status === 400) {
                errorMessage = "Invalid request parameters. Please check your input.";
            } else {
                errorMessage = `Error fetching market data: ${error.message}`;
            }

            if (callback) {
                callback({
                    text: errorMessage,
                    error: {
                        message: error.message,
                        statusCode: error.response?.status,
                        params: error.config?.params,
                        requiresProPlan: error.response?.status === 403
                    }
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
                    text: "Show me the top cryptocurrencies by market cap",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll fetch the current market data for top cryptocurrencies.",
                    action: "GET_MARKETS",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Here are the top cryptocurrencies:\n1. Bitcoin (BTC) | $45,000 | +2.5% | MCap: $870.5B\n{{dynamic}}",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
