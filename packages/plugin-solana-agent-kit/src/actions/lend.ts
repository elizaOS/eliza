import { elizaLogger } from "@elizaos/core";
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

const LEND_ASSET_ACTION = ACTIONS.LEND_ASSET_ACTION;

export interface LendAssetContent extends Content {
    amount: number;
}

function isLendAssetContent(
    runtime: IAgentRuntime,
    content: any
): content is LendAssetContent {
    elizaLogger.log("Content for lend", content);
    return (
        typeof content.amount === "number"
    );
}

const lendTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "amount": "100",
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the lending request:
- Amount of USDC to lend

Respond with a JSON markdown block containing only the extracted values.`;

export default {
    name: LEND_ASSET_ACTION.name,
    similes: LEND_ASSET_ACTION.similes,
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        elizaLogger.log("Validating lend asset from user:", message.userId);
        return false;
    },
    description: LEND_ASSET_ACTION.description,
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting LEND_ASSET handler...");
        const sak = await getSAK(runtime);

        // Initialize or update state
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        // Compose lend context
        const lendContext = composeContext({
            state,
            template: lendTemplate,
        });

        // Generate lend content
        const content = await generateObjectDeprecated({
            runtime,
            context: lendContext,
            modelClass: ModelClass.LARGE,
        });

        // Validate lend content
        if (!isLendAssetContent(runtime, content)) {
            elizaLogger.error("Invalid content for LEND_ASSET action.");
            if (callback) {
                callback({
                    text: "Unable to process lending request. Invalid content provided.",
                    content: { error: "Invalid lend content" },
                });
            }
            return false;
        }

        try {
            const lendResult = await sak.lendAssets(

                content.amount
            );

            console.log("Lend result:", lendResult);

            if (callback) {
                callback({
                    text: `Successfully lent ${content.amount} USDC`,
                    content: {
                        success: true,
                        lendResult: lendResult,
                    },
                });
            }

            return true;
        } catch (error) {
            elizaLogger.error("Error during lending:", error);
            if (callback) {
                callback({
                    text: `Error lending asset: ${error.message}`,
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
                    text: "I want to lend 100 USDC",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Lend 100 USDC",
                    action: "LEND_ASSET",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Successfully lent 100 USDC",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;