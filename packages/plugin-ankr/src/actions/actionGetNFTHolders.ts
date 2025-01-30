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
        elizaLogger.debug(`[GetNFTHolders] ${message}`, data);
        console.log(`[GetNFTHolders] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};
// ------------------------------------------------------------------------------------------------
// Granular Logger
// ------------------------------------------------------------------------------------------------

interface GetNFTHoldersContent extends Content {
    text: string;
    filters?: {
        blockchain?: string;  // Changed from string[] to single string
        contractAddress?: string;
        pageSize?: number;
        pageToken?: string;
    };
    success?: boolean;
    data?: {
        holders: Array<{
            holderAddress: string;
            balance: string;
            balanceRawInteger: string;
        }>;
        nextPageToken?: string;
        blockchain?: string;
        contractAddress?: string;
        tokenDecimals?: number;
        holdersCount?: number;
        syncStatus?: {
            timestamp: number;
            lag: string;
            status: string;
        };
    };
}

// ------------------------------------------------------------------------------------------------
// Core Action implementation
// ------------------------------------------------------------------------------------------------
export const actionGetNFTHolders: Action = {
    name: "GET_NFT_HOLDERS_ANKR",
    similes: ["FETCH_NFT_HOLDERS", "SHOW_NFT_HOLDERS", "VIEW_NFT_HOLDERS", "LIST_NFT_HOLDERS"],
    description: "Retrieve holders of specific NFTs on specified blockchain networks.",
    examples: [[
        {
            user: "user",
            content: {
                text: "Show me holders of NFT contract [contract]0x34d85c9cdeb23fa97cb08333b511ac86e1c4e258[/contract] on [chain]bsc[/chain]",
                filters: {
                    blockchain: "bsc",  // Changed from string[] to string
                    contractAddress: "0x34d85c9cdeb23fa97cb08333b511ac86e1c4e258",
                    pageSize: 5
                }
            } as GetNFTHoldersContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Here are the NFT holders:\n\n" +
                      "1. 0xabc...def1\n" +
                      "   Balance: 1.5\n" +
                      "   Raw Balance: 1500000000000000000\n\n" +
                      "2. 0xdef...789a\n" +
                      "   Balance: 2.0\n" +
                      "   Raw Balance: 2000000000000000000",
                success: true,
                data: {
                    holders: [{
                        holderAddress: "0xabcdef1234567890abcdef1234567890abcdef12",
                        balance: "1.5",
                        balanceRawInteger: "1500000000000000000"
                    }],
                    blockchain: "bsc",
                    contractAddress: "0xf307910A4c7bbc79691fD374889b36d8531B08e3",
                    tokenDecimals: 18,
                    holdersCount: 1000,
                    syncStatus: {
                        timestamp: 1737769593,
                        lag: "-2m",
                        status: "synced"
                    }
                }
            } as GetNFTHoldersContent
        } as ActionExample
    ]],
    // ------------------------------------------------------------------------------------------------
    // Core Validation implementation
    // ------------------------------------------------------------------------------------------------
    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        if (message.content?.type !== "GET_NFT_HOLDERS_ANKR") {
            return true;
        }

        logGranular("Validating GET_NFT_HOLDERS_ANKR action", {
            content: message.content
        });

        try {
            const content = message.content as GetNFTHoldersContent;

            if (!content.filters?.contractAddress) {
                throw new ValidationError("Contract address is required");
            }

            // Blockchain is optional, defaults to "eth"
            if (content.filters?.blockchain && typeof content.filters.blockchain !== 'string') {
                throw new ValidationError("Blockchain must be a string");
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
        logGranular("Executing GET_NFT_HOLDERS_ANKR action");

        try {
            const messageContent = message.content as GetNFTHoldersContent;
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
            validateRequiredFields(parsedContent, ['contract']);

            const requestParams = {
                blockchain: parsedContent.chain,
                contractAddress: parsedContent.contract,
                pageSize: messageContent.filters?.pageSize || 10,
                pageToken: messageContent.filters?.pageToken
            };

            console.log("Debug - API request parameters:", {
                params: requestParams,
                endpoint: endpoint
            });

            const response = await axios.post(
                endpoint,
                {
                    jsonrpc: "2.0",
                    method: "ankr_getNFTHolders",
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

            const result = response.data.result;
            const formattedText =
                `NFT Holders:
Total Holders: ${result.holders.length}

${result.holders.map((holderAddress: string, index: number) =>
    `${index + 1}. ${holderAddress}`
).join('\n')}

${result.nextPageToken ? 'More holders available. Use the page token to see more.\n' : ''}
${result.syncStatus ? `Sync Status:
Last Update: ${new Date(result.syncStatus.timestamp * 1000).toLocaleString()}
Lag: ${result.syncStatus.lag}
Status: ${result.syncStatus.status}` : ''}`;

            logGranular("Formatted response text", { formattedText });

            if (callback) {
                logGranular("Sending success callback with formatted text");
                callback({
                    text: formattedText,
                    success: true,
                    data: {
                        holders: result.holders.map((address: string) => ({
                            holderAddress: address,
                            balance: "1",  // Default values since not provided in response
                            balanceRawInteger: "1"
                        })),
                        nextPageToken: result.nextPageToken,
                        syncStatus: result.syncStatus
                    }
                } as GetNFTHoldersContent);
            }

            return true;

        } catch (error: unknown) {
            logGranular("Handler execution failed", { error });

            if (callback) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
                callback({
                    text: `Error getting NFT holders: ${errorMessage}`,
                    success: false
                } as GetNFTHoldersContent);
            }

            if (error instanceof ConfigurationError ||
                error instanceof ValidationError ||
                error instanceof APIError) {
                throw error;
            }

            throw new APIError("Failed to execute GET_NFT_HOLDERS_ANKR action");
        }
    }
};

export default actionGetNFTHolders;
