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
import { getTokenMetadataTemplate } from "../../templates/tokenMetadata";
import { API_ENDPOINTS, SOLANA_API_BASE_URL } from "../../utils/constants";
import { TokenMetadataContent, TokenMetadata } from "../../types/solana";

export default {
    name: "GET_SOLANA_TOKEN_METADATA",
    similes: [
        "CHECK_SOLANA_TOKEN_INFO",
        "GET_SOLANA_TOKEN_SUPPLY",
        "CHECK_SOLANA_TOKEN_FDV",
        "SHOW_SOLANA_TOKEN_METADATA",
    ],
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        await validateMoralisConfig(runtime);
        return true;
    },
    description:
        "Get token metadata including supply, FDV, and other details on Solana blockchain",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log(
            "Starting Moralis GET_SOLANA_TOKEN_METADATA handler..."
        );

        // Initialize or update state
        let currentState: State;
        if (!state) {
            currentState = (await runtime.composeState(message)) as State;
        } else {
            currentState = await runtime.updateRecentMessageState(state);
        }

        try {
            elizaLogger.log("Composing token metadata context...");
            const metadataContext = composeContext({
                state: currentState,
                template: getTokenMetadataTemplate,
            });

            elizaLogger.log("Extracting token address...");
            const content = (await generateObjectDeprecated({
                runtime,
                context: metadataContext,
                modelClass: ModelClass.LARGE,
            })) as unknown as TokenMetadataContent;

            if (!content || typeof content !== "object") {
                throw new Error("Invalid response format from model");
            }

            if (!content.tokenAddress) {
                throw new Error("No Solana token address provided");
            }

            const config = await validateMoralisConfig(runtime);
            elizaLogger.log(
                `Fetching metadata for Solana token ${content.tokenAddress}...`
            );

            const response = await axios.get<TokenMetadata>(
                `${SOLANA_API_BASE_URL}${API_ENDPOINTS.SOLANA.TOKEN_METADATA(content.tokenAddress)}`,
                {
                    headers: {
                        "X-API-Key": config.MORALIS_API_KEY,
                        accept: "application/json",
                    },
                }
            );

            const metadata = response.data;
            elizaLogger.success(
                `Successfully fetched metadata for token ${content.tokenAddress}`
            );

            if (callback) {
                const formattedText = [
                    'Token Metadata:\n',
                    `Name: ${metadata.name} (${metadata.symbol})`,
                    `Token Address: ${metadata.mint}`,
                    `Total Supply: ${metadata.totalSupplyFormatted}`,
                    `Fully Diluted Value: $${Number(metadata.fullyDilutedValue).toLocaleString()}`,
                    `Standard: ${metadata.standard}`,
                    `Decimals: ${metadata.decimals}\n`,
                    'Metaplex Details:',
                    `- Update Authority: ${metadata.metaplex.updateAuthority}`,
                    `- Mutable: ${metadata.metaplex.isMutable}`,
                    `- Master Edition: ${metadata.metaplex.masterEdition}`,
                    `- Seller Fee: ${metadata.metaplex.sellerFeeBasisPoints / 100}%`
                ].join('\n');

                callback({
                    text: formattedText,
                    content: metadata,
                });
            }

            return true;
        } catch (error: unknown) {
            elizaLogger.error(
                "Error in GET_SOLANA_TOKEN_METADATA handler:",
                error
            );
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (callback) {
                callback({
                    text: `Error fetching Solana token metadata: ${errorMessage}`,
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
                    text: "What's the FDV and total supply of SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt?",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll fetch the token metadata including supply and FDV information.",
                    action: "GET_SOLANA_TOKEN_METADATA",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
