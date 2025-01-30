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
        elizaLogger.debug(`[GetTransactionsByAddress] ${message}`, data);
        console.log(`[GetTransactionsByAddress] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};

interface GetTransactionsByAddressContent extends Content {
    text: string;
    filters?: {
        blockchain?: string;
        address?: string;
        pageSize?: number;
        includeLogs?: boolean;
    };
    success?: boolean;
    data?: {
        nextPageToken?: string;
        transactions: Array<{
            blockHash: string;
            blockNumber: string;
            from: string;
            to: string;
            hash: string;
            value: string;
            gas: string;
            gasPrice: string;
            gasUsed: string;
            input: string;
            nonce: string;
            timestamp: string;
            status: string;
            blockchain: string;
            logs?: Array<{
                address: string;
                topics: string[];
                data: string;
                blockNumber: string;
                transactionHash: string;
                logIndex: string;
                timestamp: string;
            }>;
        }>;
        syncStatus?: {
            timestamp: number;
            lag: string;
            status: string;
        };
    };
}

// Define transaction type
type Transaction = {
    blockHash: string;
    blockNumber: string;
    from: string;
    to: string;
    hash: string;
    value: string;
    gas: string;
    gasPrice: string;
    gasUsed: string;
    input: string;
    nonce: string;
    timestamp: string;
    status: string;
    blockchain: string;
    logs?: Array<{
        address: string;
        topics: string[];
        data: string;
        blockNumber: string;
        transactionHash: string;
        logIndex: string;
        timestamp: string;
    }>;
};

export const actionGetTransactionsByAddress: Action = {
    name: "GET_TRANSACTIONS_BY_ADDRESS_ANKR",
    similes: ["LIST_TXS", "SHOW_TXS", "VIEW_TRANSACTIONS", "GET_ADDRESS_TXS"],
    description: "Get transactions for a specific address on the blockchain",
    examples: [[
        {
            user: "user",
            content: {
                text: "Show me the latest transactions for address [contract]0xd8da6bf26964af9d7eed9e03e53415d37aa96045[/contract] [chain]eth[/chain]",
                filters: {
                    blockchain: "eth",
                    address: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
                    pageSize: 2,
                    includeLogs: true
                }
            } as GetTransactionsByAddressContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Here are the latest transactions for the address on eth:\n\n" +
                      "1. Transfer Out\n" +
                      "   To: 0x1234...5678\n" +
                      "   Amount: 1.5 ETH\n" +
                      "   Time: 2024-01-24 10:30:15\n" +
                      "   Status: Success\n\n" +
                      "2. Contract Interaction\n" +
                      "   Contract: 0xabcd...ef01 (Uniswap V3)\n" +
                      "   Method: swapExactTokensForTokens\n" +
                      "   Time: 2024-01-24 10:15:22\n" +
                      "   Status: Success",
                success: true,
                data: {
                    transactions: [{
                        blockchain: "eth",
                        from: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
                        to: "0x1234567890123456789012345678901234567890",
                        hash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
                        value: "1500000000000000000",
                        gas: "21000",
                        gasPrice: "100000000",
                        gasUsed: "21000",
                        timestamp: "2024-01-24T10:30:15Z",
                        status: "1",
                        blockNumber: "123456789",
                        blockHash: "0x9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba"
                    }]
                }
            } as GetTransactionsByAddressContent
        } as ActionExample
    ]],

    // ------------------------------------------------------------------------------------------------
    // Core Validation implementation
    // ------------------------------------------------------------------------------------------------
    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        if (message.content?.type !== "GET_TRANSACTIONS_BY_ADDRESS_ANKR") {
            return true;
        }

        logGranular("Validating GET_TRANSACTIONS_BY_ADDRESS_ANKR action", {
            content: message.content
        });

        try {
            const content = message.content as GetTransactionsByAddressContent;
            const parsedContent = parseAPIContent(content.text);

            if (!parsedContent.chain || !parsedContent.contract) {
                throw new ValidationError("Blockchain and address are required");
            }

            // Validate pageSize if provided
            if (content.filters?.pageSize && (content.filters.pageSize < 1 || content.filters.pageSize > 100)) {
                throw new ValidationError("Page size must be between 1 and 100");
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
        logGranular("Executing GET_TRANSACTIONS_BY_ADDRESS_ANKR action");

        try {
            const messageContent = message.content as GetTransactionsByAddressContent;
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

            // Parse the prompt using our API content parser
            const parsedContent = parseAPIContent(messageContent.text);
            console.log("Debug - Parsed API content:", {
                hasContract: !!parsedContent.contract,
                hasChain: !!parsedContent.chain,
                contract: parsedContent.contract,
                chain: parsedContent.chain
            });

            validateRequiredFields(parsedContent, ['contract', 'chain']);

            try {
                const response = await axios.post(
                    endpoint,
                    {
                        jsonrpc: "2.0",
                        method: "ankr_getTransactionsByAddress",
                        params: {
                            blockchain: [parsedContent.chain],
                            address: parsedContent.contract,
                            pageSize: messageContent.filters?.pageSize || 5,
                            includeLogs: messageContent.filters?.includeLogs || true
                        },
                        id: 1
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    }
                );

                if (response.data.error) {
                    throw new APIError(`Ankr API error: ${response.data.error.message}`);
                }

                const result = response.data.result;
                let formattedText = `Transactions for ${parsedContent.contract} on ${parsedContent.chain?.toUpperCase() || 'UNKNOWN'}:\n\n`;

                result.transactions.forEach((tx: Transaction, index: number) => {
                    const date = new Date(Number.parseInt(tx.timestamp, 16) * 1000).toLocaleString();
                    const value = Number.parseInt(tx.value, 16) / 1e18;
                    const status = tx.status === "0x1" ? "Success" : "Failed";

                    formattedText += `${index + 1}. Transaction\n`;
                    formattedText += `   Hash: ${tx.hash.slice(0, 6)}...${tx.hash.slice(-4)}\n`;
                    formattedText += `   From: ${tx.from.slice(0, 6)}...${tx.from.slice(-4)}\n`;
                    formattedText += `   To: ${tx.to.slice(0, 6)}...${tx.to.slice(-4)}\n`;
                    formattedText += `   Value: ${value.toFixed(4)} ETH\n`;
                    formattedText += `   Status: ${status}\n`;
                    formattedText += `   Time: ${date}\n\n`;
                });

                if (callback) {
                    callback({
                        text: formattedText,
                        success: true,
                        data: {
                            transactions: result.transactions,
                            nextPageToken: result.nextPageToken,
                            syncStatus: result.syncStatus
                        }
                    } as GetTransactionsByAddressContent);
                }

                return true;

            } catch (error) {
                logGranular("API request failed", { error });
                if (axios.isAxiosError(error)) {
                    throw new APIError(
                        `Failed to fetch transactions: ${error.message}`,
                        error.response?.status
                    );
                }
                throw new APIError("Failed to fetch transactions");
            }

        } catch (error) {
            logGranular("Handler execution failed", { error });

            if (callback) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
                callback({
                    text: `Error getting transactions: ${errorMessage}`,
                    success: false
                } as GetTransactionsByAddressContent);
            }

            if (error instanceof ConfigurationError ||
                error instanceof ValidationError ||
                error instanceof APIError) {
                throw error;
            }

            throw new APIError("Failed to execute GET_TRANSACTIONS_BY_ADDRESS_ANKR action");
        }
    }
};

export default actionGetTransactionsByAddress;
