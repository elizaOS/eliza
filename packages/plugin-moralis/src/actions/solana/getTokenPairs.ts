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
import { getTokenPairsTemplate } from "../../templates/tokenPairs";
import { API_ENDPOINTS, SOLANA_API_BASE_URL } from "../../utils/constants";
import { TokenPairsContent, TokenPairsResponse } from "../../types/solana";

export default {
    name: "GET_SOLANA_TOKEN_PAIRS", // Changed name to be Solana-specific
    similes: [
        "FETCH_SOLANA_PAIRS",
        "LIST_SOLANA_PAIRS",
        "SHOW_SOLANA_PAIRS",
        "GET_SOLANA_TRADING_PAIRS",
    ],
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        await validateMoralisConfig(runtime);
        return true;
    },
    description: "Get trading pairs for a specific token on Solana blockchain",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting Moralis GET_SOLANA_TOKEN_PAIRS handler...");

        // Initialize or update state
        let currentState: State;
        if (!state) {
            currentState = (await runtime.composeState(message)) as State;
        } else {
            currentState = await runtime.updateRecentMessageState(state);
        }

        try {
            elizaLogger.log("Composing token pairs context...");
            const pairsContext = composeContext({
                state: currentState,
                template: getTokenPairsTemplate,
            });

            elizaLogger.log("Extracting token address...");
            const content = (await generateObjectDeprecated({
                runtime,
                context: pairsContext,
                modelClass: ModelClass.LARGE,
            })) as unknown as TokenPairsContent;

            if (!content || typeof content !== "object") {
                throw new Error("Invalid response format from model");
            }

            if (!content.tokenAddress) {
                throw new Error("No Solana token address provided");
            }

            const config = await validateMoralisConfig(runtime);
            elizaLogger.log(
                `Fetching Solana pairs for token ${content.tokenAddress}...`
            );

            const response = await axios.get<TokenPairsResponse>(
                `${SOLANA_API_BASE_URL}${API_ENDPOINTS.SOLANA.TOKEN_PAIRS(content.tokenAddress)}`,
                {
                    headers: {
                        "X-API-Key": config.MORALIS_API_KEY,
                        accept: "application/json",
                    },
                }
            );

            // Sort pairs by liquidity and get top 10
            const topPairs = response.data.pairs
                .sort((a, b) => b.liquidityUsd - a.liquidityUsd)
                .slice(0, 10);

            elizaLogger.success(
                `Successfully fetched top ${topPairs.length} pairs for ${content.tokenAddress}`
            );

            if (callback) {
                const pairsInfo = topPairs.map((pair) => ({
                    pairLabel: pair.pairLabel,
                    pairAddress: pair.pairAddress,
                    exchange: pair.exchangeName,
                    price: `$${pair.usdPrice.toFixed(4)}`,
                    liquidityUsd: `$${Math.round(pair.liquidityUsd).toLocaleString()}`,
                    volume24h: `$${Math.round(pair.volume24hrUsd).toLocaleString()}`,
                }));

                const formattedPairs = pairsInfo
                    .map(
                        (pair) =>
                            `- ${pair.pairLabel} (${pair.pairAddress})\n` +
                            `  Exchange: ${pair.exchange}\n` +
                            `  Price: ${pair.price}\n` +
                            `  Liquidity: ${pair.liquidityUsd}\n` +
                            `  24h Volume: ${pair.volume24h}`
                    )
                    .join("\n\n");

                callback({
                    text: `Here are the top ${topPairs.length} Solana trading pairs for the token, sorted by liquidity:\n\n${formattedPairs}`,
                    content: {
                        pairs: topPairs,
                        tokenAddress: content.tokenAddress,
                    },
                });
            }

            return true;
        } catch (error: unknown) {
            elizaLogger.error(
                "Error in GET_SOLANA_TOKEN_PAIRS handler:",
                error
            );
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            if (callback) {
                callback({
                    text: `Error fetching Solana token pairs: ${errorMessage}`,
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
                    text: "Get Solana trading pairs for SOL token So11111111111111111111111111111111111111112",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll fetch the Solana trading pairs for the SOL token.",
                    action: "GET_SOLANA_TOKEN_PAIRS",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show me Solana pairs for USDC token EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll retrieve the Solana trading pairs for USDC.",
                    action: "GET_SOLANA_TOKEN_PAIRS",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
