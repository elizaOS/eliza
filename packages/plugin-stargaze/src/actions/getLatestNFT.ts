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

export interface GetLatestNFTContent extends Content {
    collectionAddr: string;
    limit: number;
}

const getLatestNFTTemplate = `Given the message, extract information about the NFT collection request.

Format the response as a JSON object with these fields:
- collectionAddr: the collection address or name
- limit: number of NFTs to fetch (default to 1 for latest)

Example response:
For "Show me the latest NFT from ammelia":
\`\`\`json
{
    "collectionAddr": "ammelia",
    "limit": 1
}
\`\`\`

For "Show me the latest NFT from Badkids":
\`\`\`json
{
    "collectionAddr": "badkids",
    "limit": 1
}
\`\`\`

{{recentMessages}}

Extract the collection information from the above messages and respond with the appropriate JSON.`;


const GRAPHQL_QUERY = `
query MarketplaceTokens($collectionAddr: String!, $limit: Int) {
    tokens(
        collectionAddr: $collectionAddr
        limit: $limit
        sortBy: MINTED_DESC
    ) {
        tokens {
            id
            tokenId
            name
            media {
                url
            }
            listPrice {
                amount
                symbol
            }
        }
        pageInfo {
            total
            offset
            limit
        }
    }
}`;

export default {
    name: "GET_LATEST_NFT",
    similes: ["SHOW_LATEST_NFT", "FETCH_LATEST_NFT"],
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
    description: "Get the latest NFT from a Stargaze collection",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("🚀 Starting Stargaze GET_LATEST_NFT handler...");

        if (!state) {
            elizaLogger.log("Creating new state...");
            state = (await runtime.composeState(message)) as State;
        } else {
            elizaLogger.log("Updating existing state...");
            state = await runtime.updateRecentMessageState(state);
        }

        try {
            elizaLogger.log("Composing NFT context...");
            const nftContext = composeContext({
                state,
                template: getLatestNFTTemplate,
            });

            elizaLogger.log("Generating content from context...");
            const content = (await generateObjectDeprecated({
                runtime,
                context: nftContext,
                modelClass: ModelClass.LARGE,
            })) as unknown as GetLatestNFTContent;

            if (!content || !content.collectionAddr) {
                throw new Error("Invalid or missing collection address in parsed content");
            }

            debugLog.validation(content);

            const config = await validateStargazeConfig(runtime);

            const requestData = {
                query: GRAPHQL_QUERY,
                variables: {
                    collectionAddr: content.collectionAddr,
                    limit: content.limit || 1,
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

            if (!response.data?.data?.tokens?.tokens) {
                throw new Error("Unexpected API response structure");
            }

            const latestNFT = response.data.data.tokens.tokens[0];
            if (!latestNFT) {
                throw new Error(`No NFTs found in collection: ${content.collectionAddr}`);
            }

            if (callback) {
                const message = {
                    text: `Latest NFT from ${content.collectionAddr}:\nName: ${latestNFT.name}\nToken ID: ${latestNFT.tokenId}\nImage: ${latestNFT.media.url}`,
                    content: latestNFT,
                };
                elizaLogger.log("✅ Sending callback with NFT data:", message);
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

    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show me the latest NFT from ammelia collection",
                },
            },

            {
                user: "{{user1}}",
                content: {
                    text: "whats the latest mint for badkids in stargaze?",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll fetch the latest NFT from the ammelia collection.",
                    action: "GET_LATEST_NFT",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Here's the latest NFT: {{dynamic}}",
                },
            },
        ],
    ],
} as Action;