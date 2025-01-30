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
        elizaLogger.debug(`[GetTransactionsByHash] ${message}`, data);
        console.log(`[GetTransactionsByHash] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};

interface GetTransactionsByHashContent extends Content {
    text: string;
    filters?: {
        blockchain?: string;
        transactionHash?: string;
        includeLogs?: boolean;
    };
    success?: boolean;
    data?: {
        transactions: Array<{
            blockHash: string;
            blockNumber: string;
            blockchain: string;
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
            type: string;
            v: string;
            r: string;
            s: string;
            transactionIndex: string;
            cumulativeGasUsed: string;
        }>;
        syncStatus?: {
            timestamp: number;
            lag: string;
            status: string;
        } | null;
    };
}

export const actionGetTransactionsByHash: Action = {
    name: "GET_TRANSACTIONS_BY_HASH_ANKR",
    similes: ["GET_TX", "SHOW_TRANSACTION", "VIEW_TX", "TRANSACTION_DETAILS"],
    description: "Get detailed information about a transaction by its hash",
    examples: [[
        {
            user: "user",
            content: {
                text: "Show me details for transaction [txHash]0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef[/txHash] [chain]eth[/chain]",
                filters: {
                    blockchain: "eth",
                    transactionHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
                    includeLogs: true
                }
            } as GetTransactionsByHashContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Here are the details for the transaction on eth:\n\n" +
                      "Transaction: 0x1234...cdef\n" +
                      "Status: Success\n" +
                      "From: 0xabcd...ef01\n" +
                      "To: 0x9876...5432\n" +
                      "Value: 1.5 ETH\n" +
                      "Gas Used: 150,000\n" +
                      "Gas Price: 0.1 Gwei\n" +
                      "Block: 123456789\n" +
                      "Timestamp: 2024-01-24 10:30:15",
                success: true,
                data: {
                    transactions: [{
                        blockchain: "eth",
                        from: "0xabcdef0123456789abcdef0123456789abcdef01",
                        to: "0x9876543210987654321098765432109876543210",
                        hash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
                        value: "1500000000000000000",
                        gas: "21000",
                        gasPrice: "100000000",
                        gasUsed: "21000",
                        timestamp: "2024-01-24T10:30:15Z",
                        status: "1",
                        blockNumber: "123456789",
                        blockHash: "0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321"
                    }]
                }
            } as GetTransactionsByHashContent
        } as ActionExample
    ]],
    // ------------------------------------------------------------------------------------------------
    // Core Validation implementation
    // ------------------------------------------------------------------------------------------------
    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        if (message.content?.type !== "GET_TRANSACTIONS_BY_HASH_ANKR") {
            return true;
        }

        logGranular("Validating GET_TRANSACTIONS_BY_HASH_ANKR action", {
            content: message.content
        });

        try {
            const content = message.content as GetTransactionsByHashContent;
            const parsedContent = parseAPIContent(content.text);

            if (!parsedContent.chain || !parsedContent.txHash) {
                throw new ValidationError("Blockchain and transaction hash are required");
            }

            // Validate transaction hash format
            if (!/^0x[a-fA-F0-9]{64}$/.test(parsedContent.txHash)) {
                throw new ValidationError("Invalid transaction hash format");
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
        logGranular("Executing GET_TRANSACTIONS_BY_HASH_ANKR action");

        try {
            const messageContent = message.content as GetTransactionsByHashContent;
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
                hasTx: !!parsedContent.txHash,
                hasChain: !!parsedContent.chain,
                tx: parsedContent.txHash,
                chain: parsedContent.chain
            });

            validateRequiredFields(parsedContent, ['txHash', 'chain']);

            try {
                const response = await axios.post(
                    endpoint,
                    {
                        jsonrpc: "2.0",
                        method: "ankr_getTransactionsByHash",
                        params: {
                            blockchain: parsedContent.chain,
                            transactionHash: parsedContent.txHash,
                            includeLogs: true
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

                const transaction = response.data.result.transactions[0];
                const timestamp = new Date(Number.parseInt(transaction.timestamp, 16) * 1000).toLocaleString();
                const value = Number.parseInt(transaction.value, 16) / 1e18;
                const gasPrice = Number.parseInt(transaction.gasPrice, 16) / 1e9;
                const gasUsed = Number.parseInt(transaction.gasUsed, 16);
                const blockNumber = Number.parseInt(transaction.blockNumber, 16);
                const status = transaction.status === "0x1" ? "Success" : "Failed";

                let formattedText = `Transaction Details on ${parsedContent.chain?.toUpperCase() || 'UNKNOWN'}:\n\n`;
                formattedText += `Hash: ${transaction.hash}\n`;
                formattedText += `Status: ${status}\n`;
                formattedText += `From: ${transaction.from.slice(0, 6)}...${transaction.from.slice(-4)}\n`;
                formattedText += `To: ${transaction.to.slice(0, 6)}...${transaction.to.slice(-4)}\n`;
                formattedText += `Value: ${value.toFixed(6)} ETH\n`;
                formattedText += `Gas Used: ${gasUsed.toLocaleString()}\n`;
                formattedText += `Gas Price: ${gasPrice.toFixed(2)} Gwei\n`;
                formattedText += `Block: ${blockNumber.toLocaleString()}\n`;
                formattedText += `Time: ${timestamp}`;

                if (callback) {
                    callback({
                        text: formattedText,
                        success: true,
                        data: response.data.result
                    } as GetTransactionsByHashContent);
                }

                return true;

            } catch (error) {
                logGranular("API request failed", { error });
                if (axios.isAxiosError(error)) {
                    throw new APIError(
                        `Failed to fetch transaction: ${error.message}`,
                        error.response?.status
                    );
                }
                throw new APIError("Failed to fetch transaction");
            }

        } catch (error) {
            logGranular("Handler execution failed", { error });

            if (callback) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
                callback({
                    text: `Error getting transaction: ${errorMessage}`,
                    success: false
                } as GetTransactionsByHashContent);
            }

            if (error instanceof ConfigurationError ||
                error instanceof ValidationError ||
                error instanceof APIError) {
                throw error;
            }

            throw new APIError("Failed to execute GET_TRANSACTIONS_BY_HASH_ANKR action");
        }
    }
};

export default actionGetTransactionsByHash;
