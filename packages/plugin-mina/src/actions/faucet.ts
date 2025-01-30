import {
    type ActionExample,
    type Content,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State,
    composeContext,
    elizaLogger,
    generateObject,
    type Action,
} from "@elizaos/core";
import { z } from "zod";
import { walletProvider } from "../providers/wallet";
import { Mina, PublicKey } from "o1js";

export interface FaucetContent extends Content {
    recipient: string;
    network: string | null;
}

function isFaucetContent(content: Content): content is FaucetContent {
    console.log("Content for Faucet", content);
    return typeof content.recipient === "string";
}

function validateAndNormalizeParams(params: FaucetContent) {
    if (!params.network) {
        params.network = "devnet";
    }
}

const FaucetTemplate = `Given the recent messages and wallet information below:

Example response:
\`\`\`json
{
    "recipient": "B62qkGSBuLmqYApYoWTmAzUtwFVx6Fe9ZStJVPzCwLjWZ5NQDYTiqEU",
}
\`\`\`

{{recentMessages}}

{{walletInfo}}

Extract the following information about the requested faucet request:
- Recipient wallet address

Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.`;

export default {
    name: "FAUCET",
    similes: ["FAUCET", "GET_TEST_TOKENS"],
    validate: async (_runtime: IAgentRuntime, message: Memory) => {
        console.log("Validating mina Faucet from user:", message.userId);
        return true;
    },
    description: "Get test tokens from the faucet",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback,
    ): Promise<boolean> => {
        elizaLogger.log("Starting FAUCET handler...");

        const walletInfo = await walletProvider.get(runtime, message, state);
        state.walletInfo = walletInfo;

        // Initialize or update state
        let currentState: State;
        if (!state) {
            currentState = (await runtime.composeState(message)) as State;
        } else {
            currentState = await runtime.updateRecentMessageState(state);
        }

        // Define the schema for the expected output
        const FaucetSchema = z.object({ recipient: z.string() });

        // Compose Faucet context
        const FaucetContext = composeContext({
            state: currentState,
            template: FaucetTemplate,
        });

        // Generate Faucet content with the schema
        const content = await generateObject({
            runtime,
            context: FaucetContext,
            schema: FaucetSchema,
            modelClass: ModelClass.SMALL,
        });

        const FaucetContent = content.object as FaucetContent;
        validateAndNormalizeParams(FaucetContent);

        // Validate Faucet content
        if (!isFaucetContent(FaucetContent)) {
            console.error("Invalid content for FAUCET action.");
            if (callback) {
                callback({
                    text: "Unable to process Faucet request. Invalid content provided.",
                    content: { error: "Invalid Faucet content" },
                });
            }
            return false;
        }

        try {
            const recipient = PublicKey.fromBase58(FaucetContent.recipient);
            await Mina.faucet(recipient, FaucetContent.network);
            const defaultAmount = 300;

            console.log("Faucet successful");

            if (callback) {
                callback({
                    text: `Successfully Faucet ${defaultAmount} MINA to ${FaucetContent.recipient}`,
                    content: {
                        success: true,
                        recipient: FaucetContent.recipient,
                        amount: defaultAmount,
                    },
                });
            }

            return true;
        } catch (error) {
            console.error("Error during token Faucet:", error);
            if (callback) {
                callback({
                    text: `Error Faucet tokens: ${error.message}`,
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
                    text: "Get some MINA from the faucet",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Sure, I'll request some MINA from the faucet on Mina Testnet now.",
                    action: "FAUCET",
                    content: {
                        recipient: "{{walletAddress}}",
                    },
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Get some test tokens from the faucet on Mina Testnet",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Of course, getting MINA from the faucet on Mina Testnet now.",
                    action: "FAUCET",
                    content: {
                        recipient: "{{walletAddress}}",
                    },
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
