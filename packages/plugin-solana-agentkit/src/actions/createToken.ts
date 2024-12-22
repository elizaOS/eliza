import {
    ActionExample,
    composeContext,
    Content,
    elizaLogger,
    generateObjectDeprecated,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
    type Action,
} from "@elizaos/core";

import { SolanaAgentKit } from "solana-agent-kit";

export interface CreateTokenContent extends Content {
    name: string;
    uri: string;
    symbol: string;
    decimals: number;
    initialSupply: number;
}

function isCreateTokenContent(
    runtime: IAgentRuntime,
    content: any
): content is CreateTokenContent {
    elizaLogger.log("Content for createToken", content);
    return (
        typeof content.name === "string" &&
        typeof content.uri === "string" &&
        typeof content.symbol === "string" &&
        typeof content.decimals === "number" &&
        typeof content.initialSupply === "number"
    );
}

const createTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "name": "Example Token",
    "symbol": "EXMPL",
    "uri": "https://raw.githubusercontent.com/solana-developers/opos-asset/main/assets/CompressedCoil/image.png",
    "decimals": 18,
    "initialSupply": 1000000,
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the requested token transfer:
- Token name
- Token symbol
- Token uri
- Token decimals
- Token initialSupply

Respond with a JSON markdown block containing only the extracted values.`;

export default {
    name: "CREATE_TOKEN",
    similes: ["DEPLOY_TOKEN"],
    validate: async (runtime: IAgentRuntime, message: Memory) => true,
    description: "Create tokens",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting CREATE_TOKEN handler...");
        // Initialize or update state
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        // Compose transfer context
        const transferContext = composeContext({
            state,
            template: createTemplate,
        });

        // Generate transfer content
        const content = await generateObjectDeprecated({
            runtime,
            context: transferContext,
            modelClass: ModelClass.LARGE,
        });

        // Validate transfer content
        if (!isCreateTokenContent(runtime, content)) {
            elizaLogger.error("Invalid content for CREATE_TOKEN action.");
            if (callback) {
                callback({
                    text: "Unable to process create token request. Invalid content provided.",
                    content: { error: "Invalid creat token content" },
                });
            }
            return false;
        }

        elizaLogger.log("Init solana agent kit...");
        const solanaPrivatekey = runtime.getSetting("SOLANA_PRIVATE_KEY");
        const rpc = runtime.getSetting("RPC_URL");
        const openAIKey = runtime.getSetting("OPENAI_API_KEY");
        const solanaAgentKit = new SolanaAgentKit(
            solanaPrivatekey,
            rpc,
            openAIKey
        );
        try {
            const deployedAddress = solanaAgentKit.deployToken(
                content.name,
                content.uri,
                content.symbol,
                content.decimals,
                content.initialSupply
            );
            elizaLogger.log("Create successful: ", deployedAddress);
            if (callback) {
                callback({
                    text: `Successfully create token ${content.name}`,
                    content: {
                        success: true,
                    },
                });
            }
            return true;
        } catch (error) {
            if (callback) {
                elizaLogger.error("Error during create token: ", error);
                callback({
                    text: `Error creating token: ${error.message}`,
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
                    text: "Create token, name is Example Token, symbol is EXMPL, uri is https://raw.githubusercontent.com/solana-developers/opos-asset/main/assets/CompressedCoil/image.png, decimals is 9, initialSupply is 100000000000",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll creaete token now...",
                    action: "CREATE_TOKEN",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Successfully create token 9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
