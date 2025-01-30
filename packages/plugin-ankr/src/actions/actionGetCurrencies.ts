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
        elizaLogger.debug(`[GetCurrencies] ${message}`, data);
        console.log(`[GetCurrencies] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};
// ------------------------------------------------------------------------------------------------
// Granular Logger
// ------------------------------------------------------------------------------------------------

interface GetCurrenciesContent extends Content {
    text: string;
    filters?: {
        blockchain?: string;
        pageSize?: number;
        pageToken?: string;
    };
    success?: boolean;
    data?: {
        currencies: Array<{
            blockchain: string;
            address: string;
            name: string;
            symbol: string;
            decimals: number;
            thumbnail?: string;
        }>;
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
export const actionGetCurrencies: Action = {
    name: "GET_CURRENCIES_ANKR",
    similes: ["LIST_CURRENCIES", "SHOW_CURRENCIES", "VIEW_CURRENCIES", "FETCH_CURRENCIES"],
    description: "Retrieve information about currencies on specified blockchain networks.",
    examples: [[
        {
            user: "user",
            content: {
                text: "Show me the top currencies on [chain]eth[/chain]",
                filters: {
                    blockchain: "eth",
                    pageSize: 5,
                    pageToken: "eyJsYXN0X2JhbGFuY2UiOiIyIn0="
                }
            } as GetCurrenciesContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Here are the top currencies on Ethereum:\n\n" +
                      "1. Ethereum (ETH)\n" +
                      "   Market Cap: $250B\n" +
                      "   Holders: 2.5M\n" +
                      "   Total Supply: 120.5M ETH\n\n" +
                      "2. USD Coin (USDC)\n" +
                      "   Contract: 0xa0b8...c4d5\n" +
                      "   Market Cap: $45B\n" +
                      "   Holders: 1.2M\n" +
                      "   Total Supply: 45B USDC",
                success: true,
                data: {
                    currencies: [
                        {
                            blockchain: "eth",
                            address: "0x0000000000000000000000000000000000000000",
                            name: "Ethereum",
                            symbol: "ETH",
                            decimals: 18
                        }
                    ]
                }
            } as GetCurrenciesContent
        } as ActionExample
    ]],

    // ------------------------------------------------------------------------------------------------
    // Core Validation implementation
    // ------------------------------------------------------------------------------------------------
    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        if (message.content?.type !== "GET_CURRENCIES_ANKR") {
            return true;
        }

        logGranular("Validating GET_CURRENCIES_ANKR action", {
            content: message.content
        });

        try {
            const content = message.content as GetCurrenciesContent;

            if (!content.filters?.blockchain) {
                throw new ValidationError("Blockchain is required");
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
        logGranular("Executing GET_CURRENCIES_ANKR action");

        try {
            const messageContent = message.content as GetCurrenciesContent;
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
                hasChain: !!parsedContent.chain,
                chain: parsedContent.chain,
                matches: parsedContent.raw.matches
            });

            // Validate required fields
            validateRequiredFields(parsedContent, ['chain']);

            // Prepare API request parameters
            const requestParams = {
                blockchain: parsedContent.chain,
                pageSize: messageContent.filters?.pageSize ?? 5
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
                        method: "ankr_getCurrencies",
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

                const currencies = response.data.result.currencies;

                // Format the response text
                let formattedText = `Here are the top currencies from ${parsedContent.chain ? parsedContent.chain[0].toUpperCase() : 'Unknown Chain'}:\n\n`;

                let index = 0;
                for (const currency of currencies) {
                    formattedText += [
                        `${index + 1}. ${currency.name} (${currency.symbol})`,
                        currency.address ? `   Contract: ${currency.address.slice(0, 6)}...${currency.address.slice(-4)}` : '',
                        `   Decimals: ${currency.decimals}`,
                        currency.thumbnail ? `   Logo: ${currency.thumbnail}` : '',
                        '',
                        ''
                    ].filter(Boolean).join('\n');
                    index++;
                }

                if (callback) {
                    logGranular("Sending success callback with formatted text", { formattedText });
                    callback({
                        text: formattedText,
                        success: true,
                        data: {
                            currencies,
                            syncStatus: response.data.result.syncStatus
                        }
                    } as GetCurrenciesContent);
                }

                return true;

            } catch (error) {
                logGranular("API request failed", { error });
                if (axios.isAxiosError(error)) {
                    throw new APIError(
                        `Failed to fetch currencies data: ${error.message}`,
                        error.response?.status
                    );
                }
                throw new APIError("Failed to fetch currencies data");
            }

        } catch (error) {
            logGranular("Handler execution failed", { error });

            if (callback) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
                callback({
                    text: `Error getting currencies: ${errorMessage}`,
                    success: false
                } as GetCurrenciesContent);
            }

            if (error instanceof ConfigurationError ||
                error instanceof ValidationError ||
                error instanceof APIError) {
                throw error;
            }

            throw new APIError("Failed to execute GET_CURRENCIES_ANKR action");
        }
    }
};

export default actionGetCurrencies;
