import { Action, elizaLogger } from "@elizaos/core";
import { IAgentRuntime, Memory, State, HandlerCallback, Content, ActionExample } from "@elizaos/core";
import axios from 'axios';
import { Decimal } from 'decimal.js';
import { getConfig, validateHyperbolicConfig, HYPERBOLIC_ENDPOINTS } from '../environment';
import { APIError, ConfigurationError, ValidationError } from '../error/base';

// Get configuration for granular logging
const config = getConfig();
const GRANULAR_LOG = config.HYPERBOLIC_GRANULAR_LOG;

// Enhanced logging helper
const logGranular = (message: string, data?: unknown) => {
    if (GRANULAR_LOG) {
        elizaLogger.info(`[GetCurrentBalance] ${message}`, data);
        console.log(`[GetCurrentBalance] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};

interface GetCurrentBalanceContent extends Content {
    text: string;
    currency?: string;
    success?: boolean;
    data?: {
        balances?: {
            [key: string]: string;
        };
        error?: string;
    };
}

export const actionGetCurrentBalance: Action = {
    name: "GET_HB_CURRENT_BALANCE",
    similes: ["CHECK_BALANCE", "SHOW_BALANCE", "VIEW_BALANCE", "BALANCE_CHECK"],
    description: "Get the current balance of your Hyperbolic account in USD and crypto currencies.",
    examples: [[
        {
            user: "user",
            content: {
                text: "Show my current balance on Hyperbolic"
            } as GetCurrentBalanceContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Your current balances are:\nUSD: $1,000.00\nETH: 0.5\nBTC: 0.01",
                success: true,
                data: {
                    balances: {
                        USD: "1000.00",
                        ETH: "0.5",
                        BTC: "0.01"
                    }
                }
            } as GetCurrentBalanceContent
        } as ActionExample
    ], [
        {
            user: "user",
            content: {
                text: "Get my ETH balance",
                currency: "ETH"
            } as GetCurrentBalanceContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Your ETH balance is: 0.5 ETH",
                success: true,
                data: {
                    balances: {
                        ETH: "0.5"
                    }
                }
            } as GetCurrentBalanceContent
        } as ActionExample
    ]],

    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        if (message.content?.type !== "GET_CURRENT_BALANCE") {
            return true;
        }

        logGranular("Validating GET_CURRENT_BALANCE action", {
            content: message.content
        });

        try {
            const content = message.content as GetCurrentBalanceContent;

            if (content.currency && typeof content.currency !== 'string') {
                throw new ValidationError("Currency must be a string");
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

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State,
        _options: { [key: string]: unknown } = {},
        callback?: HandlerCallback
    ): Promise<boolean> => {
        logGranular("Executing GET_CURRENT_BALANCE action");
            // ------------------------------------------------------------------------------------------------
            // Core balance check logic
            // ------------------------------------------------------------------------------------------------
        try {
            const config = await validateHyperbolicConfig(runtime);
            console.log("Debug - Config validated:", {
                hasApiKey: !!config.HYPERBOLIC_API_KEY,
                env: config.HYPERBOLIC_ENV
            });

            const apiKey = config.HYPERBOLIC_API_KEY;
            if (!apiKey) {
                throw new ConfigurationError("HYPERBOLIC_API_KEY not found in environment variables");
            }

            const content = message.content as GetCurrentBalanceContent;
            logGranular("Processing request", { currency: content.currency });


            try {
                const response = await axios.get(
                    HYPERBOLIC_ENDPOINTS[config.HYPERBOLIC_ENV].balance,
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${apiKey}`
                        },
                        params: content.currency ? { currency: content.currency } : undefined
                    }
                );

                logGranular("Received response from API", {
                    statusCode: response.status,
                    dataLength: Object.keys(response.data).length
                });

                // Format balances using Decimal.js for precision
                const balances: { [key: string]: string } = {};
                for (const [key, value] of Object.entries(response.data)) {
                    if (typeof value === 'number') {
                        balances[key] = new Decimal(value).dividedBy(100).toFixed(2);
                    }
                }

                // Format text response
                const formattedText = Object.entries(balances)
                    .map(([currency, amount]) => `${currency}: ${amount}`)
                    .join('\n');

                if (callback) {
                    logGranular("Sending success callback with formatted text", { formattedText });
                    callback({
                        text: `Your current balances are:\n${formattedText}`,
                        success: true,
                        data: {
                            balances
                        }
                    } as GetCurrentBalanceContent);
                }

                return true;

            } catch (error) {
                logGranular("API request failed", { error });
                if (axios.isAxiosError(error)) {
                    throw new APIError(
                        `Failed to fetch balance data: ${error.message}`,
                        error.response?.status
                    );
                }
                throw new APIError("Failed to fetch balance data");
            }
            // ------------------------------------------------------------------------------------------------
            // End core logic
            // ------------------------------------------------------------------------------------------------

        } catch (error) {
            logGranular("Handler execution failed", { error });

            if (callback) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
                callback({
                    text: `Error getting current balance: ${errorMessage}`,
                    success: false,
                    data: {
                        error: errorMessage
                    }
                } as GetCurrentBalanceContent);
            }

            if (error instanceof ConfigurationError ||
                error instanceof ValidationError ||
                error instanceof APIError) {
                throw error;
            }

            throw new APIError("Failed to execute GET_CURRENT_BALANCE action");
        }
    }
};

export default actionGetCurrentBalance;
