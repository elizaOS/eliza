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
import { getPriceByAddressTemplate } from "../templates/priceAddress";

// Schema definition for the token price request
export const GetTokenPriceSchema = z.object({
    chainId: z.string(),
    tokenAddress: z.string(),
});

export type GetTokenPriceContent = z.infer<typeof GetTokenPriceSchema> &
    Content;

export const isGetTokenPriceContent = (
    obj: any
): obj is GetTokenPriceContent => {
    return GetTokenPriceSchema.safeParse(obj).success;
};

interface TokenResponse {
    id: string;
    symbol: string;
    name: string;
    market_data: {
        current_price: {
            usd: number;
        };
        market_cap: {
            usd: number;
        };
    };
}

export default {
    name: "GET_TOKEN_PRICE_BY_ADDRESS",
    similes: [
        "FETCH_TOKEN_PRICE_BY_ADDRESS",
        "CHECK_TOKEN_PRICE_BY_ADDRESS",
        "LOOKUP_TOKEN_BY_ADDRESS",
    ],
    // eslint-disable-next-line
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        await validateCoingeckoConfig(runtime);
        return true;
    },
    description:
        "Get the current USD price for a token using its blockchain address",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting GET_TOKEN_PRICE_BY_ADDRESS handler...");

        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        try {
            elizaLogger.log("Composing token price context...");
            const context = composeContext({
                state,
                template: getPriceByAddressTemplate,
            });

            elizaLogger.log("Generating content from template...");
            const result = await generateObject({
                runtime,
                context,
                modelClass: ModelClass.SMALL,
                schema: GetTokenPriceSchema,
            });

            if (!isGetTokenPriceContent(result.object)) {
                elizaLogger.error("Invalid token price request format");
                return false;
            }

            const content = result.object;
            elizaLogger.log("Generated content:", content);

            // Get API configuration
            const config = await validateCoingeckoConfig(runtime);
            const { baseUrl, apiKey, headerKey } = getApiConfig(config);

            // Fetch token data
            elizaLogger.log("Fetching token data...");
            const response = await axios.get<TokenResponse>(
                `${baseUrl}/coins/${content.chainId}/contract/${content.tokenAddress}`,
                {
                    headers: {
                        accept: "application/json",
                        [headerKey]: apiKey,
                    },
                }
            );

            const tokenData = response.data;
            if (!tokenData.market_data?.current_price?.usd) {
                throw new Error(
                    `No price data available for token ${content.tokenAddress} on ${content.chainId}`
                );
            }

            // Format response
            const parts = [
                `${tokenData.name} (${tokenData.symbol.toUpperCase()})`,
                `Address: ${content.tokenAddress}`,
                `Chain: ${content.chainId}`,
                `Price: $${tokenData.market_data.current_price.usd.toFixed(6)} USD`,
            ];

            if (tokenData.market_data.market_cap?.usd) {
                parts.push(
                    `Market Cap: $${tokenData.market_data.market_cap.usd.toLocaleString()} USD`
                );
            }

            const responseText = parts.join("\n");
            elizaLogger.success("Token price data retrieved successfully!");

            if (callback) {
                callback({
                    text: responseText,
                    content: {
                        token: {
                            name: tokenData.name,
                            symbol: tokenData.symbol,
                            address: content.tokenAddress,
                            chain: content.chainId,
                            price: tokenData.market_data.current_price.usd,
                            marketCap: tokenData.market_data.market_cap?.usd,
                        },
                    },
                });
            }

            return true;
        } catch (error) {
            elizaLogger.error(
                "Error in GET_TOKEN_PRICE_BY_ADDRESS handler:",
                error
            );

            let errorMessage;
            if (error.response?.status === 429) {
                errorMessage = "Rate limit exceeded. Please try again later.";
            } else if (error.response?.status === 403) {
                errorMessage =
                    "This endpoint requires a CoinGecko Pro API key. Please upgrade your plan to access this data.";
            } else if (error.response?.status === 400) {
                errorMessage =
                    "Invalid request parameters. Please check your input.";
            } else {
                errorMessage =
                    "Failed to fetch token price. Please try again later.";
            }

            if (callback) {
                callback({
                    text: errorMessage,
                    content: {
                        error: error.message,
                        statusCode: error.response?.status,
                        requiresProPlan: error.response?.status === 403,
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
                    text: "What's the price of the USDC token on Ethereum? The address is 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll check the USDC token price for you.",
                    action: "GET_TOKEN_PRICE_BY_ADDRESS",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "USD Coin (USDC)\nAddress: 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48\nChain: ethereum\nPrice: {{dynamic}} USD\nMarket Cap: ${{dynamic}} USD",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
