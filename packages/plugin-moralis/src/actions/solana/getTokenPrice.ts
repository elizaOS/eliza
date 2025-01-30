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
import { getTokenPriceTemplate } from "../../templates/tokenPrice";
import { API_ENDPOINTS, SOLANA_API_BASE_URL } from "../../utils/constants";
import { TokenPriceContent, TokenPrice } from "../../types/solana";

export default {
    name: "GET_SOLANA_TOKEN_PRICE",
    similes: [
        "FETCH_SOLANA_TOKEN_PRICE",
        "CHECK_SOLANA_TOKEN_PRICE",
        "SHOW_SOLANA_TOKEN_PRICE",
    ],
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        await validateMoralisConfig(runtime);
        return true;
    },
    description: "Get current price of a token on Solana blockchain",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting Moralis GET_SOLANA_TOKEN_PRICE handler...");

        // Initialize or update state
        let currentState: State;
        if (!state) {
            currentState = (await runtime.composeState(message)) as State;
        } else {
            currentState = await runtime.updateRecentMessageState(state);
        }

        try {
            elizaLogger.log("Composing token price context...");
            const priceContext = composeContext({
                state: currentState,
                template: getTokenPriceTemplate,
            });

            elizaLogger.log("Extracting token address...");
            const content = (await generateObjectDeprecated({
                runtime,
                context: priceContext,
                modelClass: ModelClass.LARGE,
            })) as unknown as TokenPriceContent;

            if (!content || typeof content !== "object") {
                throw new Error("Invalid response format from model");
            }

            if (!content.tokenAddress) {
                throw new Error("No Solana token address provided");
            }

            const config = await validateMoralisConfig(runtime);
            elizaLogger.log(
                `Fetching price for Solana token ${content.tokenAddress}...`
            );

            const response = await axios.get<TokenPrice>(
                `${SOLANA_API_BASE_URL}${API_ENDPOINTS.SOLANA.TOKEN_PRICE(content.tokenAddress)}`,
                {
                    headers: {
                        "X-API-Key": config.MORALIS_API_KEY,
                        accept: "application/json",
                    },
                }
            );

            const price = response.data;
            elizaLogger.success(
                `Successfully fetched price for token ${content.tokenAddress}`
            );

            if (callback) {
                const formattedText = [
                    'Current price for the Solana token:',
                    '',
                    `USD Price: $${price.usdPrice.toFixed(6)}`,
                    `Native Price: ${(Number(price.nativePrice.value) / (10 ** price.nativePrice.decimals)).toFixed(6)} ${price.nativePrice.symbol}`,
                    `Exchange: ${price.exchangeName} (${price.exchangeAddress})`
                ].join('\n');

                callback({
                    text: formattedText,
                    content: price,
                });
            }

            return true;
        } catch (error: unknown) {
            elizaLogger.error(
                "Error in GET_SOLANA_TOKEN_PRICE handler:",
                error
            );
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (callback) {
                callback({
                    text: `Error fetching Solana token price: ${errorMessage}`,
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
                    text: "Get current price of Solana token 6Rwcmkz9yiYVM5EzyMcr4JsQPGEAWhcUvLvfBperYnUt",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll fetch the current price for this Solana token.",
                    action: "GET_SOLANA_TOKEN_PRICE",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
