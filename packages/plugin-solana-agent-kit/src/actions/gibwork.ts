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

const GIBWORK_ACTION = ACTIONS.CREATE_GIBWORK_TASK_ACTION;

export interface GibWorkContent extends Content {
    title: string;
    content: string;
    requirements: string;
    tags: string[];
    tokenMintAddress: string;
    tokenAmount: number;
}

function isGibWorkContent(
    runtime: IAgentRuntime,
    content: any
): content is GibWorkContent {
    elizaLogger.log("Content for gibwork", content);
    return (
        typeof content.title === "string" &&
        typeof content.content === "string" &&
        typeof content.requirements === "string" &&
        Array.isArray(content.tags) &&
        typeof content.tokenMintAddress === "string" &&
        typeof content.tokenAmount === "number"
    );
}

const gibworkTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "title": "Build a Solana dApp",
    "content": "Create a simple Solana dApp with React frontend",
    "requirements": "Experience with Rust and React",
    "tags": ["solana", "rust", "react"],
    "tokenMintAddress": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "tokenAmount": 100
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the GibWork task:
- Title of the task
- Content/description of the task
- Requirements for the task
- Tags related to the task
- Token mint address for payment
- Token amount for payment

Respond with a JSON markdown block containing only the extracted values.`;

export default {
    name: GIBWORK_ACTION.name,
    similes: GIBWORK_ACTION.similes,
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        elizaLogger.log("Validating gibwork task from user:", message.userId);
        return false;
    },
    description: GIBWORK_ACTION.description,
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting CREATE_GIBWORK_TASK handler...");
        const sak = await getSAK(runtime);

        // Initialize or update state
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        // Compose gibwork context
        const gibworkContext = composeContext({
            state,
            template: gibworkTemplate,
        });

        // Generate gibwork content
        const content = await generateObjectDeprecated({
            runtime,
            context: gibworkContext,
            modelClass: ModelClass.LARGE,
        });

        // Validate gibwork content
        if (!isGibWorkContent(runtime, content)) {
            elizaLogger.error("Invalid content for CREATE_GIBWORK_TASK action.");
            if (callback) {
                callback({
                    text: "Unable to process GibWork task creation. Invalid content provided.",
                    content: { error: "Invalid gibwork content" },
                });
            }
            return false;
        }

        try {
            const gibworkResult = await sak.createGibworkTask(
                content.title,
                content.content,
                content.requirements,
                content.tags,
                content.tokenMintAddress,
                content.tokenAmount
            );

            console.log("GibWork task creation result:", gibworkResult);

            if (callback) {
                callback({
                    text: `Successfully created GibWork task: ${content.title}`,
                    content: {
                        success: true,
                        gibworkResult: gibworkResult,
                    },
                });
            }

            return true;
        } catch (error) {
            elizaLogger.error("Error during GibWork task creation:", error);
            if (callback) {
                callback({
                    text: `Error creating GibWork task: ${error.message}`,
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
                    text: "Create a GibWork task for building a Solana dApp, offering 100 USDC",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Creating GibWork task",
                    action: "CREATE_GIBWORK_TASK",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Successfully created GibWork task: Build a Solana dApp",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;