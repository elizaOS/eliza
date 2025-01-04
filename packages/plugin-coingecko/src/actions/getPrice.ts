import {
    ActionExample,
    composeContext,
    Content,
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
import { validateCoingeckoConfig } from "../environment";
import { getPriceTemplate } from "../templates/price";
import { normalizeCoinId } from "../utils/coin";

export interface GetPriceContent extends Content {
    coinId: string;
    currency: string;
}

export default {
    name: "GET_PRICE",
    similes: [
        "CHECK_PRICE",
        "PRICE_CHECK",
        "GET_CRYPTO_PRICE",
        "CHECK_CRYPTO_PRICE",
    ],
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        await validateCoingeckoConfig(runtime);
        return true;
    },
    description: "Get the current price of a cryptocurrency from CoinGecko",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting CoinGecko GET_PRICE handler...");

        // Initialize or update state
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        try {
            // Compose price check context
            elizaLogger.log("Composing price context...");
            const priceContext = composeContext({
                state,
                template: getPriceTemplate,
            });

            elizaLogger.log("Composing content...");
            const content = (await generateObjectDeprecated({
                runtime,
                context: priceContext,
                modelClass: ModelClass.LARGE,
            })) as unknown as GetPriceContent;

            // Validate content structure first
            if (!content || typeof content !== "object") {
                throw new Error("Invalid response format from model");
            }

            // Get and validate coin ID
            const coinId = content.coinId
                ? normalizeCoinId(content.coinId)
                : null;
            if (!coinId) {
                throw new Error(
                    `Unsupported or invalid cryptocurrency: ${content.coinId}`
                );
            }

            // Normalize currency
            const currency = (content.currency || "usd").toLowerCase();

            // Fetch price from CoinGecko
            const config = await validateCoingeckoConfig(runtime);
            elizaLogger.log(`Fetching price for ${coinId} in ${currency}...`);

            const response = await axios.get(
                `https://api.coingecko.com/api/v3/simple/price`,
                {
                    params: {
                        ids: coinId,
                        vs_currencies: currency,
                        x_cg_demo_api_key: config.COINGECKO_API_KEY,
                    },
                }
            );

            if (!response.data[coinId]?.[currency]) {
                throw new Error(
                    `No price data available for ${coinId} in ${currency}`
                );
            }

            const price = response.data[coinId][currency];
            elizaLogger.success(
                `Price retrieved successfully! ${coinId}: ${price} ${currency.toUpperCase()}`
            );

            if (callback) {
                callback({
                    text: `The current price of ${coinId} is ${price} ${currency.toUpperCase()}`,
                    content: { price, currency },
                });
            }

            return true;
        } catch (error) {
            elizaLogger.error("Error in GET_PRICE handler:", error);
            if (callback) {
                callback({
                    text: `Error fetching price: ${error.message}`,
                    content: { error: error.message },
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
                    text: "What's the current price of Bitcoin?",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll check the current Bitcoin price for you.",
                    action: "GET_PRICE",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "The current price of bitcoin is {{dynamic}} USD",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Check ETH price in EUR",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll check the current Ethereum price in EUR for you.",
                    action: "GET_PRICE",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "The current price of ethereum is {{dynamic}} EUR",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
