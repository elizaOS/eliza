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
        elizaLogger.debug(`[GetTokenHolders] ${message}`, data);
        console.log(`[GetTokenHolders] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};

interface GetTokenHoldersContent extends Content {
    text: string;
    filters?: {
        blockchain?: string;
        contractAddress?: string;
        pageSize?: number;
        pageToken?: string;
    };
    success?: boolean;
    data?: {
        nextPageToken: string;
        blockchain: string;
        contractAddress: string;
        tokenDecimals: number;
        holders: Array<{
            holderAddress: string;
            balance: string;
            balanceRawInteger: string;
        }>;
        holdersCount: number;
        syncStatus: {
            timestamp: number;
            lag: string;
            status: string;
        };
    };
}

// Define holder type
type TokenHolder = {
    holderAddress: string;
    balance: string;
    balanceRawInteger: string;
};

export const actionGetTokenHolders: Action = {
    name: "GET_TOKEN_HOLDERS_ANKR",
    similes: ["LIST_HOLDERS", "SHOW_HOLDERS", "TOKEN_HOLDERS", "FIND_HOLDERS"],
    description: "Get a list of token holders for any ERC20 or ERC721 token contract.",
    examples: [[
        {
            user: "user",
            content: {
                text: "Show me holders for contract [contract]0xf307910A4c7bbc79691fD374889b36d8531B08e3[/contract] on [chain]bsc[/chain]",
            } as GetTokenHoldersContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Token Holders on BSC:\n" +
                      "Total Holders: 1,234\n\n" +
                      "1. 0xabcd...ef01\n" +
                      "   Balance: 1,000,000\n\n" +
                      "2. 0x1234...5678\n" +
                      "   Balance: 500,000\n\n" +
                      "3. 0x9876...4321\n" +
                      "   Balance: 250,000\n\n" +
                      "\nSync Status: completed (0s)",
                success: true,
                data: {
                    nextPageToken: "eyJsYXN0X2Jsb2NrIjoiMTIzNDU2Nzg4In0=",
                    blockchain: "bsc",
                    contractAddress: "0xf307910A4c7bbc79691fD374889b36d8531B08e3",
                    tokenDecimals: 18,
                    holders: [
                        {
                            holderAddress: "0xabcdef0123456789abcdef0123456789abcdef01",
                            balance: "1000000",
                            balanceRawInteger: "1000000000000000000000000"
                        },
                        {
                            holderAddress: "0x1234567890123456789012345678901234567890",
                            balance: "500000",
                            balanceRawInteger: "500000000000000000000000"
                        },
                        {
                            holderAddress: "0x9876543210987654321098765432109876543210",
                            balance: "250000",
                            balanceRawInteger: "250000000000000000000000"
                        }
                    ],
                    holdersCount: 1234,
                    syncStatus: {
                        timestamp: 1706093415,
                        lag: "0s",
                        status: "completed"
                    }
                }
            } as GetTokenHoldersContent
        } as ActionExample
    ]],

    // ------------------------------------------------------------------------------------------------
    // Core Validation implementation
    // ------------------------------------------------------------------------------------------------
    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        if (message.content?.type !== "GET_TOKEN_HOLDERS_ANKR") {
            return true;
        }

        logGranular("Validating GET_TOKEN_HOLDERS_ANKR action", {
            content: message.content
        });

        try {
            const content = message.content as GetTokenHoldersContent;
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

    // Fix the handler to use proper types
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State,
        _options: { [key: string]: unknown } = {},
        callback?: HandlerCallback
    ): Promise<boolean> => {
        logGranular("Executing GET_TOKEN_HOLDERS_ANKR action");

        try {
            const messageContent = message.content as GetTokenHoldersContent;
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
                        method: "ankr_getTokenHolders",
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
                const holders = result.holders as Array<{
                    holderAddress: string;
                    balance: string;
                    balanceRawInteger: string;
                }>;

                // Format the response text
                let formattedText = `Token Holders on ${parsedContent.chain?.toUpperCase() || 'UNKNOWN'}:\n`;
                formattedText += `Total Holders: ${result.holdersCount.toLocaleString()}\n\n`;

                holders.forEach((holder: TokenHolder, index: number) => {
                    const balance = Number(holder.balance).toLocaleString();
                    formattedText += `${index + 1}. ${holder.holderAddress.slice(0, 6)}...${holder.holderAddress.slice(-4)}\n`;
                    formattedText += `   Balance: ${balance}\n\n`;
                });

                if (result.syncStatus) {
                    formattedText += `\nSync Status: ${result.syncStatus.status} (${result.syncStatus.lag})\n`;
                }

                if (callback) {
                    logGranular("Sending success callback with formatted text", { formattedText });
                    callback({
                        text: formattedText,
                        success: true,
                        data: result
                    } as GetTokenHoldersContent);
                }

                return true;

            } catch (error) {
                logGranular("API request failed", { error });
                if (axios.isAxiosError(error)) {
                    throw new APIError(
                        `Failed to fetch token holders: ${error.message}`,
                        error.response?.status
                    );
                }
                throw new APIError("Failed to fetch token holders");
            }

        } catch (error) {
            logGranular("Handler execution failed", { error });

            if (callback) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
                callback({
                    text: `Error getting token holders: ${errorMessage}`,
                    success: false
                } as GetTokenHoldersContent);
            }

            if (error instanceof ConfigurationError ||
                error instanceof ValidationError ||
                error instanceof APIError) {
                throw error;
            }

            throw new APIError("Failed to execute GET_TOKEN_HOLDERS_ANKR action");
        }
    }
};

export default actionGetTokenHolders;
