// ------------------------------------------------------------------------------------------------
// Essential Imports
// ------------------------------------------------------------------------------------------------
import { Action, elizaLogger } from "@elizaos/core";
import { IAgentRuntime, Memory, State, HandlerCallback, Content, ActionExample } from "@elizaos/core";
// ------------------------------------------------------------------------------------------------
// Essential Imports
// ------------------------------------------------------------------------------------------------
import axios from 'axios';
import { getConfig, validateankrConfig, ANKR_ENDPOINTS } from '../environment';
import { APIError, ConfigurationError, ValidationError } from '../error/base';
import { parseAPIContent, validateRequiredFields } from '../validator/apiParseValidation';
// ------------------------------------------------------------------------------------------------
// Granular Logger
// ------------------------------------------------------------------------------------------------
// Get configuration for granular logging
const config = getConfig();
const GRANULAR_LOG = config.ANKR_GRANULAR_LOG;

// Enhanced logging helper
const logGranular = (message: string, data?: unknown) => {
    if (GRANULAR_LOG) {
        elizaLogger.debug(`[GetNFTMetadata] ${message}`, data);
        console.log(`[GetNFTMetadata] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};
// ------------------------------------------------------------------------------------------------
// Granular Logger
// ------------------------------------------------------------------------------------------------

interface GetNFTMetadataContent extends Content {
    text: string;
    filters?: {
        blockchain?: string;
        contractAddress?: string;
        tokenId?: string;
    };
    success?: boolean;
    data?: {
        metadata: {
            blockchain: string;
            contractAddress: string;
            contractType: string;
            tokenId: string;
        };
        attributes: {
            contractType: string;
            tokenUrl: string;
            imageUrl: string;
            name: string;
            description: string;
            traits: Array<{
                trait_type: string;
                value: string;
            }>;
        };
    };
}

export const actionGetNFTMetadata: Action = {
    name: "GET_NFT_METADATA_ANKR",
    similes: ["GET_NFT_INFO", "SHOW_NFT_DETAILS", "VIEW_NFT", "NFT_METADATA"],
    description: "Get detailed metadata for a specific NFT including traits, images, and contract information.",
    examples: [[
        {
            user: "user",
            content: {
                text: "Show me the metadata for NFT [token]1234[/token] at contract [contract]0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d[/contract] [chain]eth[/chain]",
                filters: {
                    blockchain: "eth",
                    contractAddress: "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d",
                    tokenId: "1234"
                }
            } as GetNFTMetadataContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "NFT Metadata for Bored Ape #1234:\n\n" +
                      "Collection: Bored Ape Yacht Club\n" +
                      "Contract: 0xbc4c...f13d (ERC721)\n\n" +
                      "Description: A unique Bored Ape NFT living on the Ethereum blockchain\n\n" +
                      "Traits:\n" +
                      "- Background: Blue\n" +
                      "- Fur: Dark Brown\n" +
                      "- Eyes: Bored\n" +
                      "- Mouth: Grin\n",
                success: true,
                data: {
                    metadata: {
                        blockchain: "eth",
                        contractAddress: "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d",
                        contractType: "ERC721",
                        tokenId: "1234"
                    },
                    attributes: {
                        contractType: "ERC721",
                        tokenUrl: "ipfs://QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq/1234",
                        imageUrl: "ipfs://QmRRPWG96cmgTn2qSzjwr2qvfNEuhunv6FNeMFGa9bx6mQ",
                        name: "Bored Ape #1234",
                        description: "A unique Bored Ape NFT living on the Ethereum blockchain",
                        traits: [
                            { trait_type: "Background", value: "Blue" },
                            { trait_type: "Fur", value: "Dark Brown" },
                            { trait_type: "Eyes", value: "Bored" },
                            { trait_type: "Mouth", value: "Grin" }
                        ]
                    }
                }
            } as GetNFTMetadataContent
        } as ActionExample
    ]],
    // ------------------------------------------------------------------------------------------------
    // Core Validation implementation
    // ------------------------------------------------------------------------------------------------
    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        if (message.content?.type !== "GET_NFT_METADATA_ANKR") {
            return true;
        }

        logGranular("Validating GET_NFT_METADATA_ANKR action", {
            content: message.content
        });

        try {
            const content = message.content as GetNFTMetadataContent;

            if (!content.filters?.blockchain || !content.filters?.contractAddress || !content.filters?.tokenId) {
                throw new ValidationError("Blockchain, contract address, and token ID are required");
            }

            logGranular("Validation successful");
            return true;
        } catch (error) {
            logGranular("Validation failed", { error });
            if (error instanceof ValidationError) {
                throw error;
            }
            throw new ValidationError(error instanceof Error ? error.message : "Unknown validation error");
        }
    },
    // ------------------------------------------------------------------------------------------------
    // Core Handler implementation
    // ------------------------------------------------------------------------------------------------
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State,
        _options: { [key: string]: unknown } = {},
        callback?: HandlerCallback
    ): Promise<boolean> => {
        logGranular("Executing GET_NFT_METADATA_ANKR action");

        try {
            const messageContent = message.content as GetNFTMetadataContent;
            console.log("Debug - Full message content:", {
                fullContent: message.content,
                rawText: messageContent?.text,
                type: message.content?.type,
                allKeys: Object.keys(message.content || {})
            });

            const config = await validateankrConfig(runtime);
            console.log("Debug - Config validated:", {
                hasWallet: !!config.ANKR_WALLET,
                env: config.ANKR_ENV
            });

            const wallet = config.ANKR_WALLET;
            if (!wallet) {
                throw new ConfigurationError("ANKR_WALLET not found in environment variables");
            }

            const endpoint = `https://rpc.ankr.com/multichain/${wallet}`;

            // Parse the prompt using our API content parser
            console.log("Debug - Raw prompt:", {
                text: messageContent.text,
                promptLength: messageContent.text?.length,
            });

            const parsedContent = parseAPIContent(messageContent.text);
            console.log("Debug - Parsed API content:", {
                hasContract: !!parsedContent.contract,
                hasToken: !!parsedContent.token,
                hasChain: !!parsedContent.chain,
                contract: parsedContent.contract,
                token: parsedContent.token,
                chain: parsedContent.chain,
                matches: parsedContent.raw.matches
            });

            // Validate required fields
            validateRequiredFields(parsedContent, ['contract', 'token', 'chain']);

            // Prepare API request parameters
            const requestParams = {
                blockchain: parsedContent.chain,
                contractAddress: parsedContent.contract,
                tokenId: parsedContent.token
            };

            console.log("Debug - API request parameters:", {
                params: requestParams,
                endpoint: ANKR_ENDPOINTS.production.multichain
            });

            try {
                const response = await axios.post(
                    endpoint,
                    {
                        jsonrpc: "2.0",
                        method: "ankr_getNFTMetadata",
                        params: requestParams,
                        id: 1
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    }
                );

                logGranular("Received response from Ankr API", {
                    statusCode: response.status,
                    data: response.data
                });

                if (response.data.error) {
                    throw new APIError(`Ankr API error: ${response.data.error.message}`);
                }

                const nftData = response.data.result;

                // Format the response text
                let formattedText = `NFT Metadata for ${nftData.attributes.name}:\n\n`;
                formattedText += `Collection: ${nftData.attributes.name.split('#')[0].trim()}\n`;
                formattedText += `Contract: ${nftData.metadata.contractAddress.slice(0, 6)}...${nftData.metadata.contractAddress.slice(-4)} (${nftData.metadata.contractType})\n\n`;

                if (nftData.attributes.description) {
                    formattedText += `Description: ${nftData.attributes.description}\n\n`;
                }

                if (nftData.attributes.traits && nftData.attributes.traits.length > 0) {
                    formattedText += "Traits:\n";
                    for (const trait of nftData.attributes.traits as { trait_type: string; value: string }[]) {
                        formattedText += `- ${trait.trait_type}: ${trait.value}\n`;
                    }
                }

                if (nftData.attributes.imageUrl) {
                    formattedText += `\nImage URL: ${nftData.attributes.imageUrl}\n`;
                }

                if (callback) {
                    logGranular("Sending success callback with formatted text", { formattedText });
                    callback({
                        text: formattedText,
                        success: true,
                        data: nftData
                    } as GetNFTMetadataContent);
                }

                return true;

            } catch (error) {
                logGranular("API request failed", { error });
                if (axios.isAxiosError(error)) {
                    throw new APIError(
                        `Failed to fetch NFT metadata: ${error.message}`,
                        error.response?.status
                    );
                }
                throw new APIError("Failed to fetch NFT metadata");
            }

        } catch (error) {
            logGranular("Handler execution failed", { error });

            if (callback) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
                callback({
                    text: `Error getting NFT metadata: ${errorMessage}`,
                    success: false
                } as GetNFTMetadataContent);
            }

            if (error instanceof ConfigurationError ||
                error instanceof ValidationError ||
                error instanceof APIError) {
                throw error;
            }

            throw new APIError("Failed to execute GET_NFT_METADATA_ANKR action");
        }
    },


};

export default actionGetNFTMetadata;
