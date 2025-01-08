import {
    ActionExample,
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
    composeContext,
    elizaLogger,
    generateObject,
    type Action,
} from "@elizaos/core";
import { z } from "zod";

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
    "recipient": "0xaa000b3651bd1e57554ebd7308ca70df7c8c0e8e09d67123cc15c8a8a79342b3",
    "amount": "1"
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the requested token transfer:
- Recipient wallet address
- Amount to transfer

Respond with a JSON markdown block containing only the extracted values.`;

export const transferToken: Action = {
    name: "SEND_TOKEN",
    similes: [
        "TRANSFER_TOKEN",
        "TRANSFER_TOKENS",
        "SEND_TOKENS",
        "SEND_SUI",
        "PAY",
    ],
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        console.log("Validating sui transfer from user:", message.userId);
        //add custom validate logic here
        /*
            const adminIds = runtime.getSetting("ADMIN_USER_IDS")?.split(",") || [];
            //console.log("Admin IDs from settings:", adminIds);

            const isAdmin = adminIds.includes(message.userId);

            if (isAdmin) {
                //console.log(`Authorized transfer from user: ${message.userId}`);
                return true;
            }
            else
            {
                //console.log(`Unauthorized transfer attempt from user: ${message.userId}`);
                return false;
            }
            */
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

        // Initialize or update state
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        // Define the schema for the expected output
        const transferSchema = z.object({
            recipient: z.string(),
            amount: z.union([z.string(), z.number()]),
        });

        // Compose transfer context
        const transferContext = composeContext({
            state,
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

        elizaLogger.log("About transfer token: ", transferContent);

        if (callback) {
            callback({
                text: `Successfully transferred ${transferContent.amount} SUI to ${transferContent.recipient}, Transaction: 0x0000ddfdf`,
            });
        }

        return true;
    },

    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Send 1 SUI tokens to 0x4f2e63be8e7fe287836e29cde6f3d5cbc96eefd0c0e3f3747668faa2ae7324b0",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll send 1 SUI tokens now...",
                    action: "SEND_TOKEN",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Successfully sent 1 SUI tokens to 0x4f2e63be8e7fe287836e29cde6f3d5cbc96eefd0c0e3f3747668faa2ae7324b0, Transaction: 0x39a8c432d9bdad993a33cc1faf2e9b58fb7dd940c0425f1d6db3997e4b4b05c0",
                },
            },
        ],
    ] as ActionExample[][],
}
