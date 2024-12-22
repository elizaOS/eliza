import {
    ActionExample,
    Content,
    elizaLogger,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
    type Action,
} from "@elizaos/core";

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
        return true;
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
