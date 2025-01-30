import {
    type ActionExample,
    type Content,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State,
    type Action,
    elizaLogger,
    composeContext,
    generateObjectDeprecated,
} from "@elizaos/core";
import { ethstorageConfig } from "../environment";
import { ethers } from "ethers";

export interface TransferContent extends Content {
    recipient: string;
    amount: string | number;
}

export function isTransferContent(
    content: TransferContent
): content is TransferContent {
    // Validate types
    const validTypes =
        typeof content.recipient === "string" &&
        (typeof content.amount === "string" ||
            typeof content.amount === "number");
    if (!validTypes) {
        return false;
    }

    // Validate addresses
    return ethers.isAddress(content.recipient);
}

const transferTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.


Example response:
\`\`\`json
{
    "recipient": "0x341Cb1a94ef69499F97E93c41707B21326C0Cc87",
    "amount": "1000"
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the requested ETHSTORAGE token transfer:
- Recipient wallet address
- Amount of QKC to transfer

Respond with a JSON markdown block containing only the extracted values.`;

export default {
    name: "SEND_TOKEN",
    similes: [
        "TRANSFER_TOKEN",
        "TRANSFER_TOKEN_ON_ETHSTORAGE",
        "TRANSFER_TOKENS_ON_ETHSTORAGE",
        "SEND_TOKEN_ON_ETHSTORAGE",
        "SEND_TOKENS_ON_ETHSTORAGE",
        "PAY_ON_ETHSTORAGE",
    ],
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        await ethstorageConfig(runtime);
        return true;
    },
    description:
        "Transfer tokens from the agent's wallet to another address",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting SEND_TOKEN handler...");

        // Initialize or update state
        let currentState = state;
        if (!currentState) {
            currentState = (await runtime.composeState(message)) as State;
        } else {
            currentState = await runtime.updateRecentMessageState(currentState);
        }

        // Compose transfer context
        const transferContext = composeContext({
            state: currentState,
            template: transferTemplate,
        });

        // Generate transfer content
        const content = await generateObjectDeprecated({
            runtime,
            context: transferContext,
            modelClass: ModelClass.SMALL,
        });

        // Validate transfer content
        if (!isTransferContent(content)) {
            console.log(content);
            console.error("Invalid content for TRANSFER_TOKEN action.");
            if (callback) {
                callback({
                    text: "Unable to process transfer request. Invalid content provided.",
                    content: {error: "Invalid transfer content"},
                });
            }
            return false;
        }

        if (content.amount != null && content.recipient != null) {
            try {
                const RPC = runtime.getSetting("ETHSTORAGE_RPC_URL");
                const PRIVATE_KEY = runtime.getSetting("ETHSTORAGE_PRIVATE_KEY");
                if (!PRIVATE_KEY) {
                    throw new Error("Missing ETHSTORAGE_PRIVATE_KEY");
                }

                const provider = new ethers.JsonRpcProvider(RPC);
                const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
                const tx = await wallet.sendTransaction({
                    to: content.recipient,
                    value: ethers.parseEther(content.amount.toString()),
                });
                await tx.wait();

                elizaLogger.success(
                    `Transfer completed successfully! Transaction hash: ${tx.hash}`
                );
                if (callback) {
                    callback({
                        text: `Transfer completed successfully! Transaction hash: ${tx.hash} `,
                        content: {},
                    });
                }

                return true;
            } catch (error) {
                elizaLogger.error("Error during token transfer:", error);
                if (callback) {
                    callback({
                        text: `Error transferring tokens: ${error.message}`,
                        content: { error: error.message },
                    });
                }
                return false;
            }
        } else {
            elizaLogger.log("Either amount or recipient not specified");
        }
    },

    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Send 100 QKC to 0x114B242D931B47D5cDcEe7AF065856f70ee278C4",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Sure, I'll send 100 QKC to that address now.",
                    action: "SEND_TOKEN",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully sent 100 QKC to 0x114B242D931B47D5cDcEe7AF065856f70ee278C4\nTransaction: 0x748057951ff79cea6de0e13b2ef70a1e9f443e9c83ed90e5601f8b45144a4ed4",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Please send 100 QKC tokens to 0x114B242D931B47D5cDcEe7AF065856f70ee278C4",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Of course. Sending 100 QKC to that address now.",
                    action: "SEND_TOKEN",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully sent 100 QKC to 0x114B242D931B47D5cDcEe7AF065856f70ee278C4\nTransaction: 0x0b9f23e69ea91ba98926744472717960cc7018d35bc3165bdba6ae41670da0f0",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
