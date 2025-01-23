import {
    type ActionExample,
    composeContext,
    type Content,
    elizaLogger,
    generateObject,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State,
    type Action
} from "@elizaos/core";
import axios from "axios";
import { z } from "zod";
import { getApiConfig, validateCoingeckoConfig } from "../environment";
import { getNewCoinsTemplate } from "../templates/newCoins";

interface NewCoin {
    id: string;
    symbol: string;
    name: string;
    activated_at: number;
}

interface NewCoinsResponse extends Array<NewCoin> {}

export const GetNewCoinsSchema = z.object({
    limit: z.number().min(1).max(50).default(10)
});

export type GetNewCoinsContent = z.infer<typeof GetNewCoinsSchema> & Content;

export const isGetNewCoinsContent = (obj: any): obj is GetNewCoinsContent => {
    return GetNewCoinsSchema.safeParse(obj).success;
};

export default {
    name: "GET_NEW_COINS",
    similes: [
        "NEW_COINS",
        "RECENTLY_ADDED",
        "NEW_LISTINGS",
        "LATEST_COINS",
    ],
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        await validateCoingeckoConfig(runtime);
        return true;
    },
    description: "Get list of recently added coins from CoinGecko",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting CoinGecko GET_NEW_COINS handler...");

        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        try {
            elizaLogger.log("Composing new coins context...");
            const newCoinsContext = composeContext({
                state,
                template: getNewCoinsTemplate,
            });

            const result = await generateObject({
                runtime,
                context: newCoinsContext,
                modelClass: ModelClass.LARGE,
                schema: GetNewCoinsSchema
            });

            if (!isGetNewCoinsContent(result.object)) {
                elizaLogger.error("Invalid new coins request format");
                return false;
            }

            // Fetch new coins data from CoinGecko
            const config = await validateCoingeckoConfig(runtime);
            const { baseUrl, apiKey, headerKey } = getApiConfig(config);

            elizaLogger.log("Fetching new coins data...");

            const response = await axios.get<NewCoinsResponse>(
                `${baseUrl}/coins/list/new`,
                {
                    headers: {
                        [headerKey]: apiKey
                    }
                }
            );

            if (!response.data) {
                throw new Error("No data received from CoinGecko API");
            }

            const formattedData = response.data
                .slice(0, result.object.limit)
                .map(coin => ({
                    name: coin.name,
                    symbol: coin.symbol.toUpperCase(),
                    activatedAt: new Date(coin.activated_at * 1000).toLocaleString('en-US', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                    })
                }));

            const responseText = [
                'Recently Added Coins:',
                '',
                ...formattedData.map((coin, index) =>
                    `${index + 1}. ${coin.name} (${coin.symbol})\n   Listed: ${coin.activatedAt}`
                )
            ].join('\n');

            elizaLogger.success("New coins data retrieved successfully!");

            if (callback) {
                callback({
                    text: responseText,
                    content: {
                        newCoins: formattedData,
                        timestamp: new Date().toISOString()
                    }
                });
            }

            return true;
        } catch (error) {
            elizaLogger.error("Error in GET_NEW_COINS handler:", error);

            const errorMessage = error.response?.status === 429 ?
                "Rate limit exceeded. Please try again later." :
                `Error fetching new coins data: ${error.message}`;

            if (callback) {
                callback({
                    text: errorMessage,
                    content: {
                        error: error.message,
                        statusCode: error.response?.status
                    },
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
                    text: "What are the newest coins listed?",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll check the recently added coins for you.",
                    action: "GET_NEW_COINS",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Here are the recently added coins:\n1. Verb Ai (VERB)\n   Listed: January 20, 2025, 12:31 PM\n{{dynamic}}",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;