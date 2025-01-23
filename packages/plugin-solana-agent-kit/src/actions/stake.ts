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

const STAKE_ACTION = ACTIONS.STAKE_WITH_JUP_ACTION;

export interface StakeContent extends Content {
    amount: number;
}

function isStakeContent(
    runtime: IAgentRuntime,
    content: any
): content is StakeContent {
    elizaLogger.log("Content for stake", content);
    return (
        typeof content.amount === "number"
    );
}

const stakeTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "amount": "100",
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the staking request:
- Amount to stake

Respond with a JSON markdown block containing only the extracted values.`;

export default {
    name: STAKE_ACTION.name,
    similes: STAKE_ACTION.similes,
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        elizaLogger.log("Validating stake from user:", message.userId);
        return false;
    },
    description: STAKE_ACTION.description,
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting STAKE handler...");
        const sak = await getSAK(runtime);

        // Initialize or update state
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        // Compose stake context
        const stakeContext = composeContext({
            state,
            template: stakeTemplate,
        });

        // Generate stake content
        const content = await generateObjectDeprecated({
            runtime,
            context: stakeContext,
            modelClass: ModelClass.LARGE,
        });

        // Validate stake content
        if (!isStakeContent(runtime, content)) {
            elizaLogger.error("Invalid content for STAKE action.");
            if (callback) {
                callback({
                    text: "Unable to process staking request. Invalid content provided.",
                    content: { error: "Invalid stake content" },
                });
            }
            return false;
        }

        try {
            const stakeResult = await sak.stake(
                content.amount
            );

            console.log("Stake result:", stakeResult);

            if (callback) {
                callback({
                    text: `Successfully staked ${content.amount} tokens`,
                    content: {
                        success: true,
                        tx: stakeResult,
                    },
                });
            }

            return true;
        } catch (error) {
            elizaLogger.error("Error during staking:", error);
            if (callback) {
                callback({
                    text: `Error staking: ${error.message}`,
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
                    text: "I want to stake 100 tokens",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Stake 100 tokens",
                    action: "STAKE_WITH_JUP",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Successfully staked 100 tokens",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;