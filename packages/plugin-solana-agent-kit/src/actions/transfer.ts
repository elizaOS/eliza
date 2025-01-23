
import { elizaLogger,  } from "@elizaos/core";

import {
    PublicKey,

} from "@solana/web3.js";

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

const TRANSFER_ACTION = ACTIONS.TRANSFER_ACTION;

export interface TransferContent extends Content {
    tokenAddress: string;
    recipient: string;
    amount: string | number;
}

function isTransferContent(
    runtime: IAgentRuntime,
    content: any
): content is TransferContent {
    elizaLogger.log("Content for transfer", content);
    return (
        typeof content.tokenAddress === "string" &&
        typeof content.recipient === "string" &&
        (typeof content.amount === "string" ||
            typeof content.amount === "number")
    );
}

const transferTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "tokenAddress": "BieefG47jAHCGZBxi2q87RDuHyGZyYC3vAzxpyu8pump",
    "recipient": "9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
    "amount": "1000"
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the requested token transfer:
- Token contract address
- Recipient wallet address
- Amount to transfer

Respond with a JSON markdown block containing only the extracted values.`;

export default {
    name: TRANSFER_ACTION.name,
    similes: TRANSFER_ACTION.similes,
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        elizaLogger.log("Validating transfer from user:", message.userId);
        //add custom validate logic here
        /*
            const adminIds = runtime.getSetting("ADMIN_USER_IDS")?.split(",") || [];
            //elizaLogger.log("Admin IDs from settings:", adminIds);

            const isAdmin = adminIds.includes(message.userId);

            if (isAdmin) {
                //elizaLogger.log(`Authorized transfer from user: ${message.userId}`);
                return true;
            }
            else
            {
                //elizaLogger.log(`Unauthorized transfer attempt from user: ${message.userId}`);
                return false;
            }
            */
        return false;
    },
    description: TRANSFER_ACTION.description,
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting SEND_TOKEN handler...");
        const sak = await getSAK(runtime);

        // Initialize or update state
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        // Compose transfer context
        const transferContext = composeContext({
            state,
            template: transferTemplate,
        });

        // Generate transfer content
        const content = await generateObjectDeprecated({
            runtime,
            context: transferContext,
            modelClass: ModelClass.LARGE,
        });

        // Validate transfer content
        if (!isTransferContent(runtime, content)) {
            elizaLogger.error("Invalid content for TRANSFER_TOKEN action.");
            if (callback) {
                callback({
                    text: "Unable to process transfer request. Invalid content provided.",
                    content: { error: "Invalid transfer content" },
                });
            }
            return false;
        }

        try {

            const mintPubkey = new PublicKey(content.tokenAddress);
            const recipientPubkey = new PublicKey(content.recipient);


            const txId = await sak.transfer(recipientPubkey, Number(content.amount), mintPubkey)

            console.log("Transfer successful:", txId);

            if (callback) {
                callback({
                    text: `Successfully transferred ${content.amount} tokens to ${content.recipient}\nTransaction: ${txId}`,
                    content: {
                        success: true,
                        signature : txId,
                        amount: content.amount,
                        recipient: content.recipient,
                    },
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
    },

    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Send 69 EZSIS BieefG47jAHCGZBxi2q87RDuHyGZyYC3vAzxpyu8pump to 9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll send 69 EZSIS tokens now...",
                    action: "SEND_TOKEN",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Successfully sent 69 EZSIS tokens to 9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa\nTransaction: 5KtPn3DXXzHkb7VAVHZGwXJQqww39ASnrf7YkyJoF2qAGEpBEEGvRHLnnTG8ZVwKqNHMqSckWVGnsQAgfH5pbxEb",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
