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

class TransferValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TransferValidationError';
    }
}

class InsufficientBalanceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InsufficientBalanceError';
    }
}

export interface TransferContent extends Content {
    recipient: string;
    amount: string | number;
}

function isTransferContent(content: any): content is TransferContent {
    return (
        typeof content.recipient === "string" &&
        /^0x[a-fA-F0-9]{64}$/.test(content.recipient) &&
        (typeof content.amount === "string" ||
            typeof content.amount === "number") &&
        Number(content.amount) > 0
    );
}

const transferTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "recipient": "0x2badda48c062e861ef17a96a806c451fd296a49f45b272dee17f85b0e32663fd",
    "amount": "1000"
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
        "SEND_TRK",
        "PAY",
    ],
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        elizaLogger.log("Validating trikon transfer from user:", message.userId);
        try {
            // Add actual validation logic here
            return true;
        } catch (error) {
            elizaLogger.error("Validation error:", error);
            return false;
        }
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

        try {
            if (!state) {
                state = (await runtime.composeState(message)) as State;
            } else {
                state = await runtime.updateRecentMessageState(state);
            }

            const transferContext = composeContext({
                state,
                template: transferTemplate,
            });

            const content = await generateObjectDeprecated({
                runtime,
                context: transferContext,
                modelClass: ModelClass.SMALL,
            });

            if (!isTransferContent(content)) {
                throw new TransferValidationError("Invalid transfer content provided");
            }

            // TODO: Implement actual transfer logic here
            elizaLogger.log(
                `Would transfer ${content.amount} tokens to ${content.recipient}`
            );

            if (callback) {
                callback({
                    text: `Transfer simulation successful for ${content.amount} TRK to ${content.recipient}`,
                    content: {
                        success: true,
                        amount: content.amount,
                        recipient: content.recipient,
                    },
                });
            }

            return true;
        } catch (error) {
            if (error instanceof TransferValidationError) {
                elizaLogger.error("Transfer validation error:", error);
                if (callback) {
                    callback({
                        text: `Invalid transfer request: ${error.message}`,
                        content: { error: error.message },
                    });
                }
            } else if (error instanceof InsufficientBalanceError) {
                elizaLogger.error("Insufficient balance:", error);
                if (callback) {
                    callback({
                        text: `Insufficient balance: ${error.message}`,
                        content: { error: error.message },
                    });
                }
            } else {
                elizaLogger.error("Unexpected error during token transfer:", error);
                if (callback) {
                    callback({
                        text: `Error transferring tokens: ${error.message}`,
                        content: { error: error.message },
                    });
                }
            }
            return false;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Send 100 TRK tokens to 0x4f2e63be8e7fe287836e29cde6f3d5cbc96eefd0c0e3f3747668faa2ae7324b0",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll send 100 TRK tokens now...",
                    action: "SEND_TOKEN",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Successfully sent 100 TRK tokens to 0x4f2e63be8e7fe287836e29cde6f3d5cbc96eefd0c0e3f3747668faa2ae7324b0",
                },
            },
        ],
        // Added example for failed transfer
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Send 1000000 TRK tokens to 0x4f2e63be8e7fe287836e29cde6f3d5cbc96eefd0c0e3f3747668faa2ae7324b0",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Unable to send tokens - insufficient balance",
                    action: "SEND_TOKEN",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
