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
        elizaLogger.debug(`[GetTokenHoldersCount] ${message}`, data);
        console.log(`[GetTokenHoldersCount] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};

interface GetTokenHoldersCountContent extends Content {
    text: string;
    filters?: {
        blockchain?: string;
        contractAddress?: string;
    };
    success?: boolean;
    data?: {
        blockchain: string;
        contractAddress: string;
        tokenDecimals: number;
        holderCountHistory: Array<{
            holderCount: number;
            totalAmount: string;
            totalAmountRawInteger: string;
            lastUpdatedAt: string;
        }>;
        latestHoldersCount: number;
        syncStatus: {
            timestamp: number;
            lag: string;
            status: string;
        };
    };
}

export const actionGetTokenHoldersCount: Action = {
    name: "GET_TOKEN_HOLDERS_COUNT_ANKR",
    similes: ["COUNT_HOLDERS", "TOTAL_HOLDERS", "HOLDERS_COUNT", "NUMBER_OF_HOLDERS"],
    description: "Get the total number of holders and historical data for a specific token.",
    // Fix the example data to match the interface
    examples: [[
        {
            user: "user",
            content: {
                text: "How many holders does [contract]0xdAC17F958D2ee523a2206206994597C13D831ec7[/contract] have? [chain]eth[/chain]",
                filters: {
                    blockchain: "eth",
                    contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7"
                }
            } as GetTokenHoldersCountContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Token Holders Count on ETH:\n\n" +
                      "Current Holders: 500,000\n\n" +
                      "Historical Data:\n" +
                      "1. 1/24/2024\n" +
                      "   Holders: 500,000\n" +
                      "   Total Amount: 1,000,000\n\n" +
                      "Sync Status: completed (0s)",
                success: true,
                data: {
                    blockchain: "eth",
                    contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
                    tokenDecimals: 18,
                    holderCountHistory: [
                        {
                            holderCount: 500000,
                            totalAmount: "1000000",
                            totalAmountRawInteger: "1000000000000000000000000",
                            lastUpdatedAt: "2024-01-24T10:30:15Z"
                        }
                    ],
                    latestHoldersCount: 500000,
                    syncStatus: {
                        timestamp: 1706093415,
                        lag: "0s",
                        status: "completed"
                    }
                }
            } as GetTokenHoldersCountContent
        } as ActionExample
    ]],
    // ------------------------------------------------------------------------------------------------
    // Core Validation implementation
    // ------------------------------------------------------------------------------------------------
    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        if (message.content?.type !== "GET_TOKEN_HOLDERS_COUNT_ANKR") {
            return true;
        }

        logGranular("Validating GET_TOKEN_HOLDERS_COUNT_ANKR action", {
            content: message.content
        });

        try {
            const content = message.content as GetTokenHoldersCountContent;
            const parsedContent = parseAPIContent(content.text);

            if (!parsedContent.chain || !parsedContent.contract) {
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
        logGranular("Executing GET_TOKEN_HOLDERS_COUNT_ANKR action");

        try {
            const messageContent = message.content as GetTokenHoldersCountContent;
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
            // Parse the prompt using our API content parser
            const parsedContent = parseAPIContent(messageContent.text);
            console.log("Debug - Parsed API content:", {
                hasContract: !!parsedContent.contract,
                hasChain: !!parsedContent.chain,
                contract: parsedContent.contract,
                chain: parsedContent.chain,
                matches: parsedContent.raw.matches
            });

            // Validate required fields
            validateRequiredFields(parsedContent, ['contract', 'chain']);

            // Prepare API request parameters
            const requestParams = {
                blockchain: parsedContent.chain,
                contractAddress: parsedContent.contract,
                pageSize: 10
            };

            try {
                const response = await axios.post(
                    endpoint,
                    {
                        jsonrpc: "2.0",
                        method: "ankr_getTokenHoldersCount",
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

                const result = response.data.result;

                // Format the response text
                let formattedText = `Token Holders Count on ${parsedContent.chain?.toUpperCase() || 'UNKNOWN'}:\n\n`;
                formattedText += `Current Holders: ${result.latestHoldersCount.toLocaleString()}\n\n`;
                formattedText += "Historical Data:\n";

                result.holderCountHistory.forEach((history: {
                    holderCount: number;
                    totalAmount: string;
                    totalAmountRawInteger: string;
                    lastUpdatedAt: string;
                }, index: number) => {
                    const date = new Date(history.lastUpdatedAt).toLocaleDateString();
                    formattedText += `
${index + 1}. ${date}
   Holders: ${history.holderCount.toLocaleString()}
   Total Amount: ${Number(history.totalAmount).toLocaleString()}`;
                });

                if (result.syncStatus) {
                    formattedText += `

Sync Status: ${result.syncStatus.status} (${result.syncStatus.lag})`;
                }

                if (callback) {
                    logGranular("Sending success callback with formatted text", { formattedText });
                    callback({
                        text: formattedText,
                        success: true,
                        data: result
                    } as GetTokenHoldersCountContent);
                }

                return true;

            } catch (error) {
                logGranular("API request failed", { error });
                if (axios.isAxiosError(error)) {
                    throw new APIError(
                        `Failed to fetch token holders count: ${error.message}`,
                        error.response?.status
                    );
                }
                throw new APIError("Failed to fetch token holders count");
            }

        } catch (error) {
            logGranular("Handler execution failed", { error });

            if (callback) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
                callback({
                    text: `Error getting token holders count: ${errorMessage}`,
                    success: false
                } as GetTokenHoldersCountContent);
            }

            if (error instanceof ConfigurationError ||
                error instanceof ValidationError ||
                error instanceof APIError) {
                throw error;
            }

            throw new APIError("Failed to execute GET_TOKEN_HOLDERS_COUNT_ANKR action");
        }
    }
};

export default actionGetTokenHoldersCount;
