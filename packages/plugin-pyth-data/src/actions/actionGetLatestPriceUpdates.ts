import { type Action, elizaLogger } from "@elizaos/core";
import type { IAgentRuntime, Memory, State, HandlerCallback, Content, ActionExample } from "@elizaos/core";
// import { HermesClient } from "../hermes/HermesClient";
import { HermesClient } from "@pythnetwork/hermes-client";
import { DataError, ErrorSeverity, DataErrorCode } from "../error";
import { validatePythConfig, getNetworkConfig, getConfig } from "../environment";
import { validatePriceUpdatesData } from "../utils/priceUpdatesValidation";

// Get configuration for granular logging
const config = getConfig();
const GRANULAR_LOG = config.PYTH_GRANULAR_LOG;

// Enhanced logging helper
const logGranular = (message: string, data?: unknown) => {
    if (GRANULAR_LOG) {
        elizaLogger.info(`[PriceUpdates] ${message}`, data);
        console.log(`[PriceUpdates] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};

// Helper function to normalize price feed IDs
const normalizePriceFeedId = (id: string): string => {
    // Ensure 0x prefix and lowercase
    return id.toLowerCase().startsWith('0x') ? id.toLowerCase() : `0x${id.toLowerCase()}`;
};

// Helper function to format price feed ID for display
const formatPriceFeedId = (id: string): string => {
    // Add '0x' prefix if not present
    return id.toLowerCase().startsWith('0x') ? id.toLowerCase() : `0x${id.toLowerCase()}`;
};

interface GetLatestPriceUpdatesContent extends Content {
    text: string;
    priceIds: string[];
    options?: {
        encoding?: "hex" | "base64";
        parsed?: boolean;
    };
    success?: boolean;
    data?: {
        updates?: Array<{
            price_feed_id: string;
            price: number;
            conf: number;
            expo: number;
            publish_time: number;
            ema_price?: {
                price: number;
                conf: number;
                expo: number;
            };
        }>;
        error?: string;
    };
}

export const getLatestPriceUpdatesAction: Action = {
    name: "GET_LATEST_PRICE_UPDATES",
    similes: ["FETCH_LATEST_PRICES", "GET_CURRENT_PRICES", "CHECK_PRICE_FEED"],
    description: "Retrieve latest price updates from Pyth Network",
    examples: [[
        {
            user: "user",
            content: {
                text: "Get latest price updates for 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
                priceIds: ["0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43"],
                options: {
                    encoding: "base64",
                    parsed: true
                }
            } as GetLatestPriceUpdatesContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Here is the latest BTC/USD price",
                success: true,
                priceIds: ["0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43"],
                data: {
                    updates: [{
                        price_feed_id: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
                        price: 42000000000,
                        conf: 100000000,
                        expo: -8,
                        publish_time: 1641034800,
                        ema_price: {
                            price: 41950000000,
                            conf: 95000000,
                            expo: -8
                        }
                    }]
                }
            } as GetLatestPriceUpdatesContent
        } as ActionExample
    ]],

    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        // Check if this message is intended for this action
        if (message.content?.type !== "GET_LATEST_PRICE_UPDATES") {
            return true; // Skip validation for other actions
        }

        logGranular("Validating GET_LATEST_PRICE_UPDATES action", {
            content: message.content
        });

        try {
            const content = message.content as GetLatestPriceUpdatesContent;

            // Extract priceIds from text if not provided directly
            if (!content.priceIds && content.text) {
                const match = content.text.match(/([a-fA-F0-9]{64})/);
                if (match) {
                    content.priceIds = [formatPriceFeedId(match[1])];
                }
            }

            // Normalize all price feed IDs
            if (content.priceIds) {
                content.priceIds = content.priceIds.map(normalizePriceFeedId);
            }

            // Use the new validation function
            try {
                await validatePriceUpdatesData(content);
                logGranular("Schema validation passed");
            } catch (error) {
                logGranular("Schema validation failed", { error });
                if (error instanceof DataError) {
                    elizaLogger.error("Schema validation failed", {
                        errors: error.details?.errors
                    });
                    throw error;
                }
                throw new DataError(
                    DataErrorCode.VALIDATION_FAILED,
                    "Schema validation failed",
                    ErrorSeverity.HIGH,
                    { error }
                );
            }

            // Keep existing validation as additional checks
            if (!content.priceIds || !Array.isArray(content.priceIds)) {
                throw new DataError(
                    DataErrorCode.VALIDATION_FAILED,
                    "priceIds must be an array of strings",
                    ErrorSeverity.HIGH
                );
            }

            if (content.priceIds.length === 0) {
                throw new DataError(
                    DataErrorCode.VALIDATION_FAILED,
                    "priceIds array cannot be empty",
                    ErrorSeverity.HIGH
                );
            }

            // Validate each price ID is a valid hex string
            content.priceIds.forEach((id, index) => {
                const cleanId = id.startsWith('0x') ? id.slice(2) : id;
                if (!/^[0-9a-fA-F]{64}$/.test(cleanId)) {
                    throw new DataError(
                        DataErrorCode.VALIDATION_FAILED,
                        `Invalid price ID at index ${index}: ${id}. Must be a 64-character hex string`,
                        ErrorSeverity.HIGH
                    );
                }
            });

            // Validate options if provided
            if (content.options) {
                if (content.options.encoding && !["hex", "base64"].includes(content.options.encoding)) {
                    throw new DataError(
                        DataErrorCode.VALIDATION_FAILED,
                        "Invalid encoding option. Must be 'hex' or 'base64'",
                        ErrorSeverity.HIGH
                    );
                }
            }

            return true;
        } catch (error) {
            logGranular("Validation failed", { error });
            elizaLogger.error("Validation failed for GET_LATEST_PRICE_UPDATES", {
                error: error instanceof Error ? error.message : String(error)
            });
            return false;
        }
    },

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State,
        _options: { [key: string]: unknown } = {},
        callback?: HandlerCallback
    ): Promise<boolean> => {
        logGranular("Executing GET_LATEST_PRICE_UPDATES action");

        try {
            const messageContent = message.content as GetLatestPriceUpdatesContent;

            // Log the full message content
            logGranular("Message content received", messageContent);

            // Extract priceIds from text if not provided directly
            if (!messageContent.priceIds && messageContent.text) {
                const match = messageContent.text.match(/([a-fA-F0-9]{64})/);
                if (match) {
                    messageContent.priceIds = [formatPriceFeedId(match[1])];
                }
            }

            // Normalize all price feed IDs
            if (messageContent.priceIds) {
                messageContent.priceIds = messageContent.priceIds.map(normalizePriceFeedId);
            }

            const { priceIds, options = {} } = messageContent;

            // Log extracted values
            logGranular("Extracted values", {
                priceIds,
                options
            });

            // Get Pyth configuration
            const config = await validatePythConfig(runtime);
            if (!config) {
                throw new DataError(
                    DataErrorCode.VALIDATION_FAILED,
                    "Invalid Pyth configuration",
                    ErrorSeverity.HIGH
                );
            }

            // Get network configuration
            const networkConfig = getNetworkConfig(config.PYTH_NETWORK_ENV);
            const hermesClient = new HermesClient(networkConfig.hermes);

            logGranular("Initialized HermesClient", {
                endpoint: networkConfig.hermes
            });

            try {
                // Log the request details
                logGranular("Requesting price updates with params", {
                    priceIds,
                    options
                });

                // Get latest price updates
                const updates = await hermesClient.getLatestPriceUpdates(priceIds, {
                    parsed: true,
                    encoding: options?.encoding as "hex" | "base64" | undefined
                });

                // Log the raw response
                logGranular("Raw response from Hermes", {
                    updates
                });

                if (!updates || !updates.parsed) {
                    throw new Error("No updates received from Hermes");
                }

                logGranular("Successfully retrieved price updates", {
                    updates,
                    parsedCount: updates.parsed?.length
                });

                if (callback) {
                    const formattedText = updates.parsed?.map(update => {
                        const metadata = update.metadata;
                        const proofTime = metadata?.proof_available_time;
                        return `Price Feed: ${normalizePriceFeedId(update.id)}
Current Price: ${(Number(update.price.price) * Math.pow(10, update.price.expo)).toFixed(2)} USD
Confidence: ±${(Number(update.price.conf) * Math.pow(10, update.price.expo)).toFixed(2)} USD
EMA Price: ${(Number(update.ema_price.price) * Math.pow(10, update.ema_price.expo)).toFixed(2)} USD
EMA Confidence: ±${(Number(update.ema_price.conf) * Math.pow(10, update.ema_price.expo)).toFixed(2)} USD
Last Update: ${new Date(update.price.publish_time * 1000).toLocaleString()}${metadata ? `
Slot: ${metadata.slot}
Proof Available: ${proofTime ? new Date(proofTime * 1000).toLocaleString() : 'Not available'}` : ''}`;
                    }).join('\n\n');

                    callback({
                        text: formattedText,
                        success: true,
                        priceIds,
                        data: {
                            updates: updates.parsed?.map(update => ({
                                price_feed_id: normalizePriceFeedId(update.id),
                                price: Number(update.price.price),
                                conf: Number(update.price.conf),
                                expo: update.price.expo,
                                publish_time: update.price.publish_time,
                                ema_price: update.ema_price ? {
                                    price: Number(update.ema_price.price),
                                    conf: Number(update.ema_price.conf),
                                    expo: update.ema_price.expo
                                } : undefined,
                                metadata: update.metadata
                            }))
                        }
                    } as GetLatestPriceUpdatesContent);
                }

                return true;
            } catch (error) {
                logGranular("Failed to process price updates request", { error });
                if (callback) {
                    callback({
                        text: `Error retrieving price updates: ${error instanceof Error ? error.message : String(error)}`,
                        success: false,
                        priceIds,
                        data: {
                            error: error instanceof Error ? error.message : String(error)
                        }
                    } as GetLatestPriceUpdatesContent);
                }
                throw new DataError(
                    DataErrorCode.VALIDATION_FAILED,
                    "Failed to process price updates request",
                    ErrorSeverity.HIGH,
                    { originalError: error }
                );
            }
        } catch (error) {
            logGranular("Failed to get latest price updates", { error });
            throw new DataError(
                DataErrorCode.NETWORK_ERROR,
                "Failed to get latest price updates",
                ErrorSeverity.HIGH,
                { originalError: error }
            );
        }
    }
};

export default getLatestPriceUpdatesAction;
