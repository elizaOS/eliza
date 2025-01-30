// src/actions/sendGif.ts

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
import { debugLog } from "../utils/debug";
import { validateGiphyConfig } from "../environment";
import type { GifResponse, Gif } from "../types";
import crypto from "node:crypto";

const sendGifTemplate = `Given the message, determine if a gif should be sent based on the content.
If yes, extract relevant keywords or phrases to use as search terms for the gif.

Format the response as a JSON object with these fields:
- trigger: boolean (whether to send a gif)
- searchTerm: string (keywords to search for the gif, required if trigger is true)

Example response:
\`\`\`json
{
    "trigger": true,
    "searchTerm": "pudgy penguins beach"
}
\`\`\`

{{recentMessages}}

Analyze the above messages and decide whether to respond with a gif. If so, specify the search term.
`;

const GIPHY_SEARCH_ENDPOINT = "https://api.giphy.com/v1/gifs/search";

export interface SendGifContent extends Content {
    trigger: boolean;
    searchTerm?: string;
}

export default {
    name: "SEND_GIF",
    similes: ["REPLY_WITH_GIF", "GIF_RESPONSE"],
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        elizaLogger.log("🔄 Validating Giphy configuration...");
        try {
            const config = await validateGiphyConfig(runtime);
            debugLog.validation(config);
            return true;
        } catch (error) {
            debugLog.error(error);
            return false;
        }
    },
    description: "Respond with a gif based on the user's message",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("🚀 Starting Giphy SEND_GIF handler...");

        // Initialize or update state
        let currentState = state;
        if (!currentState) {
            elizaLogger.log("Creating new state...");
            currentState = (await runtime.composeState(message)) as State;
        } else {
            elizaLogger.log("Updating existing state...");
            currentState = await runtime.updateRecentMessageState(currentState);
        }
        try {
            elizaLogger.log("Composing gif trigger context...");
            const gifContext = composeContext({
                state: currentState,
                template: sendGifTemplate,
            });

            elizaLogger.log("Generating content from context...");
            const content = (await generateObjectDeprecated({
                runtime,
                context: gifContext,
                modelClass: ModelClass.LARGE,
            })) as unknown as SendGifContent;

            if (!content) {
                throw new Error("Failed to parse gif trigger content");
            }

            debugLog.validation(content);

            if (!content.trigger || !content.searchTerm) {
                elizaLogger.log("No gif triggered for this message.");
                return false;
            }

            const config = await validateGiphyConfig(runtime);

            const requestParams = {
                api_key: config.GIPHY_API_KEY,
                q: content.searchTerm,
                limit: 10,
                rating: "pg",
                lang: "en", // Optional: specify language for better results
            };

            debugLog.request("GET", GIPHY_SEARCH_ENDPOINT, requestParams);

            const response = await axios.get<GifResponse>(
                GIPHY_SEARCH_ENDPOINT,
                {
                    params: requestParams,
                }
            );

            debugLog.response(response);
            elizaLogger.log(
                "Full Giphy API Response:",
                JSON.stringify(response.data, null, 2)
            );

            const gifs = response.data.data;
            if (!gifs.length) {
                throw new Error(
                    `No gifs found for search term: ${content.searchTerm}`
                );
            }

            // Filter out any non-GIF URLs just in case
            const gifGifs = gifs.filter((gif) =>
                gif.images.original.url.includes(".gif")
            );
            if (!gifGifs.length) {
                throw new Error(
                    `No valid GIFs found for search term: ${content.searchTerm}`
                );
            }

            // Select a random gif from the filtered results
            const selectedGif: Gif =
                gifGifs[Math.floor(Math.random() * gifGifs.length)];
            elizaLogger.log(
                "Selected GIF:",
                JSON.stringify(selectedGif, null, 2)
            );

            const gifUrl = selectedGif.images.original.url.split("?")[0];

            // Validate the URL structure
            if (!gifUrl.endsWith(".gif")) {
                throw new Error(`Invalid GIF URL format: ${gifUrl}`);
            }

            if (callback) {
                const message = {
                    text: "Here's a GIF for you!",
                    attachments: [
                        {
                            id: crypto.randomUUID(),
                            url: gifUrl, // Use the original Giphy URL directly
                            title: "Enjoy your GIF!",
                            source: "giphyPlugin",
                            description: selectedGif.title,
                            text: selectedGif.title,
                            contentType: "image/gif",
                            type: "animation",
                        },
                    ],
                };
                // No need for local file attachments anymore
                elizaLogger.log("✅ Sending callback with gif url:", message);
                callback(message);
            }

            // **Removed Immediate Deletion Here**

            return true;
        } catch (error) {
            debugLog.error(error);
            if (callback) {
                callback({
                    text: `Error fetching gif: ${error instanceof Error ? error.message : "Unknown error"}`,
                    content: {
                        error:
                            error instanceof Error
                                ? error.message
                                : "Unknown error",
                    },
                });
            }
            return false;
        }
    },
    examples: [
        [
            // Example 1: Silly comment
            {
                user: "{{user1}}",
                content: {
                    text: "Send me a gif about pudgy penguins",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Here's a pudgy penguins gif for you!",
                    action: "SEND_GIF",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "https://media2.giphy.com/media/qP4CXhBeKJTbSzjNfC/giphy.gif",
                },
            },
        ],
    ],
} as Action;
