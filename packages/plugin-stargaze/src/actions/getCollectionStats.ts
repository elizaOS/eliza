import {
    composeContext,
    type Content,
    elizaLogger,
    generateObjectDeprecated,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State,
    type Action,
} from "@elizaos/core";
import axios from "axios";
import { validateStargazeConfig } from "../environment";
import { debugLog } from "../utils/debug";

export interface GetCollectionStatsContent extends Content {
    collectionAddr: string;
}

const COLLECTION_STATS_QUERY = `
query CollectionStats($collectionAddr: String!) {
    collection(address: $collectionAddr) {
        contractAddress
        name
        stats {
            numOwners
            bestOffer
            volumeTotal
            volume24Hour
            salesCountTotal
            tokensMintedPercent
            uniqueOwnerPercent
            change24HourPercent
            marketCap
            mintCount24hour
            mintVolume24hour
            volumeUsdTotal
            volumeUsd24hour
        }
    }
}`;

// Add template for content generation
const getCollectionStatsTemplate = `Given the message, extract the collection address for fetching Stargaze stats.

Format the response as a JSON object with this field:
- collectionAddr: the collection address or name (required)

Example response for "Show me stats for ammelia collection":
\`\`\`json
{
    "collectionAddr": "ammelia"
}
\`\`\`

Example response for "Show me stats for stars10n0m58ztlr9wvwkgjuek2m2k0dn5pgrhfw9eahg9p8e5qtvn964suc995j collection":
\`\`\`json
{
    "collectionAddr": "stars10n0m58ztlr9wvwkgjuek2m2k0dn5pgrhfw9eahg9p8e5qtvn964suc995j"
}
\`\`\`

{{recentMessages}}

Extract the collection address from the above messages and respond with the appropriate JSON.`;

export default {
    name: "GET_COLLECTION_STATS",
    similes: ["CHECK_COLLECTION_STATS", "COLLECTION_INFO"],
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        elizaLogger.log("🔄 Validating Stargaze configuration...");
        try {
            const config = await validateStargazeConfig(runtime);
            debugLog.validation(config);
            return true;
        } catch (error) {
            debugLog.error(error);
            return false;
        }
    },
    description: "Get detailed statistics for a Stargaze collection",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("🚀 Starting Stargaze GET_COLLECTION_STATS handler...");

        if (!state) {
            elizaLogger.log("Creating new state...");
            state = (await runtime.composeState(message)) as State;
        } else {
            elizaLogger.log("Updating existing state...");
            state = await runtime.updateRecentMessageState(state);
        }

        try {
            elizaLogger.log("Composing collection stats context...");
            const statsContext = composeContext({
                state,
                template: getCollectionStatsTemplate,
            });

            elizaLogger.log("Generating content from context...");
            const content = (await generateObjectDeprecated({
                runtime,
                context: statsContext,
                modelClass: ModelClass.LARGE,
            })) as unknown as GetCollectionStatsContent;

            if (!content || !content.collectionAddr) {
                throw new Error("Invalid or missing collection address in parsed content");
            }

            debugLog.validation(content);

            const config = await validateStargazeConfig(runtime);

            const requestData = {
                query: COLLECTION_STATS_QUERY,
                variables: {
                    collectionAddr: content.collectionAddr,
                },
            };

            debugLog.request('POST', config.STARGAZE_ENDPOINT, requestData);

            const response = await axios.post(
                config.STARGAZE_ENDPOINT,
                requestData,
                {
                    headers: {
                        'Content-Type': 'application/json',
                    }
                }
            );

            debugLog.response(response);

            const stats = response.data?.data?.collection?.stats;
            const name = response.data?.data?.collection?.name;

            if (!stats) {
                throw new Error("No stats found for collection");
            }

            // Format numerical values
            const formatValue = (value: number) =>
                value ? Number(value).toLocaleString(undefined, {
                    maximumFractionDigits: 2
                }) : '0';

            // Format percentage values
            const formatPercent = (value: number) =>
                value ? `${Number(value).toFixed(2)}%` : '0%';

            if (callback) {
                const message = {
                    text: `Collection Stats for ${name} (${content.collectionAddr}):
- Total Volume: ${formatValue(stats.volumeUsdTotal)} USD
- 24h Volume: ${formatValue(stats.volumeUsd24hour)} USD
- Total Sales: ${formatValue(stats.salesCountTotal)}
- Unique Owners: ${formatValue(stats.numOwners)}
- Owner Ratio: ${formatPercent(stats.uniqueOwnerPercent)}
- Minted: ${formatPercent(stats.tokensMintedPercent)}
- 24h Change: ${formatPercent(stats.change24HourPercent)}
- 24h Mints: ${formatValue(stats.mintCount24hour)}
- Market Cap: ${formatValue(stats.marketCap)} USD`,
                    content: stats,
                };
                elizaLogger.log("✅ Sending callback with collection stats:", message);
                callback(message);
            }

            return true;
        } catch (error) {
            debugLog.error(error);
            if (callback) {
                callback({
                    text: `Error fetching collection stats: ${error}`,
                    content: { error: error },
                });
            }
            return false;
        }
    },
    examples: [[
        {
            user: "{{user1}}",
            content: {
                text: "Show me stats for collection ammelia",
            },
        },
        {
            user: "{{agent}}",
            content: {
                text: "I'll check the stats for collection ammelia...",
                action: "GET_COLLECTION_STATS",
            },
        },
        {
            user: "{{user1}}",
            content: {
                text: "Show me stats for collection {collection address}",
            },
        },
        {
            user: "{{agent}}",
            content: {
                text: "I'll check the stats for collection {collection address}...",
                action: "GET_COLLECTION_STATS",
            },
        },
    ]],
} as Action;