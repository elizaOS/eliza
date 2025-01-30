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

import { Mina, AccountUpdate, PublicKey, UInt64 } from "o1js";

import { walletProvider } from "../providers/wallet";
import { isDevnet, parseAccount } from "../utils";
import { MINA_UNIT } from "../constants";

export interface TransferContent extends Content {
    recipient: string;
    amount: string | number;
}

function isTransferContent(content: Content): content is TransferContent {
    console.log("Content for transfer", content);
    return (
        typeof content.recipient === "string" &&
        (typeof content.amount === "string" ||
            typeof content.amount === "number")
    );
}

const transferTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "recipient": "B62qkGSBuLmqYApYoWTmAzUtwFVx6Fe9ZStJVPzCwLjWZ5NQDYTiqEU",
    "amount": "1"
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the requested token transfer:
- Recipient wallet address
- Amount to transfer

Respond with a JSON markdown block containing only the extracted values.`;

export default {
    name: "SEND_TOKEN",
    similes: [
        "TRANSFER_TOKEN",
        "TRANSFER_TOKENS",
        "SEND_TOKENS",
        "SEND_MINA",
        "PAY",
    ],
    validate: async (_runtime: IAgentRuntime, message: Memory) => {
        console.log("Validating mina transfer from user:", message.userId);
        return true;
    },
    description: "Transfer tokens from the agent's wallet to another address",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting SEND_TOKEN handler...");

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
        const transferSchema = z.object({
            recipient: z.string(),
            amount: z.union([z.string(), z.number()]),
        });

        // Compose transfer context
        const transferContext = composeContext({
            state: currentState,
            template: transferTemplate,
        });

        // Generate transfer content with the schema
        const content = await generateObject({
            runtime,
            context: transferContext,
            schema: transferSchema,
            modelClass: ModelClass.SMALL,
        });

        const transferContent = content.object as TransferContent;

        // Validate transfer content
        if (!isTransferContent(transferContent)) {
            console.error("Invalid content for TRANSFER_TOKEN action.");
            if (callback) {
                callback({
                    text: "Unable to process transfer request. Invalid content provided.",
                    content: { error: "Invalid transfer content" },
                });
            }
            return false;
        }

        try {
            const minaAccount = parseAccount(runtime);
            const sender = minaAccount.toPublicKey();
            const recipient = PublicKey.fromBase58(transferContent.recipient);
            const adjustedAmount = UInt64.from(transferContent.amount).mul(
                MINA_UNIT
            );
            const fee = isDevnet(runtime) ? 0.2 * MINA_UNIT : 0.01 * MINA_UNIT;

            const tx = await Mina.transaction(
                {
                    sender,
                    fee,
                    memo: "TransferFromEliza",
                },
                async () => {
                    const senderUpdate = AccountUpdate.createSigned(sender);
                    senderUpdate.send({
                        to: recipient,
                        amount: adjustedAmount,
                    });
                }
            );
            await tx.prove();
            const pendingTx = await tx.sign([minaAccount]).send();
            await pendingTx.wait();

            console.log(
                `Transferring: ${transferContent.amount} tokens (${adjustedAmount} base units)`
            );
            console.log("Transfer successful:", pendingTx.hash);

            if (callback) {
                callback({
                    text: `Successfully transferred ${transferContent.amount} MINA to ${transferContent.recipient}, Transaction: ${pendingTx.hash}`,
                    content: {
                        success: true,
                        hash: pendingTx.hash,
                        amount: transferContent.amount,
                        recipient: transferContent.recipient,
                    },
                });
            }

            return true;
        } catch (error) {
            console.error("Error during token transfer:", error);
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
                    text: "Send 1 MINA tokens to B62qkGSBuLmqYApYoWTmAzUtwFVx6Fe9ZStJVPzCwLjWZ5NQDYTiqEU",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll send 1 MINA tokens now...",
                    action: "SEND_TOKEN",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Successfully sent 1 MINA tokens to B62qkGSBuLmqYApYoWTmAzUtwFVx6Fe9ZStJVPzCwLjWZ5NQDYTiqEU, Transaction: 5JubcrecAwfDzftUAkGVfmemnDBJA4rUobJP2vBFr7ZNWuUCsdXP",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
