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
        elizaLogger.debug(`[GetNFTsByOwner] ${message}`, data);
        console.log(`[GetNFTsByOwner] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};
// ------------------------------------------------------------------------------------------------
// Granular Logger
// ------------------------------------------------------------------------------------------------

interface GetNFTsByOwnerContent extends Content {
    text: string;
    filters?: {
        blockchain?: string[];
        walletAddress?: string;
        pageSize?: number;
        pageToken?: string;
    };
    success?: boolean;
    data?: {
        owner: string;
        assets: Array<{
            blockchain: string;
            name: string;
            tokenId: string;
            tokenUrl: string;
            imageUrl: string;
            collectionName: string;
            symbol: string;
            contractType: string;
            contractAddress: string;
            quantity?: string;  // Added for ERC1155 support
        }>;
        syncStatus?: {
            timestamp?: number;
            lag?: string;
            status?: string;
        } | null;
    };
}

type NFTAsset = {
    blockchain: string;
    name: string;
    tokenId: string;
    tokenUrl: string;
    imageUrl: string;
    collectionName: string;
    symbol: string;
    contractType: string;
    contractAddress: string;
    quantity?: string;
};

// ------------------------------------------------------------------------------------------------
// Core Action implementation
// ------------------------------------------------------------------------------------------------
export const actionGetNFTsByOwner: Action = {
    name: "GET_NFTS_BY_OWNER_ANKR",
    similes: ["LIST_NFTS", "SHOW_NFTS", "VIEW_NFTS", "FETCH_NFTS", "GET_OWNED_NFTS"],
    description: "Retrieve all NFTs owned by a specific wallet address across multiple blockchains with detailed metadata.",
    examples: [[
        {
            user: "user",
            content: {
                text: "Show me all NFTs owned by wallet [wallet]0x1234567890123456789012345678901234567890[/wallet] on [chain]eth[/chain]",
                filters: {
                    blockchain: ["eth"],
                    walletAddress: "0x1234567890123456789012345678901234567890",
                    pageSize: 10
                }
            } as GetNFTsByOwnerContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "NFTs owned by 0x1234567890123456789012345678901234567890:\n\n" +
                      "1. Bored Ape #1234\n" +
                      "   Collection: Bored Ape Yacht Club\n" +
                      "   Contract: 0xbc4c...f13d\n" +
                      "   Token ID: 1234\n\n" +
                      "2. CryptoPunk #5678\n" +
                      "   Collection: CryptoPunks\n" +
                      "   Contract: 0x2505...42a2\n" +
                      "   Token ID: 5678\n",
                success: true,
                data: {
                    owner: "0x1234567890123456789012345678901234567890",
                    assets: [
                        {
                            blockchain: "eth",
                            name: "Bored Ape #1234",
                            tokenId: "1234",
                            tokenUrl: "ipfs://QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq/1234",
                            imageUrl: "ipfs://QmRRPWG96cmgTn2qSzjwr2qvfNEuhunv6FNeMFGa9bx6mQ",
                            collectionName: "Bored Ape Yacht Club",
                            symbol: "BAYC",
                            contractType: "ERC721",
                            contractAddress: "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d"
                        },
                        {
                            blockchain: "eth",
                            name: "CryptoPunk #5678",
                            tokenId: "5678",
                            tokenUrl: "https://cryptopunks.app/cryptopunks/details/5678",
                            imageUrl: "https://cryptopunks.app/cryptopunks/image/5678",
                            collectionName: "CryptoPunks",
                            symbol: "PUNK",
                            contractType: "ERC721",
                            contractAddress: "0x2505...42a2"
                        }
                    ]
                }
            } as GetNFTsByOwnerContent
        } as ActionExample
    ]],
    // ------------------------------------------------------------------------------------------------
    // Core Validation implementation
    // ------------------------------------------------------------------------------------------------
    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        if (message.content?.type !== "GET_NFTS_BY_OWNER_ANKR") {
            return true;
        }

        logGranular("Validating GET_NFTS_BY_OWNER_ANKR action", {
            content: message.content
        });

        try {
            const content = message.content as GetNFTsByOwnerContent;

            if (!content.filters?.blockchain || !content.filters?.walletAddress) {
                throw new ValidationError("Blockchain and wallet address are required");
            }

            if (content.filters?.blockchain && !Array.isArray(content.filters.blockchain)) {
                throw new ValidationError("Blockchain must be an array");
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
        logGranular("Executing GET_NFTS_BY_OWNER_ANKR action");

        try {
            const messageContent = message.content as GetNFTsByOwnerContent;
            console.log("Debug - Full message content:", {
                fullContent: message.content,
                rawText: messageContent?.text,
                type: message.content?.type
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
            const parsedContent = parseAPIContent(messageContent.text);
            console.log("Debug - Parsed API content:", {
                hasWallet: !!parsedContent.wallet,
                hasChain: !!parsedContent.chain,
                wallet: parsedContent.wallet,
                chain: parsedContent.chain,
                matches: parsedContent.raw.matches
            });

            // Validate required fields
            validateRequiredFields(parsedContent, ['wallet', 'chain']);

            // Prepare API request parameters
            const requestParams = {
                blockchain: [parsedContent.chain],  // API expects array
                walletAddress: parsedContent.wallet,
                pageSize: messageContent.filters?.pageSize ?? 10,
                pageToken: messageContent.filters?.pageToken
            };

            console.log("Debug - API request parameters:", requestParams);

            try {
                const response = await axios.post(
                    endpoint,
                    {
                        jsonrpc: "2.0",
                        method: "ankr_getNFTsByOwner",
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

                const { owner, assets, syncStatus } = response.data.result;

                // Format the response text
                let formattedText = `NFTs owned by ${owner}:\n\n`;

                for (const [index, nft] of (assets as NFTAsset[]).entries()) {
                    formattedText += `${index + 1}. ${nft.name || 'Unnamed NFT'}\n`;
                    if (nft.collectionName) {
                        formattedText += `   Collection: ${nft.collectionName}\n`;
                    }
                    formattedText += `   Contract: ${nft.contractAddress.slice(0, 6)}...${nft.contractAddress.slice(-4)} (${nft.contractType})\n`;
                    formattedText += `   Token ID: ${nft.tokenId}\n`;
                    if (nft.quantity) {
                        formattedText += `   Quantity: ${nft.quantity}\n`;
                    }
                    if (nft.tokenUrl) {
                        formattedText += `   Metadata URL: ${nft.tokenUrl}\n`;
                    }
                    formattedText += '\n';
                }

                if (callback) {
                    logGranular("Sending success callback with formatted text", { formattedText });
                    callback({
                        text: formattedText,
                        success: true,
                        data: {
                            owner,
                            assets,
                            syncStatus
                        }
                    } as GetNFTsByOwnerContent);
                }

                return true;

            } catch (error) {
                logGranular("API request failed", { error });
                if (axios.isAxiosError(error)) {
                    throw new APIError(
                        `Failed to fetch NFTs data: ${error.message}`,
                        error.response?.status
                    );
                }
                throw new APIError("Failed to fetch NFTs data");
            }

        } catch (error) {
            logGranular("Handler execution failed", { error });

            if (callback) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
                callback({
                    text: `Error getting NFTs: ${errorMessage}`,
                    success: false
                } as GetNFTsByOwnerContent);
            }

            if (error instanceof ConfigurationError ||
                error instanceof ValidationError ||
                error instanceof APIError) {
                throw error;
            }

            throw new APIError("Failed to execute GET_NFTS_BY_OWNER_ANKR action");
        }
    },


};

export default actionGetNFTsByOwner;

