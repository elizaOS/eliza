import { type Action, elizaLogger } from "@elizaos/core";
import type { IAgentRuntime, Memory, State, HandlerCallback, Content, ActionExample } from "@elizaos/core";
import { HermesClient } from "@pythnetwork/hermes-client";
import { DataError, ErrorSeverity, DataErrorCode } from "../error";
import { validatePythConfig, getNetworkConfig, getConfig } from "../environment";
import { validatePriceUpdateStreamData } from "../utils/priceUpdateStreamValidation";

// Get configuration for granular logging
const config = getConfig();
const GRANULAR_LOG = config.PYTH_GRANULAR_LOG;
const PYTH_MAX_PRICE_STREAMS = Number(config.PYTH_MAX_PRICE_STREAMS);

// Track active streams
const activeStreams = new Map<string, EventSource>();

// Enhanced logging helper
const logGranular = (message: string, data?: unknown) => {
    if (GRANULAR_LOG) {
        elizaLogger.info(`[PriceUpdatesStream] ${message}`, data);
        console.log(`[PriceUpdatesStream] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};

// Add type for price update item
interface PriceUpdateItem {
    id: string;
    price: {
        price: string;
        conf: string;
        expo: number;
        publish_time: number;
    };
    ema_price: {
        price: string;
        conf: string;
        expo: number;
        publish_time: number;
    };
    metadata?: {
        slot: number;
        proof_available_time: number;
        prev_publish_time: number;
    };
}
interface GetPriceUpdatesStreamContent extends Content {
    text: string;
    priceIds: string[];
    options?: {
        encoding?: "hex" | "base64";
        parsed?: boolean;
        allowUnordered?: boolean;
        benchmarksOnly?: boolean;
    };
    success?: boolean;
    data?: {
        streamId: string;
        status: 'connected' | 'disconnected' | 'error';
        binary?: {
            encoding: string;
            data: string[];
        };
        parsed?: Array<{
            id: string;
            price: {
                price: string;
                conf: string;
                expo: number;
                publish_time: number;
            };
            ema_price: {
                price: string;
                conf: string;
                expo: number;
                publish_time: number;
            };
            metadata?: {
                slot: number;
                proof_available_time: number;
                prev_publish_time: number;
            };
        }>;
        error?: string;
    };
}

// Helper function to extract price IDs from text
function extractPriceIds(text: string): string[] {
    let priceIds: string[] = [];

    // Try to match common price symbols first
    const symbolMatch = text.match(/(?:BTC|ETH|SOL)\/USD/g);
    if (symbolMatch) {
        const symbolToId: { [key: string]: string } = {
            'BTC/USD': '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
            'ETH/USD': '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
            'SOL/USD': '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d'
        };
        priceIds = symbolMatch.map(symbol => symbolToId[symbol]).filter(id => id);
    }

    if (priceIds.length === 0) {
        const hexMatchesWithPrefix = text.match(/0x[0-9a-fA-F]{64}/g);
        if (hexMatchesWithPrefix) {
            priceIds = hexMatchesWithPrefix;
        } else {
            const hexMatches = text.match(/[0-9a-fA-F]{64}/g);
            if (hexMatches) {
                priceIds = hexMatches.map(id => `0x${id}`);
            }
        }
    }

    return priceIds;
}

// Define proper types for the processed data
interface ProcessedPriceData {
    binary?: {
        encoding: string;
        data: string[];
    };
    parsed?: Array<{
        id: string;
        price: {
            price: string;
            conf: string;
            expo: number;
            publish_time: number;
        };
        ema_price: {
            price: string;
            conf: string;
            expo: number;
            publish_time: number;
        };
        metadata?: {
            slot: number;
            proof_available_time: number;
            prev_publish_time: number;
        };
    }>;
}

interface RawPriceData {
    binary: {
        encoding: string;
        data: string[];
    };
    parsed: Array<PriceUpdateItem>;
}

// Helper function to process price update data
function processPriceUpdateData(data: RawPriceData): ProcessedPriceData {
    return {
        binary: data.binary,
        parsed: data.parsed.map((item: PriceUpdateItem) => ({
            id: item.id,
            price: {
                price: item.price.price,
                conf: item.price.conf,
                expo: item.price.expo,
                publish_time: item.price.publish_time
            },
            ema_price: {
                price: item.ema_price.price,
                conf: item.ema_price.conf,
                expo: item.ema_price.expo,
                publish_time: item.ema_price.publish_time
            },
            metadata: item.metadata ? {
                slot: item.metadata.slot,
                proof_available_time: item.metadata.proof_available_time,
                prev_publish_time: item.metadata.prev_publish_time
            } : undefined
        }))
    };
}

// Helper function to format price update text
function formatPriceUpdateText(streamId: string, messageCount: number, data: RawPriceData): string {
    return `Price Update Stream (ID: stream_${streamId}, Update ${messageCount}/${PYTH_MAX_PRICE_STREAMS}):
${data.parsed.map((item: PriceUpdateItem) =>
    `Price Feed: ${item.id}
Current Price: ${(Number(item.price.price) * Math.pow(10, item.price.expo)).toFixed(2)} USD
Confidence: ±${(Number(item.price.conf) * Math.pow(10, item.price.expo)).toFixed(2)} USD
EMA Price: ${(Number(item.ema_price.price) * Math.pow(10, item.ema_price.expo)).toFixed(2)} USD
EMA Confidence: ±${(Number(item.ema_price.conf) * Math.pow(10, item.ema_price.expo)).toFixed(2)} USD
Last Update: ${new Date(item.price.publish_time * 1000).toLocaleString()}${item.metadata ? `
Slot: ${item.metadata.slot}
Proof Available: ${new Date(item.metadata.proof_available_time * 1000).toLocaleString()}` : ''}`
).join('\n\n')}`;
}

// Function to collect stream data
async function collectStreamData(eventSource: EventSource, streamId: string): Promise<RawPriceData> {
    return new Promise((resolve, reject) => {
        let messageCount = 0;
        const collectedData: RawPriceData = {
            binary: { encoding: 'hex', data: [] },
            parsed: []
        };

        eventSource.onmessage = (event) => {
            messageCount++;
            logGranular("Received price update", { streamId, messageCount, data: event.data });

            try {
                const rawData = JSON.parse(event.data) as RawPriceData;
                collectedData.binary.data.push(...rawData.binary.data);
                collectedData.parsed.push(...rawData.parsed);

                if (messageCount >= PYTH_MAX_PRICE_STREAMS) {
                    eventSource.close();
                    resolve(collectedData);
                }
            } catch (error) {
                eventSource.close();
                reject(error);
            }
        };

        eventSource.onerror = (error) => {
            eventSource.close();
            reject(error);
        };
    });
}

// Helper function to create and manage price stream
async function createPriceStream(
    runtime: IAgentRuntime,
    priceIds: string[],
    callback?: HandlerCallback
): Promise<void> {
    const config = await validatePythConfig(runtime);
    if (!config) {
        throw new DataError(
            DataErrorCode.VALIDATION_FAILED,
            "Invalid Pyth configuration",
            ErrorSeverity.HIGH
        );
    }

    const networkConfig = getNetworkConfig(config.PYTH_NETWORK_ENV);
    const client = new HermesClient(networkConfig.hermes);
    const streamId = `stream_${Date.now()}`;

    logGranular("Creating price stream for IDs:", { streamId, priceIds });

    try {
        const eventSource = (await client.getPriceUpdatesStream(priceIds, {
            parsed: true,
            encoding: 'hex'
        })) as unknown as EventSource;

        // Store the stream
        activeStreams.set(streamId, eventSource as any);

        try {
            // Collect all stream data
            const collectedData = await collectStreamData(eventSource as any, streamId);

            // Process collected data
            const processedData = processPriceUpdateData(collectedData);
            const updateText = formatPriceUpdateText(streamId, PYTH_MAX_PRICE_STREAMS, collectedData);

            // Send single callback with all data
            if (callback) {
                callback({
                    text: updateText,
                    success: true,
                    priceIds,
                    data: {
                        streamId,
                        status: 'connected',
                        ...processedData
                    }
                } as GetPriceUpdatesStreamContent);
            }

            activeStreams.delete(streamId);
            logGranular("Stream completed successfully", { streamId });

        } catch (error) {
            logGranular("Error collecting stream data", { streamId, error });
            if (callback) {
                callback({
                    text: `Error processing price updates: ${error instanceof Error ? error.message : String(error)}`,
                    success: false,
                    priceIds,
                    data: {
                        streamId,
                        status: 'error',
                        error: error instanceof Error ? error.message : String(error)
                    }
                } as GetPriceUpdatesStreamContent);
            }
            activeStreams.delete(streamId);
            throw error;
        }
    } catch (error) {
        logGranular("Error creating price stream", { streamId, error });
        throw new DataError(
            DataErrorCode.TRANSFORM_ERROR,
            error instanceof Error ? error.message : String(error),
            ErrorSeverity.HIGH
        );
    }
}



export const getPriceUpdatesStreamAction: Action = {
    name: "GET_PRICE_UPDATES_STREAM",
    similes: ["STREAM_PRICE_UPDATES", "SUBSCRIBE_TO_PRICES", "WATCH_PRICE_FEED"],
    description: "Create a streaming connection for real-time price updates from Pyth Network",
    examples: [[
        {
            user: "user",
            content: {
                text: "Stream BTC/USD price updates",
                priceIds: ["0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43"],
                options: {
                    encoding: "hex",
                    parsed: true,
                    benchmarksOnly: true
                }
            } as GetPriceUpdatesStreamContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Starting BTC/USD price stream...",
                success: true,
                priceIds: ["0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43"],
                data: {
                    streamId: "stream_1",
                    status: "connected",
                    updates: [{
                        id: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
                        price: 42000,
                        confidence: 100,
                        timestamp: 1641034800,
                        emaPrice: 41950
                    }]
                }
            } as GetPriceUpdatesStreamContent
        } as ActionExample
    ], [
        {
            user: "user",
            content: {
                text: "Stream ETH and BTC prices with benchmarks only",
                priceIds: [
                    "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
                    "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"
                ],
                options: {
                    benchmarksOnly: true,
                    parsed: true
                }
            } as GetPriceUpdatesStreamContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Starting price stream for BTC and ETH...",
                success: true,
                priceIds: [
                    "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
                    "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"
                ],
                data: {
                    streamId: "stream_2",
                    status: "connected",
                    updates: [
                        {
                            id: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
                            price: 42000,
                            confidence: 100,
                            timestamp: 1641034800,
                            emaPrice: 41950
                        },
                        {
                            id: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
                            price: 2500,
                            confidence: 50,
                            timestamp: 1641034800,
                            emaPrice: 2495
                        }
                    ]
                }
            } as GetPriceUpdatesStreamContent
        } as ActionExample
    ]],

    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        // Check if this message is intended for this action
        if (message.content?.type !== "GET_PRICE_UPDATES_STREAM") {
            return true; // Skip validation for other actions
        }

        logGranular("Starting validation", {
            content: message.content
        });

        try {
            let content = message.content as GetPriceUpdatesStreamContent;

            // Handle text-only input by extracting priceIds
            if (!content.priceIds) {
                const priceIds = extractPriceIds(content.text);
                if (priceIds.length > 0) {
                    content = {
                        ...content,
                        priceIds,
                        options: {
                            parsed: true,
                            encoding: "hex"
                        }
                    };
                    message.content = content;
                }
            }

            // Validate against schema
            try {
                await validatePriceUpdateStreamData(content);
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

            // Validate Pyth configuration
            const config = await validatePythConfig(_runtime);
            if (!config) {
                throw new DataError(
                    DataErrorCode.VALIDATION_FAILED,
                    "Invalid Pyth configuration",
                    ErrorSeverity.HIGH
                );
            }

            if (!content.priceIds || !Array.isArray(content.priceIds)) {
                throw DataError.validationFailed(content, ["priceIds must be an array of strings"]);
            }

            if (content.priceIds.length === 0) {
                throw DataError.validationFailed(content, ["priceIds array cannot be empty"]);
            }

            // Validate each price ID is a valid hex string
            content.priceIds.forEach((id, index) => {
                if (!/^0x[0-9a-fA-F]{64}$/.test(id)) {
                    throw DataError.validationFailed(content, [`Invalid price ID at index ${index}: ${id}`]);
                }
            });

            // Validate options if provided
            if (content.options) {
                const { encoding, parsed, allowUnordered, benchmarksOnly } = content.options;

                if (encoding && !["hex", "base64"].includes(encoding)) {
                    throw DataError.validationFailed(content, ["encoding must be either 'hex' or 'base64'"]);
                }

                if (parsed !== undefined && typeof parsed !== "boolean") {
                    throw DataError.validationFailed(content, ["parsed must be a boolean"]);
                }

                if (allowUnordered !== undefined && typeof allowUnordered !== "boolean") {
                    throw DataError.validationFailed(content, ["allowUnordered must be a boolean"]);
                }

                if (benchmarksOnly !== undefined && typeof benchmarksOnly !== "boolean") {
                    throw DataError.validationFailed(content, ["benchmarksOnly must be a boolean"]);
                }
            }

            logGranular("GET_PRICE_UPDATES_STREAM validation successful", {
                priceIds: content.priceIds,
                options: content.options
            });

            return true;
        } catch (error) {
            logGranular("Validation failed", { error });
            throw error;
        }
    },

    async handler(
        runtime: IAgentRuntime,
        message: Memory,
        state: State | undefined,
        _options: { [key: string]: unknown } = {},
        callback?: HandlerCallback
    ): Promise<boolean> {
        logGranular("Starting handler execution", {
            messageId: message.id,
            messageContent: message.content
        });

        try {
            const messageContent = message.content as GetPriceUpdatesStreamContent;
            let priceIds = messageContent.priceIds;

            // If no priceIds in content, try to extract them
            if (!priceIds) {
                priceIds = extractPriceIds(messageContent.text);
                if (priceIds.length === 0) {
                    throw new DataError(
                        DataErrorCode.VALIDATION_FAILED,
                        "Could not extract any valid price IDs from message",
                        ErrorSeverity.HIGH
                    );
                }
            }

            await createPriceStream(runtime, priceIds, callback);
            return true;

        } catch (error) {
            logGranular("Error in price updates stream handler", error);
            throw new DataError(
                DataErrorCode.TRANSFORM_ERROR,
                error instanceof Error ? error.message : String(error),
                ErrorSeverity.HIGH
            );
        }
    }
};

export default getPriceUpdatesStreamAction;

