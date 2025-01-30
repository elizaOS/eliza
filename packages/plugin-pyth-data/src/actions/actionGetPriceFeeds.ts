import { type Action, elizaLogger } from "@elizaos/core";
import type { IAgentRuntime, Memory, State, HandlerCallback, Content, ActionExample } from "@elizaos/core";
// import { HermesClient } from "../hermes/HermesClient";
import { HermesClient } from "@pythnetwork/hermes-client";
import { DataError, ErrorSeverity, DataErrorCode } from "../error";
import { validatePythConfig, getNetworkConfig, getConfig } from "../environment";
import { validatePriceFeedsData } from "../utils/priceFeedsValidation";

// Get configuration for granular logging
const config = getConfig();
const GRANULAR_LOG = config.PYTH_GRANULAR_LOG;

// Enhanced logging helper
const logGranular = (message: string, data?: unknown) => {
    if (GRANULAR_LOG) {
        elizaLogger.info(`[PriceFeeds] ${message}`, data);
        console.log(`[PriceFeeds] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};

interface PriceFeedAttributes {
    asset_type: string;
    base: string;
    description: string;
    display_symbol: string;
    quote_currency: string;
    schedule: string;
    symbol: string;
    generic_symbol?: string;
    cms_symbol?: string;
    country?: string;
    cqs_symbol?: string;
    nasdaq_symbol?: string;
    contract_id?: string;
}

interface GetPriceFeedsContent extends Content {
    text: string;
    query?: string;
    filter?: string;
    success?: boolean;
    data?: {
        feeds: Array<{
            id: string;
            attributes: PriceFeedAttributes;
        }>;
        count: number;
        responseType: string;
        isArray: boolean;
        error?: string;
    };
}

export const getPriceFeedsAction: Action = {
    name: "GET_PRICE_FEEDS",
    similes: ["FETCH_PRICE_FEEDS", "LIST_PRICE_FEEDS", "QUERY_PRICE_FEEDS"],
    description: "Retrieve price feeds from Pyth Network matching specific criteria",
    examples: [[
        {
            user: "user",
            content: {
                text: "Get all available price feeds from Pyth Network",
                query: "BTC",
                filter: "USD"
            } as GetPriceFeedsContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Price feeds matching query BTC and filter USD",
                success: true,
                query: "BTC",
                filter: "USD",
                data: {
                    feeds: [{
                        id: "f9c0172ba10dfa4d19088d94f5bf61d3b54d5bd7483a322a982e1373ee8ea31b",
                        attributes: {
                            asset_type: "Crypto",
                            base: "BTC",
                            description: "BITCOIN / US DOLLAR",
                            display_symbol: "BTC/USD",
                            generic_symbol: "BTCUSD",
                            quote_currency: "USD",
                            schedule: "America/New_York;O,O,O,O,O,O,O;",
                            symbol: "Crypto.BTC/USD"
                        }
                    }]
                }
            } as GetPriceFeedsContent
        } as ActionExample
    ]],

    async validate(runtime: IAgentRuntime, message: Memory): Promise<boolean> {
        // Check if this message is intended for this action
        if (message.content?.type !== "GET_PRICE_FEEDS") {
            return true; // Skip validation for other actions
        }

        logGranular("Starting validation", {
            messageId: message.id,
            content: message.content
        });

        try {
            const content = message.content as GetPriceFeedsContent;
            logGranular("Validating content structure", { content });

            // Validate against schema
            try {
                await validatePriceFeedsData(content);
                logGranular("Schema validation passed");
            } catch (error) {
                logGranular("Schema validation error", { error });
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
            const config = await validatePythConfig(runtime);
            logGranular("Pyth config validation", { config });

            if (!config) {
                throw new DataError(
                    DataErrorCode.VALIDATION_FAILED,
                    "Invalid Pyth configuration",
                    ErrorSeverity.HIGH
                );
            }

            // Content validation is optional for this action
            if (content.query && typeof content.query !== 'string') {
                logGranular("Invalid query type", { query: content.query });
                throw new DataError(
                    DataErrorCode.VALIDATION_FAILED,
                    "Query must be a string",
                    ErrorSeverity.HIGH
                );
            }

            if (content.filter && typeof content.filter !== 'string') {
                logGranular("Invalid filter type", { filter: content.filter });
                throw new DataError(
                    DataErrorCode.VALIDATION_FAILED,
                    "Filter must be a string",
                    ErrorSeverity.HIGH
                );
            }

            logGranular("Validation successful", {
                query: content.query,
                filter: content.filter
            });

            return true;
        } catch (error) {
            logGranular("Validation failed", {
                error: error instanceof Error ? {
                    message: error.message,
                    stack: error.stack,
                    name: error.name
                } : String(error)
            });

            if (error instanceof DataError) {
                throw error;
            }
            throw new DataError(
                DataErrorCode.VALIDATION_FAILED,
                "Invalid content format",
                ErrorSeverity.HIGH,
                { content: message.content }
            );
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
            hasCallback: !!callback
        });

        try {
            const messageContent = message.content as GetPriceFeedsContent;
            const { query, filter } = messageContent;

            logGranular("Processing request", { query, filter });

            // Get Pyth configuration
            const config = await validatePythConfig(runtime);
            logGranular("Got Pyth config", { networkEnv: config.PYTH_NETWORK_ENV });

            // Initialize HermesClient with configuration
            const networkConfig = getNetworkConfig(config.PYTH_NETWORK_ENV);
            logGranular("Network config", { networkConfig });

            const client = new HermesClient(networkConfig.hermes);
            logGranular("Initialized HermesClient", {
                endpoint: networkConfig.hermes
            });

            // Get price feeds with proper options
            const options = {
                query: query,
                filter: filter
            };

            logGranular("Fetching price feeds with options", {
                options,
                hermesEndpoint: networkConfig.hermes,
                clientType: typeof client.getPriceFeeds
            });

            const priceFeeds = await client.getPriceFeeds(options);

            logGranular("Retrieved price feeds", {
                responseType: typeof priceFeeds,
                isArray: Array.isArray(priceFeeds),
                count: priceFeeds?.length || 0,
                sample: priceFeeds?.slice(0, 3) || [] // Log first 3 feeds for debugging
            });

            // Process and transform feeds
            const transformedFeeds = priceFeeds.map((feed) => ({
                id: feed.id,
                attributes: {
                    asset_type: feed.attributes?.asset_type || "Unknown",
                    base: feed.attributes?.base || "Unknown",
                    description: feed.attributes?.description || "Unknown",
                    display_symbol: feed.attributes?.display_symbol || "Unknown",
                    quote_currency: feed.attributes?.quote_currency || "Unknown",
                    schedule: feed.attributes?.schedule || "",
                    symbol: feed.attributes?.symbol || "Unknown",
                    generic_symbol: feed.attributes?.generic_symbol,
                    cms_symbol: feed.attributes?.cms_symbol,
                    country: feed.attributes?.country,
                    cqs_symbol: feed.attributes?.cqs_symbol,
                    nasdaq_symbol: feed.attributes?.nasdaq_symbol,
                    contract_id: feed.attributes?.contract_id
                }
            }));

            // Prepare callback content
            const callbackContent: GetPriceFeedsContent = {
                text: `Retrieved ${priceFeeds.length} price feeds:
${transformedFeeds.map(feed =>
    `- ${feed.attributes.description} (${feed.attributes.display_symbol})
  Type: ${feed.attributes.asset_type}
  Base: ${feed.attributes.base}
  Quote: ${feed.attributes.quote_currency}
  Schedule: ${feed.attributes.schedule}
  ID: ${feed.id}`
).join('\n')}
${query ? `\nMatching query: "${query}"` : ''}${filter ? `\nWith filter: "${filter}"` : ''}`,
                query,
                filter,
                success: true,
                data: {
                    feeds: transformedFeeds,
                    count: priceFeeds.length,
                    responseType: "object",
                    isArray: true
                }
            };

            logGranular("Prepared callback content", {
                feedCount: transformedFeeds.length,
                firstFeed: transformedFeeds[0]
            });

            // Execute callback if provided
            if (callback) {
                logGranular("Executing callback");
                await callback(callbackContent);
                logGranular("Callback completed");
            }

            return true;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            const errorStack = error instanceof Error ? error.stack : undefined;

            logGranular("Error retrieving price feeds", {
                error: errorMessage,
                stack: errorStack
            });

            // Prepare error callback content
            const errorContent: GetPriceFeedsContent = {
                text: `Failed to retrieve price feeds: ${errorMessage}\nError details: ${errorStack || 'No stack trace available'}`,
                success: false,
                data: {
                    feeds: [],
                    error: errorMessage,
                    count: 0,
                    responseType: "object",
                    isArray: true
                }
            };

            // Execute callback if provided
            if (callback) {
                await callback(errorContent);
            }

            // Throw appropriate error
            throw new DataError(
                DataErrorCode.PRICE_FEEDS_FETCH_FAILED,
                errorMessage,
                ErrorSeverity.HIGH
            );
        }
    }
};

export default getPriceFeedsAction;
