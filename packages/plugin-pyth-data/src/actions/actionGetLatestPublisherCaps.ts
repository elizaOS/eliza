import { type Action, elizaLogger } from "@elizaos/core";
import type { IAgentRuntime, Memory, State, HandlerCallback, Content, ActionExample } from "@elizaos/core";
// import { HermesClient } from "../hermes/HermesClient";
import { HermesClient } from "@pythnetwork/hermes-client";
import { DataError, ErrorSeverity, DataErrorCode } from "../error";
import { validatePythConfig, getNetworkConfig, getConfig } from "../environment";
import { validatePublisherCapsData } from "../utils/publisherCapsValidation";

// Get configuration for granular logging
const config = getConfig();
const GRANULAR_LOG = config.PYTH_GRANULAR_LOG;

// Enhanced logging helper
const logGranular = (message: string, data?: unknown) => {
    if (GRANULAR_LOG) {
        elizaLogger.info(`[PublisherCaps] ${message}`, data);
        console.log(`[PublisherCaps] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};

interface GetLatestPublisherCapsContent extends Content {
    text: string;
    success?: boolean;
    data?: {
        caps?: Array<{
            publisher: string;
            cap: number;
            timestamp: number;
        }>;
        error?: string;
    };
}

export const getLatestPublisherCapsAction: Action = {
    name: "GET_LATEST_PUBLISHER_CAPS",
    similes: ["FETCH_PUBLISHER_CAPS", "GET_PUBLISHER_LIMITS", "CHECK_PUBLISHER_CAPS"],
    description: "Retrieve latest publisher caps from Pyth Network",
    examples: [[
        {
            user: "user",
            content: {
                text: "Get me all the latest publisher caps"
            } as GetLatestPublisherCapsContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Latest publisher caps",
                success: true,
                data: {
                    caps: [{
                        publisher: "0x1234567890abcdef1234567890abcdef12345678",
                        cap: 1000000,
                        timestamp: 1641034800
                    }]
                }
            } as GetLatestPublisherCapsContent
        } as ActionExample
    ]],

    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        // Check if this message is intended for this action
        if (message.content?.type !== "GET_LATEST_PUBLISHER_CAPS") {
            return true; // Skip validation for other actions
        }

        logGranular("Validating GET_LATEST_PUBLISHER_CAPS action", {
            content: message.content
        });

        try {
            const content = message.content as GetLatestPublisherCapsContent;

            // Use the new validation function
            try {
                await validatePublisherCapsData(content);
                logGranular("Publisher caps validation passed");
            } catch (error) {
                logGranular("Publisher caps validation failed", { error });
                if (error instanceof DataError) {
                    elizaLogger.error("Publisher caps validation failed", {
                        errors: error.details?.errors
                    });
                    throw error;
                }
                throw new DataError(
                    DataErrorCode.VALIDATION_FAILED,
                    "Publisher caps validation failed",
                    ErrorSeverity.HIGH,
                    { error }
                );
            }

            return true;
        } catch (error) {
            logGranular("Validation failed", { error });
            elizaLogger.error("Validation failed for GET_LATEST_PUBLISHER_CAPS", {
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
        logGranular("Executing GET_LATEST_PUBLISHER_CAPS action");

        try {
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

            // Initialize Hermes client
            const hermesClient = new HermesClient(networkConfig.hermes);

            logGranular("Initialized HermesClient", {
                endpoint: networkConfig.hermes
            });

            try {
                // Get publisher caps with options
                const response = await hermesClient.getLatestPublisherCaps({
                    parsed: true
                });

                if (!response.parsed?.[0]?.publisher_stake_caps) {
                    throw new DataError(
                        DataErrorCode.VALIDATION_FAILED,
                        "No publisher caps data found in response",
                        ErrorSeverity.HIGH
                    );
                }

                const publisherCaps = response.parsed[0].publisher_stake_caps;
                const currentTimestamp = Date.now();

                // Enhanced logging for each publisher cap
                publisherCaps.forEach((cap, index) => {
                    logGranular(`Publisher Cap ${index + 1}`, {
                        publisher: cap.publisher,
                        cap: cap.cap.toLocaleString(),
                        timestamp: new Date(currentTimestamp).toLocaleString()
                    });
                });

                logGranular("Successfully retrieved publisher caps", {
                    totalCaps: publisherCaps.length,
                    allCaps: publisherCaps.map(cap => ({
                        publisher: cap.publisher,
                        cap: cap.cap.toLocaleString(),
                        timestamp: new Date(currentTimestamp).toLocaleString()
                    }))
                });

                // Format the publisher caps into text
                const formattedText = publisherCaps
                    .map((cap, index) =>
                        `Publisher ${index + 1}:
ID: ${cap.publisher}
Cap: ${cap.cap.toLocaleString()} tokens
Timestamp: ${new Date(currentTimestamp).toLocaleString()}`
                    )
                    .join('\n\n');

                // Create callback content with formatted text
                if (callback) {
                    await callback({
                        text: `Retrieved ${publisherCaps.length} publisher caps:\n\n${formattedText}`,
                        success: true,
                        data: {
                            caps: publisherCaps.map(cap => ({
                                publisher: cap.publisher,
                                cap: cap.cap,
                                timestamp: currentTimestamp
                            }))
                        }
                    } as GetLatestPublisherCapsContent);
                }

                return true;
            } catch (error) {
                logGranular("Failed to process publisher caps request", { error });
                if (error instanceof DataError) {
                    throw error;
                }
                throw new DataError(
                    DataErrorCode.VALIDATION_FAILED,
                    "Failed to process publisher caps request",
                    ErrorSeverity.HIGH,
                    { originalError: error }
                );
            }
        } catch (error) {
            logGranular("Failed to get publisher caps", { error });
            if (error instanceof DataError) {
                throw error;
            }
            throw new DataError(
                DataErrorCode.NETWORK_ERROR,
                "Failed to get publisher caps",
                ErrorSeverity.HIGH,
                { originalError: error }
            );
        }
    }
};

export default getLatestPublisherCapsAction;
