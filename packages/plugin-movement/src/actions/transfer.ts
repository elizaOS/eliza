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
import {
    Account,
    Aptos,
    AptosConfig,
    Ed25519PrivateKey,
    Network,
    PrivateKey,
    PrivateKeyVariants,
} from "@aptos-labs/ts-sdk";
import { walletProvider } from "../providers/wallet";
import {
    MOVEMENT_NETWORK_CONFIG,
    MOVE_DECIMALS,
    MOVEMENT_EXPLORER_URL,
} from "../constants";

export interface TransferContent extends Content {
    recipient: string;
    amount: string | number;
}

function isTransferContent(content: unknown): content is TransferContent {
    elizaLogger.debug("Validating transfer content:", content);
    return (
        typeof (content as TransferContent).recipient === "string" &&
        (typeof (content as TransferContent).amount === "string" ||
            typeof (content as TransferContent).amount === "number")
    );
}

const transferTemplate = `You are processing a token transfer request. Extract the recipient address and amount from the message.

Example request: "can you send 1 move to 0x123..."
Example response:
\`\`\`json
{
    "recipient": "0x123...",
    "amount": "1"
}
\`\`\`

Rules:
1. The recipient address always starts with "0x"
2. The amount is typically a number less than 100
3. Return exact values found in the message

Recent messages:
{{recentMessages}}

Extract and return ONLY the following in a JSON block:
- recipient: The wallet address starting with 0x
- amount: The number of tokens to send

Return ONLY the JSON block with these two fields.`;

export default {
    name: "TRANSFER_MOVE",
    similes: [
        "SEND_TOKEN",
        "TRANSFER_TOKEN",
        "TRANSFER_TOKENS",
        "SEND_TOKENS",
        "SEND_MOVE",
        "PAY",
    ],
    triggers: [
        "send move",
        "send 1 move",
        "transfer move",
        "send token",
        "transfer token",
        "can you send",
        "please send",
        "send",
    ],
    shouldHandle: (message: Memory) => {
        const text = message.content?.text?.toLowerCase() || "";
        return (
            text.includes("send") &&
            text.includes("move") &&
            text.includes("0x")
        );
    },
    validate: async (_runtime: IAgentRuntime, message: Memory) => {
        elizaLogger.debug(
            "Starting transfer validation for user:",
            message.userId
        );
        elizaLogger.debug("Message text:", message.content?.text);
        return true; // Let the handler do the validation
    },
    priority: 1000, // High priority for transfer actions
    description:
        "Transfer Move tokens from the agent's wallet to another address",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.debug("Starting TRANSFER_MOVE handler...");
        elizaLogger.debug("Message:", {
            text: message.content?.text,
            userId: message.userId,
            action: message.content?.action,
        });

        try {
            const privateKey = runtime.getSetting("MOVEMENT_PRIVATE_KEY");
            elizaLogger.debug(
                "Got private key:",
                privateKey ? "Present" : "Missing"
            );

            const network = runtime.getSetting("MOVEMENT_NETWORK");
            elizaLogger.debug("Network config:", network);
            elizaLogger.debug(
                "Available networks:",
                Object.keys(MOVEMENT_NETWORK_CONFIG)
            );

            const movementAccount = Account.fromPrivateKey({
                privateKey: new Ed25519PrivateKey(
                    PrivateKey.formatPrivateKey(
                        privateKey,
                        PrivateKeyVariants.Ed25519
                    )
                ),
            });
            elizaLogger.debug(
                "Created Movement account:",
                movementAccount.accountAddress.toStringLong()
            );

            const aptosClient = new Aptos(
                new AptosConfig({
                    network: Network.CUSTOM,
                    fullnode: MOVEMENT_NETWORK_CONFIG[network].fullnode,
                })
            );
            elizaLogger.debug(
                "Created Aptos client with network:",
                MOVEMENT_NETWORK_CONFIG[network].fullnode
            );

            const walletInfo = await walletProvider.get(
                runtime,
                message,
                state
            );
            state.walletInfo = walletInfo;

            // Initialize or update state
            let currentState: State;
            if (!state) {
                currentState = (await runtime.composeState(message)) as State;
            } else {
                currentState = await runtime.updateRecentMessageState(state);
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
                console.error("Invalid content for TRANSFER_TOKEN action.");
                if (callback) {
                    callback({
                        text: "Unable to process transfer request. Invalid content provided.",
                        content: { error: "Invalid transfer content" },
                    });
                }
                return false;
            }

            const adjustedAmount = BigInt(
                Number(content.amount) * 10 ** MOVE_DECIMALS
            );
            console.log(
                `Transferring: ${content.amount} tokens (${adjustedAmount} base units)`
            );

            const tx = await aptosClient.transaction.build.simple({
                sender: movementAccount.accountAddress.toStringLong(),
                data: {
                    function: "0x1::aptos_account::transfer",
                    typeArguments: [],
                    functionArguments: [content.recipient, adjustedAmount],
                },
            });
            const committedTransaction =
                await aptosClient.signAndSubmitTransaction({
                    signer: movementAccount,
                    transaction: tx,
                });
            const executedTransaction = await aptosClient.waitForTransaction({
                transactionHash: committedTransaction.hash,
            });

            const explorerUrl = `${MOVEMENT_EXPLORER_URL}/${executedTransaction.hash}?network=${MOVEMENT_NETWORK_CONFIG[network].explorerNetwork}`;
            elizaLogger.debug("Transfer successful:", {
                hash: executedTransaction.hash,
                amount: content.amount,
                recipient: content.recipient,
                explorerUrl,
            });

            if (callback) {
                callback({
                    text: `Successfully transferred ${content.amount} MOVE to ${content.recipient}\nTransaction: ${executedTransaction.hash}\nView on Explorer: ${explorerUrl}`,
                    content: {
                        success: true,
                        hash: executedTransaction.hash,
                        amount: content.amount,
                        recipient: content.recipient,
                        explorerUrl,
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
                    text: "can you send 1 move to 0xa07ab7d3739dc793f9d538f7d7163705176ba59f7a8c994a07357a3a7d97d843",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll help you transfer 1 Move token...",
                    action: "TRANSFER_MOVE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "send 1 move to 0xa07ab7d3739dc793f9d538f7d7163705176ba59f7a8c994a07357a3a7d97d843",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Processing Move token transfer...",
                    action: "TRANSFER_MOVE",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
