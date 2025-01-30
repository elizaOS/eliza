import { Action, elizaLogger } from "@elizaos/core";
import { IAgentRuntime, Memory, State, HandlerCallback, Content, ActionExample } from "@elizaos/core";
import axios from 'axios';
import { getConfig, validateHyperbolicConfig, HYPERBOLIC_ENDPOINTS } from '../environment';
import { APIError, ConfigurationError, ValidationError } from '../error/base';
import { Decimal } from 'decimal.js';

// Get configuration for granular logging
const config = getConfig();
const GRANULAR_LOG = config.HYPERBOLIC_GRANULAR_LOG;

// Enhanced logging helper
const logGranular = (message: string, data?: unknown) => {
    if (GRANULAR_LOG) {
        elizaLogger.info(`[GetSpendHistory] ${message}`, data);
        console.log(`[GetSpendHistory] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};

interface SpendHistoryEntry {
    timestamp: string;
    amount: number;
    currency: string;
    description: string;
    instanceId?: string;
}

interface GetSpendHistoryContent extends Content {
    text: string;
    startDate?: string;
    endDate?: string;
    currency?: string;
    success?: boolean;
    data?: {
        history?: SpendHistoryEntry[];
        totalSpend?: number;
        error?: string;
    };
}

export const actionGetSpendHistory: Action = {
    name: "GET_HB_SPEND_HISTORY",
    similes: ["CHECK_SPENDING", "VIEW_EXPENSES", "SPENDING_HISTORY", "COST_HISTORY"],
    description: "Get the spending history for your Hyperbolic account, optionally filtered by date range and currency.",
    examples: [[
        {
            user: "user",
            content: {
                text: "Show my spending history on Hyperbolic"
            } as GetSpendHistoryContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Here's your spending history for the last 30 days:\n\nTotal Spend: $2,500\n\nBreakdown by Service:\n- GPU Compute: $2,000 (80%)\n- Storage: $300 (12%)\n- Network: $200 (8%)\n\nTop Instances:\n1. RTX 4090 Instance (gpu-123): $1,200\n2. A100 Instance (gpu-456): $800\n3. Storage Volume (vol-789): $300",
                success: true,
                data: {
                    totalSpend: 2500,
                    breakdown: {
                        compute: 2000,
                        storage: 300,
                        network: 200
                    },
                    topInstances: [
                        {
                            id: "gpu-123",
                            name: "RTX 4090 Instance",
                            spend: 1200
                        },
                        {
                            id: "gpu-456",
                            name: "A100 Instance",
                            spend: 800
                        },
                        {
                            id: "vol-789",
                            name: "Storage Volume",
                            spend: 300
                        }
                    ]
                }
            } as GetSpendHistoryContent
        } as ActionExample
    ], [
        {
            user: "user",
            content: {
                text: "Get my spending for the last week",
                days: 7
            } as GetSpendHistoryContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Here's your spending history for the last 7 days:\n\nTotal Spend: $800\n\nBreakdown by Service:\n- GPU Compute: $650 (81.25%)\n- Storage: $100 (12.5%)\n- Network: $50 (6.25%)\n\nTop Instances:\n1. RTX 4090 Instance (gpu-123): $400\n2. A100 Instance (gpu-456): $250\n3. Storage Volume (vol-789): $100",
                success: true,
                data: {
                    totalSpend: 800,
                    breakdown: {
                        compute: 650,
                        storage: 100,
                        network: 50
                    },
                    topInstances: [
                        {
                            id: "gpu-123",
                            name: "RTX 4090 Instance",
                            spend: 400
                        },
                        {
                            id: "gpu-456",
                            name: "A100 Instance",
                            spend: 250
                        },
                        {
                            id: "vol-789",
                            name: "Storage Volume",
                            spend: 100
                        }
                    ]
                }
            } as GetSpendHistoryContent
        } as ActionExample
    ]],

    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        if (message.content?.type !== "GET_HB_SPEND_HISTORY") {
            return true;
        }

        logGranular("Validating GET_HB_SPEND_HISTORY action", {
            content: message.content
        });

        try {
            const content = message.content as GetSpendHistoryContent;

            // Validate date formats if provided
            if (content.startDate && !/^\d{4}-\d{2}-\d{2}$/.test(content.startDate)) {
                throw new ValidationError("Start date must be in YYYY-MM-DD format");
            }
            if (content.endDate && !/^\d{4}-\d{2}-\d{2}$/.test(content.endDate)) {
                throw new ValidationError("End date must be in YYYY-MM-DD format");
            }

            // Validate currency if provided
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
        logGranular("Executing GET_HB_SPEND_HISTORY action");
            // ------------------------------------------------------------------------------------------------
            // Core spend history logic
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

            const content = message.content as GetSpendHistoryContent;
            logGranular("Processing request", {
                startDate: content.startDate,
                endDate: content.endDate,
                currency: content.currency
            });


            try {
                const response = await axios.get(
                    HYPERBOLIC_ENDPOINTS[config.HYPERBOLIC_ENV].history,
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${apiKey}`
                        },
                        params: {
                            start_date: content.startDate,
                            end_date: content.endDate,
                            currency: content.currency
                        }
                    }
                );

                logGranular("Received response from API", {
                    statusCode: response.status,
                    dataLength: response.data.purchase_history?.length
                });

                const history = response.data.purchase_history || [];
                const totalSpend = history.reduce((sum: number, entry: SpendHistoryEntry) =>
                    sum + (entry.amount || 0), 0) / 100; // Convert to dollars

                // Format date ranges for display
                const dateRange = content.startDate && content.endDate
                    ? ` (${content.startDate} - ${content.endDate})`
                    : '';

                // Format currency prefix/suffix
                const currencyPrefix = content.currency ? `${content.currency} ` : '$';

                // Format history entries
                const historyText = history.length > 0 ? history
                    .map((entry: SpendHistoryEntry, index: number) => {
                        const date = new Date(entry.timestamp).toLocaleDateString('en-US', {
                            year: 'numeric',
                            month: 'short',
                            day: '2-digit'
                        });
                        const amount = new Decimal(entry.amount).dividedBy(100).toFixed(2);
                        return `${index + 1}. ${date}: ${currencyPrefix}${amount} - ${entry.description}`;
                    })
                    .join('\n') : 'No purchase history available.';

                const formattedText = `${content.currency || 'Spending'} History${dateRange}:

${historyText}

${history.length > 0 ? `Total Spend: ${currencyPrefix}${totalSpend.toFixed(2)}` : ''}`;
            // ------------------------------------------------------------------------------------------------
            // End core logic
            // ------------------------------------------------------------------------------------------------

                if (callback) {
                    logGranular("Sending success callback");
                    callback({
                        text: formattedText,
                        success: true,
                        data: {
                            history,
                            totalSpend
                        }
                    } as GetSpendHistoryContent);
                }

                return true;

            } catch (error) {
                logGranular("API request failed", { error });
                if (axios.isAxiosError(error)) {
                    throw new APIError(
                        `Failed to fetch spend history: ${error.message}`,
                        error.response?.status
                    );
                }
                throw new APIError("Failed to fetch spend history");
            }


        } catch (error) {
            logGranular("Handler execution failed", { error });

            if (callback) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
                callback({
                    text: `Error getting spend history: ${errorMessage}`,
                    success: false,
                    data: {
                        error: errorMessage
                    }
                } as GetSpendHistoryContent);
            }

            if (error instanceof ConfigurationError ||
                error instanceof ValidationError ||
                error instanceof APIError) {
                throw error;
            }

            throw new APIError("Failed to execute GET_HB_SPEND_HISTORY action");
        }
    }
};

export default actionGetSpendHistory;
