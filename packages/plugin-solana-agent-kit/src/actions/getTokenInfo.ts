
import { elizaLogger,  } from "@elizaos/core";
import {
    type ActionExample,
    type Content,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State,
    type Action,
} from "@elizaos/core";
import { composeContext } from "@elizaos/core";
import { generateObjectDeprecated } from "@elizaos/core";
import { ACTIONS } from "solana-agent-kit";
import { getSAK } from "../client";

const GET_TOKEN_INFO_ACTION = ACTIONS.GET_TOKEN_DATA_ACTION;

export interface GetTokenInfoContent extends Content {
    tokenAddress: string;
}

function isGetTokenInfoContent(
    runtime: IAgentRuntime,
    content: any
): content is GetTokenInfoContent {
    elizaLogger.log("Content for transfer", content);
    return (
        typeof content.tokenAddress === "string"
    );
}

const getTokenInfoTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "tokenAddress": "SENDdRQtYMWaQrBroBrJ2Q53fgVuq95CV9UPGEvpCxa",
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the requested token:
- Token contract address

Respond with a JSON markdown block containing only the extracted values.`;

export default {
    name: GET_TOKEN_INFO_ACTION.name,
    similes: GET_TOKEN_INFO_ACTION.similes,
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        elizaLogger.log("Validating get token info from user:", message.userId);

        return false;
    },
    description: GET_TOKEN_INFO_ACTION.description,
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting GET_TOKEN_INFO handler...");
        const sak = await getSAK(runtime);

        // Initialize or update state
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        // Compose get token info context
        const getTokenInfoContext = composeContext({
            state,
            template: getTokenInfoTemplate,
        });

        // Generate get token info content
        const content = await generateObjectDeprecated({
            runtime,
            context: getTokenInfoContext,
            modelClass: ModelClass.LARGE,
        });

        // Validate get token info content
        if (!isGetTokenInfoContent(runtime, content)) {
            elizaLogger.error("Invalid content for GET_TOKEN_INFO action.");
            if (callback) {
                callback({
                    text: "Unable to process get token info request. Invalid content provided.",
                    content: { error: "Invalid get token info content" },
                });
            }
            return false;
        }

        try {

            const tokenData = await sak.getTokenDataByAddress(content.tokenAddress)

            console.log("Token data:", tokenData);

            if (callback) {
                callback({
                    text: `Successfully retrieved token data for ${content.tokenAddress}`,
                    content: {
                        success: true,
                        tokenData: tokenData,
                    },
                });
            }

            return true;
        } catch (error) {
            elizaLogger.error("Error during get token info:", error);
            if (callback) {
                callback({
                    text: `Error getting token info: ${error.message}`,
                    content: { error: error.message },
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
                    text: "Get token info for SENDdRQtYMWaQrBroBrJ2Q53fgVuq95CV9UPGEvpCxa",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Get token info for SENDdRQtYMWaQrBroBrJ2Q53fgVuq95CV9UPGEvpCxa",
                    action: "GET_TOKEN_INFO",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Successfully retrieved token info for SENDdRQtYMWaQrBroBrJ2Q53fgVuq95CV9UPGEvpCxa",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
