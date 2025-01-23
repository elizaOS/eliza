import { elizaLogger, settings } from "@elizaos/core";
import {
    Connection,
    PublicKey,
    SystemProgram,
    TransactionMessage,
    VersionedTransaction,
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
import { getWalletKey } from "../keypairUtils";
import { generateObjectDeprecated } from "@elizaos/core";

interface SolTransferContent extends Content {
    recipient: string;
    amount: number;
}

function isSolTransferContent(
    content: any
): content is SolTransferContent {
    return (
        typeof content.recipient === "string" &&
        typeof content.amount === "number"
    );
}

const solTransferTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "recipient": "9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
    "amount": 1.5
}
\`\`\`

{{recentMessages}}

Extract the following information about the requested SOL transfer:
- Recipient wallet address
- Amount of SOL to transfer
`;

export default {
    name: "SEND_SOL",
    similes: ["TRANSFER_SOL", "PAY_SOL", "TRANSACT_SOL"],
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        // Always return true for SOL transfers, letting the handler deal with specifics
        elizaLogger.log("Validating SOL transfer from user:", message.userId);
        return true;
    },
    description: "Transfer native SOL from agent's wallet to specified address",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting SEND_SOL handler...");

        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        const transferContext = composeContext({
            state,
            template: solTransferTemplate,
        });

        const content = await generateObjectDeprecated({
            runtime,
            context: transferContext,
            modelClass: ModelClass.LARGE,
        });

        if (!isSolTransferContent(content)) {
            if (callback) {
                callback({
                    text: "Need an address and the amount of SOL to send.",
                    content: { error: "Invalid transfer content" },
                });
            }
            return false;
        }

        try {
            const { keypair: senderKeypair } = await getWalletKey(runtime, true);
            const connection = new Connection(settings.SOLANA_RPC_URL!);
            const recipientPubkey = new PublicKey(content.recipient);

            const lamports = content.amount * 1e9;

            const instruction = SystemProgram.transfer({
                fromPubkey: senderKeypair.publicKey,
                toPubkey: recipientPubkey,
                lamports,
            });

            const messageV0 = new TransactionMessage({
                payerKey: senderKeypair.publicKey,
                recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
                instructions: [instruction],
            }).compileToV0Message();

            const transaction = new VersionedTransaction(messageV0);
            transaction.sign([senderKeypair]);

            const signature = await connection.sendTransaction(transaction);

            if (callback) {
                callback({
                    text: `Sent ${content.amount} SOL. Transaction hash: ${signature}`,
                    content: {
                        success: true,
                        signature,
                        amount: content.amount,
                        recipient: content.recipient,
                    },
                });
            }

            return true;
        } catch (error) {
            elizaLogger.error("Error during SOL transfer:", error);
            if (callback) {
                callback({
                    text: `Problem with the SOL transfer: ${error.message}`,
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
                    text: "Send 1.5 SOL to 9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Sure thing, SOL on its way.",
                    action: "SEND_SOL",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;