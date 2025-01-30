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
        elizaLogger.debug(`[GetBlockchainStats] ${message}`, data);
        console.log(`[GetBlockchainStats] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};
// ------------------------------------------------------------------------------------------------
// Granular Logger
// ------------------------------------------------------------------------------------------------

interface GetBlockchainStatsContent extends Content {
    text: string;
    filters?: {
        blockchain?: string[];
    };
    success?: boolean;
    data?: {
        stats: Array<{
            blockchain: string;
            latestBlock: number;
            totalTransactions: string;
            totalAccounts: string;
            tps: number;
            gasPrice: string;
            marketCap: string;
            totalValueLocked: string;
        }>;
    };
}

// Update the interface to match actual API response
interface AnkrBlockchainStats {
    blockchain: string;
    totalTransactionsCount: number;
    totalEventsCount: number;
    latestBlockNumber: number;
    blockTimeMs: number;
    nativeCoinUsdPrice: string;
}

// ------------------------------------------------------------------------------------------------
// Core Action implementation
// ------------------------------------------------------------------------------------------------
export const actionGetBlockchainStats: Action = {
    name: "GET_BLOCKCHAIN_STATS_ANKR",
    similes: ["CHAIN_STATS", "BLOCKCHAIN_INFO", "NETWORK_STATS", "CHAIN_METRICS"],
    description: "Retrieve statistical information about specified blockchain networks.",
    examples: [[
        {
            user: "user",
            content: {
                text: "Show me stats for [chain]eth[/chain] blockchain",
                filters: {
                    blockchain: ["eth"]
                }
            } as GetBlockchainStatsContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Here are the current statistics for Ethereum:\n\n" +
                      "Latest Block: 19,234,567\n" +
                      "Total Transactions: 2.5B\n" +
                      "Active Accounts: 245M\n" +
                      "TPS: 15.5\n" +
                      "Gas Price: 25 Gwei\n" +
                      "Market Cap: $250B\n" +
                      "Total Value Locked: $45B",
                success: true,
                data: {
                    stats: [{
                        blockchain: "eth",
                        latestBlock: 19234567,
                        totalTransactions: "2500000000",
                        totalAccounts: "245000000",
                        tps: 15.5,
                        gasPrice: "25000000000",
                        marketCap: "250000000000",
                        totalValueLocked: "45000000000"
                    }]
                }
            } as GetBlockchainStatsContent
        } as ActionExample
    ]],
    // ------------------------------------------------------------------------------------------------
    // Core Validation implementation
    // ------------------------------------------------------------------------------------------------
    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        if (message.content?.type !== "GET_BLOCKCHAIN_STATS_ANKR") {
            return true;
        }

        logGranular("Validating GET_BLOCKCHAIN_STATS_ANKR action", {
            content: message.content
        });

        try {
            const content = message.content as GetBlockchainStatsContent;

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
        logGranular("Executing GET_BLOCKCHAIN_STATS_ANKR action");

        try {
            const messageContent = message.content as GetBlockchainStatsContent;
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
                hasChain: !!parsedContent.chain,
                chain: parsedContent.chain,
                matches: parsedContent.raw.matches
            });

            // Validate required fields
            validateRequiredFields(parsedContent, ['chain']);

            // Prepare API request parameters
            const requestParams = {
                blockchain: parsedContent.chain  // Changed from array to string
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
                        method: "ankr_getBlockchainStats",
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

                const stats = response.data.result.stats;

                // Format the response text
                let formattedText = "";
                for (const stat of stats) {
                    formattedText += `Statistics for ${stat.blockchain.toUpperCase()}:\n\n`;
                    formattedText += `Latest Block: ${stat.latestBlockNumber.toLocaleString()}\n`;
                    formattedText += `Total Transactions: ${(stat.totalTransactionsCount / 1e9).toFixed(1)}B\n`;
                    formattedText += `Total Events: ${(stat.totalEventsCount / 1e9).toFixed(1)}B\n`;
                    formattedText += `Block Time: ${(stat.blockTimeMs / 1000).toFixed(1)} seconds\n`;
                    formattedText += `Native Coin Price: $${Number(stat.nativeCoinUsdPrice).toFixed(2)}\n\n`;
                }

                // Update callback data structure to match new format
                if (callback) {
                    logGranular("Sending success callback with formatted text", { formattedText });
                    callback({
                        text: formattedText,
                        success: true,
                        data: {
                            stats: stats.map((stat: AnkrBlockchainStats) => ({
                                blockchain: stat.blockchain,
                                latestBlock: stat.latestBlockNumber,
                                totalTransactions: stat.totalTransactionsCount.toString(),
                                totalEvents: stat.totalEventsCount.toString(),
                                blockTime: stat.blockTimeMs / 1000,
                                nativeCoinPrice: stat.nativeCoinUsdPrice
                            }))
                        }
                    } as GetBlockchainStatsContent);
                }

                return true;

            } catch (error) {
                logGranular("API request failed", { error });
                if (axios.isAxiosError(error)) {
                    throw new APIError(
                        `Failed to fetch blockchain stats: ${error.message}`,
                        error.response?.status
                    );
                }
                throw new APIError("Failed to fetch blockchain stats");
            }

        } catch (error) {
            logGranular("Handler execution failed", { error });

            if (callback) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
                callback({
                    text: `Error getting blockchain stats: ${errorMessage}`,
                    success: false
                } as GetBlockchainStatsContent);
            }

            if (error instanceof ConfigurationError ||
                error instanceof ValidationError ||
                error instanceof APIError) {
                throw error;
            }

            throw new APIError("Failed to execute GET_BLOCKCHAIN_STATS_ANKR action");
        }
    }
};

export default actionGetBlockchainStats;
