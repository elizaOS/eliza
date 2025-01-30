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
        elizaLogger.debug(`[GetNFTTransfers] ${message}`, data);
        console.log(`[GetNFTTransfers] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};

interface GetNFTTransfersContent extends Content {
    text: string;
    filters?: {
        blockchain?: string;
        contractAddress?: string;
        fromTimestamp?: number;
        toTimestamp?: number;
        pageSize?: number;
        pageToken?: string;
    };
    success?: boolean;
    data?: {
        transfers: Array<{
            fromAddress: string;
            toAddress: string;
            contractAddress: string;
            value: string;
            valueRawInteger: string;
            blockchain: string;
            tokenName: string;
            tokenSymbol: string;
            tokenDecimals: number;
            thumbnail: string;
            transactionHash: string;
            blockHeight: number;
            timestamp: number;
        }>;
        syncStatus?: {
            timestamp?: number;
            lag?: string;
            status?: string;
        } | null;
    };
}

// Add type definition for transfer
interface NFTTransfer {
    tokenName: string;
    tokenSymbol: string;
    fromAddress: string;
    toAddress: string;
    value: string;
    timestamp: number;
    transactionHash: string;
    thumbnail?: string;
}

export const actionGetNFTTransfers: Action = {
    name: "GET_NFT_TRANSFERS_ANKR",
    similes: ["LIST_NFT_TRANSFERS", "SHOW_NFT_TRANSFERS", "VIEW_NFT_TRANSFERS", "GET_NFT_HISTORY"],
    description: "Get NFT transfer history for a specific address or contract on eth.",



    // Fix the example data to match the interface
    examples: [[
        {
            user: "user",
            content: {
                text: "Show me NFT transfers for contract [contract]0x34d85c9cdeb23fa97cb08333b511ac86e1c4e258[/contract] [chain]eth[/chain] [fromtimestamp]1655197483[/fromtimestamp][totimestamp]1671974699[/totimestamp]",
                filters: {
                    blockchain: "eth",
                    contractAddress: "0x34d85c9cdeb23fa97cb08333b511ac86e1c4e258",
                    pageSize: 5
                }
            } as GetNFTTransfersContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "NFT Transfers:\n\n" +
                      "1. Transfer of Token #1234\n" +
                      "   From: 0xabcd...ef01\n" +
                      "   To: 0x9876...4321\n" +
                      "   Time: 1/24/2024, 10:30:15 AM\n" +
                      "   Token: CoolNFT #123\n\n" +
                      "2. Transfer of Token #456\n" +
                      "   From: 0x9876...3210\n" +
                      "   To: 0xfedc...ba98\n" +
                      "   Time: 1/24/2024, 10:15:22 AM\n" +
                      "   Token: CoolNFT #456\n",
                success: true,
                data: {
                    transfers: [
                        {
                            fromAddress: "0xabcdef0123456789abcdef0123456789abcdef01",
                            toAddress: "0x9876543210fedcba9876543210fedcba98765432",
                            contractAddress: "0x34d85c9cdeb23fa97cb08333b511ac86e1c4e258",
                            value: "1",
                            valueRawInteger: "1",
                            blockchain: "eth",
                            tokenName: "CoolNFT",
                            tokenSymbol: "COOL",
                            tokenDecimals: 18,
                            thumbnail: "https://example.com/nft/123.png",
                            transactionHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
                            blockHeight: 123456789,
                            timestamp: 1706093415
                        },
                        {
                            fromAddress: "0x9876543210987654321098765432109876543210",
                            toAddress: "0xfedcba9876543210fedcba9876543210fedcba98",
                            contractAddress: "0x34d85c9cdeb23fa97cb08333b511ac86e1c4e258",
                            value: "1",
                            valueRawInteger: "1",
                            blockchain: "eth",
                            tokenName: "CoolNFT",
                            tokenSymbol: "COOL",
                            tokenDecimals: 18,
                            thumbnail: "https://example.com/nft/456.png",
                            transactionHash: "0x9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba",
                            blockHeight: 123456788,
                            timestamp: 1706092522
                        }
                    ],
                    syncStatus: {
                        timestamp: 1706093415,
                        lag: "0s",
                        status: "synced"
                    }
                }
            } as GetNFTTransfersContent
        } as ActionExample
    ]],
    // ------------------------------------------------------------------------------------------------
    // Core Validation implementation
    // ------------------------------------------------------------------------------------------------
    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        if (message.content?.type !== "GET_NFT_TRANSFERS_ANKR") {
            return true;
        }

        logGranular("Validating GET_NFT_TRANSFERS_ANKR action", {
            content: message.content
        });

        try {
            const content = message.content as GetNFTTransfersContent;

            if (!content.filters?.blockchain || !content.filters?.contractAddress) {
                throw new ValidationError("Blockchain and contract address are required");
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
        logGranular("Executing GET_NFT_TRANSFERS_ANKR action");

        try {
            const messageContent = message.content as GetNFTTransfersContent;
            console.log("Debug - Full message content:", {
                fullContent: message.content,
                rawText: messageContent?.text,
                type: message.content?.type,
                allKeys: Object.keys(message.content || {})
            });

            console.log("Debug - Message content details:", {
                hasText: !!messageContent?.text,
                hasFilters: !!messageContent?.filters,
                textContent: messageContent?.text,
                contentType: typeof messageContent?.text
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
                hasChain: !!parsedContent.chain,
                hasFromTimestamp: !!parsedContent.fromTimestamp,
                hasToTimestamp: !!parsedContent.toTimestamp,
                contract: parsedContent.contract,
                chain: parsedContent.chain,
                fromTimestamp: parsedContent.fromTimestamp,
                toTimestamp: parsedContent.toTimestamp,
                matches: parsedContent.raw.matches
            });

            // Validate required fields
            validateRequiredFields(parsedContent, ['contract', 'chain', 'fromTimestamp', 'toTimestamp']);

            // Prepare API request parameters
            const requestParams = {
                address: parsedContent.contract,
                blockchain: [parsedContent.chain],
                fromTimestamp: parsedContent.fromTimestamp,
                toTimestamp: parsedContent.toTimestamp
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
                        method: "ankr_getTokenTransfers",
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

                const transfers = response.data.result.transfers;

                // Format the response text
                let formattedText = "Token Transfers:\n\n";
                transfers.forEach((transfer: NFTTransfer, index: number) => {
                    formattedText += `${index + 1}. Transfer of ${transfer.tokenName} (${transfer.tokenSymbol})\n`;
                    formattedText += `   From: ${transfer.fromAddress.slice(0, 6)}...${transfer.fromAddress.slice(-4)}\n`;
                    formattedText += `   To: ${transfer.toAddress.slice(0, 6)}...${transfer.toAddress.slice(-4)}\n`;
                    formattedText += `   Amount: ${transfer.value}\n`;
                    formattedText += `   Time: ${new Date(transfer.timestamp * 1000).toLocaleString()}\n`;
                    formattedText += `   Tx Hash: ${transfer.transactionHash}\n`;
                    if (transfer.thumbnail) {
                        formattedText += `   Token Icon: ${transfer.thumbnail}\n`;
                    }
                    formattedText += "\n";
                });

                if (callback) {
                    logGranular("Sending success callback with formatted text", { formattedText });
                    callback({
                        text: formattedText,
                        success: true,
                        data: {
                            transfers,
                            syncStatus: response.data.result.syncStatus
                        }
                    } as GetNFTTransfersContent);
                }

                return true;

            } catch (error) {
                logGranular("API request failed", { error });
                if (axios.isAxiosError(error)) {
                    throw new APIError(
                        `Failed to fetch NFT transfers: ${error.message}`,
                        error.response?.status
                    );
                }
                throw new APIError("Failed to fetch NFT transfers");
            }

        } catch (error) {
            logGranular("Handler execution failed", { error });

            if (callback) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
                callback({
                    text: `Error getting NFT transfers: ${errorMessage}`,
                    success: false
                } as GetNFTTransfersContent);
            }

            if (error instanceof ConfigurationError ||
                error instanceof ValidationError ||
                error instanceof APIError) {
                throw error;
            }

            throw new APIError("Failed to execute GET_NFT_TRANSFERS_ANKR action");
        }
    }
};

export default actionGetNFTTransfers;
