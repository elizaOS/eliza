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
        elizaLogger.debug(`[GetTokenTransfers] ${message}`, data);
        console.log(`[GetTokenTransfers] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};

interface GetTokenTransfersContent extends Content {
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
            timestamp: number;
            lag: string;
            status: string;
        };
    };
}

// Define transfer type
type TokenTransfer = {
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
};

export const actionGetTokenTransfers: Action = {
    name: "GET_TOKEN_TRANSFERS_ANKR",
    similes: ["LIST_TRANSFERS", "SHOW_TRANSFERS", "TOKEN_MOVEMENTS", "TRANSFER_HISTORY"],
    description: "Get transfer history for a specific token or address on eth.",
    examples: [[
        {
            user: "user",
            content: {
                text: "Show me recent contract [contract]0xff970a61a04b1ca14834a43f5de4533ebddb5cc8[/contract] transfers [chain]eth[/chain] from [fromtimestamp]1655197483[/fromtimestamp] to [totimestamp]1656061483[/totimestamp]",
                filters: {
                    blockchain: "eth",
                    contractAddress: "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8",
                    pageSize: 5,
                    fromTimestamp: 1655197483,
                    toTimestamp: 1656061483
                }
            } as GetTokenTransfersContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Here are the 5 most recent USDC transfers on eth:\n\n" +
                      "1. Transfer\n" +
                      "   From: 0x1234...5678\n" +
                      "   To: 0xabcd...ef01\n" +
                      "   Amount: 10,000 USDC\n" +
                      "   Time: 2024-01-24 10:30:15\n\n" +
                      "2. Transfer\n" +
                      "   From: 0x9876...5432\n" +
                      "   To: 0xfedc...ba98\n" +
                      "   Amount: 5,000 USDC\n" +
                      "   Time: 2024-01-24 10:29:45",
                success: true,
                data: {
                    transfers: [{
                        fromAddress: "0x1234567890123456789012345678901234567890",
                        toAddress: "0xabcdef0123456789abcdef0123456789abcdef01",
                        contractAddress: "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8",
                        value: "10000.0",
                        valueRawInteger: "10000000000000000000000",
                        blockchain: "eth",
                        tokenName: "USD Coin",
                        tokenSymbol: "USDC",
                        tokenDecimals: 6,
                        thumbnail: "",
                        transactionHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
                        blockHeight: 123456789,
                        timestamp: 1706093415
                    }],
                    syncStatus: {
                        timestamp: 1706093415,
                        lag: "0s",
                        status: "completed"
                    }
                }
            } as GetTokenTransfersContent
        } as ActionExample
    ]],

    // ------------------------------------------------------------------------------------------------
    // Core Validation implementation
    // ------------------------------------------------------------------------------------------------
    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        if (message.content?.type !== "GET_TOKEN_TRANSFERS_ANKR") {
            return true;
        }

        logGranular("Validating GET_TOKEN_TRANSFERS_ANKR action", {
            content: message.content
        });

        try {
            const content = message.content as GetTokenTransfersContent;
            const parsedContent = parseAPIContent(content.text);

            if (!parsedContent.chain || !parsedContent.contract) {
                throw new ValidationError("Blockchain and contract address are required");
            }

            if (parsedContent.fromTimestamp && parsedContent.toTimestamp) {
                if (parsedContent.fromTimestamp > parsedContent.toTimestamp) {
                    throw new ValidationError("From timestamp must be less than to timestamp");
                }
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
        logGranular("Executing GET_TOKEN_TRANSFERS_ANKR action");

        try {
            const messageContent = message.content as GetTokenTransfersContent;
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

            // Parse the prompt using our API content parser
            const parsedContent = parseAPIContent(messageContent.text);
            console.log("Debug - Parsed API content:", {
                hasContract: !!parsedContent.contract,
                hasChain: !!parsedContent.chain,
                hasFromTimestamp: !!parsedContent.fromTimestamp,
                hasToTimestamp: !!parsedContent.toTimestamp,
                contract: parsedContent.contract,
                chain: parsedContent.chain,
                fromTimestamp: parsedContent.fromTimestamp,
                toTimestamp: parsedContent.toTimestamp
            });

            validateRequiredFields(parsedContent, ['contract', 'chain', 'fromTimestamp', 'toTimestamp']);

            try {
                const response = await axios.post(
                    endpoint,
                    {
                        jsonrpc: "2.0",
                        method: "ankr_getTokenTransfers",
                        params: {
                            address: parsedContent.contract,
                            blockchain: [parsedContent.chain],
                            fromTimestamp: parsedContent.fromTimestamp,
                            toTimestamp: parsedContent.toTimestamp,
                            pageSize: messageContent.filters?.pageSize || 10
                        },
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

                const result = response.data.result;

                let formattedText = `Token Transfers on ${parsedContent.chain?.toUpperCase() || 'UNKNOWN'}:\n\n`;

                result.transfers.forEach((transfer: TokenTransfer, index: number) => {
                    const date = new Date(transfer.timestamp * 1000).toLocaleString();
                    const value = Number(transfer.value).toLocaleString();

                    formattedText += `${index + 1}. Transfer\n`;
                    formattedText += `   From: ${transfer.fromAddress.slice(0, 6)}...${transfer.fromAddress.slice(-4)}\n`;
                    formattedText += `   To: ${transfer.toAddress.slice(0, 6)}...${transfer.toAddress.slice(-4)}\n`;
                    formattedText += `   Amount: ${value} ${transfer.tokenSymbol}\n`;
                    formattedText += `   Token: ${transfer.tokenName}\n`;
                    formattedText += `   Time: ${date}\n\n`;
                });

                if (result.syncStatus) {
                    formattedText += `\nSync Status: ${result.syncStatus.status} (lag: ${result.syncStatus.lag})\n`;
                }

                if (callback) {
                    logGranular("Sending success callback with formatted text", { formattedText });
                    callback({
                        text: formattedText,
                        success: true,
                        data: {
                            transfers: result.transfers,
                            nextPageToken: result.nextPageToken
                        }
                    } as GetTokenTransfersContent);
                }

                return true;

            } catch (error) {
                logGranular("API request failed", { error });
                if (axios.isAxiosError(error)) {
                    throw new APIError(
                        `Failed to fetch token transfers: ${error.message}`,
                        error.response?.status
                    );
                }
                throw new APIError("Failed to fetch token transfers");
            }

        } catch (error) {
            logGranular("Handler execution failed", { error });

            if (callback) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
                callback({
                    text: `Error getting token transfers: ${errorMessage}`,
                    success: false
                } as GetTokenTransfersContent);
            }

            if (error instanceof ConfigurationError ||
                error instanceof ValidationError ||
                error instanceof APIError) {
                throw error;
            }

            throw new APIError("Failed to execute GET_TOKEN_TRANSFERS_ANKR action");
        }
    }
};

export default actionGetTokenTransfers;
