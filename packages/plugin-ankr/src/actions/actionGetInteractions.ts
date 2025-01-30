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
        elizaLogger.debug(`[GetInteractions] ${message}`, data);
        console.log(`[GetInteractions] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};
// ------------------------------------------------------------------------------------------------
// Granular Logger
// ------------------------------------------------------------------------------------------------

interface GetInteractionsContent extends Content {
    text: string;
    filters?: {
        blockchain?: string;  // Changed from string[] to string
        address?: string;     // Changed from walletAddress
        pageSize?: number;
        pageToken?: string;
    };
    success?: boolean;
    data?: {
        interactions: Array<{
            blockchain: string;
            transactionHash: string;
            blockNumber: number;
            timestamp: string;
            from: string;
            to: string;
            value: string;
            gasPrice: string;
            gasUsed: string;
            methodName?: string;
            logs: Array<{
                address: string;
                topics: string[];
                data: string;
                logIndex: number;
            }>;
        }>;
        nextPageToken?: string;
    };
}

interface AnkrAPIResponse {
    blockchains: string[];
    syncStatus: {
        timestamp: number;
        lag: string;
        status: string;
    };
}

// ------------------------------------------------------------------------------------------------
// Core Action implementation
// ------------------------------------------------------------------------------------------------
export const actionGetInteractions: Action = {
    name: "GET_INTERACTIONS_ANKR",
    similes: ["FETCH_INTERACTIONS", "SHOW_INTERACTIONS", "VIEW_INTERACTIONS", "LIST_INTERACTIONS"],
    description: "Retrieve interactions between wallets and smart contracts on specified blockchain networks.",
    examples: [[
        {
            user: "user",
            content: {
                text: "Show me interactions for the wallet [wallet]0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45[/wallet]",
                filters: {
                    blockchain: "eth",  // Changed from string[] to string
                    address: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
                    pageSize: 5,
                    pageToken: "eyJsYXN0X2Jsb2NrIjoiMTIzNDU2Nzg4IiwibGFzdF9pbnRlcmFjdGlvbl9pbmRleCI6IjEifQ=="
                }
            } as GetInteractionsContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Here are the recent interactions:\n\n" +
                      "1. Transfer (2024-03-15 14:30 UTC)\n" +
                      "   From: 0xabc...def1\n" +
                      "   To: 0x123...5678\n" +
                      "   Value: 1.5 ETH\n" +
                      "   Gas Used: 21,000\n" +
                      "   Tx Hash: 0xdef...789\n\n" +
                      "2. Approve (2024-03-15 14:25 UTC)\n" +
                      "   From: 0xabc...def1\n" +
                      "   To: 0x123...5678\n" +
                      "   Value: 0 ETH\n" +
                      "   Gas Used: 45,000\n" +
                      "   Tx Hash: 0x789...012",
                success: true,
                data: {
                    interactions: [{
                        blockchain: "eth",
                        transactionHash: "0xdef...789",
                        blockNumber: 17000100,
                        timestamp: "2024-03-15T14:30:00Z",
                        from: "0xabcdef1234567890abcdef1234567890abcdef12",
                        to: "0x1234567890abcdef1234567890abcdef12345678",
                        value: "1500000000000000000",
                        gasPrice: "20000000000",
                        gasUsed: "21000",
                        methodName: "transfer",
                        logs: [{
                            address: "0x1234567890abcdef1234567890abcdef12345678",
                            topics: ["0x000...123"],
                            data: "0x000...456",
                            logIndex: 0
                        }]
                    }]
                }
            } as GetInteractionsContent
        } as ActionExample
    ]],
    // ------------------------------------------------------------------------------------------------
    // Core Validation implementation
    // ------------------------------------------------------------------------------------------------
    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        if (message.content?.type !== "GET_INTERACTIONS_ANKR") {
            return true;
        }

        logGranular("Validating GET_INTERACTIONS_ANKR action", {
            content: message.content
        });

        try {
            const content = message.content as GetInteractionsContent;

            // Only wallet address is required based on the API
            if (!content.filters?.address) {
                throw new ValidationError("Wallet address is required");
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
        logGranular("Executing GET_INTERACTIONS_ANKR action");

        try {
            const messageContent = message.content as GetInteractionsContent;
            const parsedContent = parseAPIContent(messageContent.text);

            // Validate required fields
            validateRequiredFields(parsedContent, ['wallet']);

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

            // Prepare API request parameters
            const requestParams = {
                blockchain: parsedContent.chain || "eth",
                address: parsedContent.wallet,
                pageSize: messageContent.filters?.pageSize ?? 5,
                pageToken: messageContent.filters?.pageToken
            };

            try {
                const response = await axios.post<{
                    id: number;
                    jsonrpc: string;
                    result: AnkrAPIResponse;
                }>(
                    endpoint,
                    {
                        jsonrpc: "2.0",
                        method: "ankr_getInteractions",
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

                // Format the response text based on the sync status
                const formattedText = `Blockchain Status Information:

Available Blockchains: ${response.data.result.blockchains.join(', ')}
Sync Status: ${response.data.result.syncStatus.status}
Lag: ${response.data.result.syncStatus.lag}`;

                if (callback) {
                    callback({
                        text: formattedText,
                        success: true,
                        data: {
                            interactions: [],
                            syncStatus: response.data.result.syncStatus,
                            availableBlockchains: response.data.result.blockchains
                        }
                    } as GetInteractionsContent);
                }

                return true;

            } catch (error) {
                logGranular("API request failed", { error });
                if (axios.isAxiosError(error)) {
                    throw new APIError(
                        `Failed to fetch interactions data: ${error.message}`,
                        error.response?.status
                    );
                }
                throw new APIError("Failed to fetch interactions data");
            }

        } catch (error) {
            logGranular("Handler execution failed", { error });

            if (callback) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
                callback({
                    text: `Error getting interactions: ${errorMessage}`,
                    success: false
                } as GetInteractionsContent);
            }

            if (error instanceof ConfigurationError ||
                error instanceof ValidationError ||
                error instanceof APIError) {
                throw error;
            }

            throw new APIError("Failed to execute GET_INTERACTIONS_ANKR action");
        }
    },


};

export default actionGetInteractions;
