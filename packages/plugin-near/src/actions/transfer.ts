import {
    type ActionExample,
    type Content,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State,
    elizaLogger,
    type Action,
    composeContext,
    generateObject,
} from "@elizaos/core";
import { connect, keyStores, utils } from "near-api-js";
import type { KeyPairString } from "near-api-js/lib/utils";
import { utils as nearUtils } from "near-api-js";
// import BigNumber from "bignumber.js";

export interface TransferContent extends Content {
    recipient: string;
    amount: string | number;
    tokenAddress?: string; // Optional for native NEAR transfers
}

function isTransferContent(
    _runtime: IAgentRuntime,
    content: unknown
): content is TransferContent {
    return (
        typeof (content as TransferContent).recipient === "string" &&
        (typeof (content as TransferContent).amount === "string" ||
            typeof (content as TransferContent).amount === "number")
    );
}

const transferTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "recipient": "bob.near",
    "amount": "1.5",
    "tokenAddress": null
}
\`\`\`

{{recentMessages}}

Given the recent messages and wallet information below:

{{walletInfo}}

Extract the following information about the requested token transfer:
- Recipient address (NEAR account)
- Amount to transfer
- Token contract address (null for native NEAR transfers)

Respond with a JSON markdown block containing only the extracted values.`;

async function transferNEAR(
    runtime: IAgentRuntime,
    recipient: string,
    amount: string
): Promise<string> {
    const networkId = runtime.getSetting("NEAR_NETWORK") || "testnet";
    const nodeUrl =
        runtime.getSetting("NEAR_RPC_URL") || "https://rpc.testnet.near.org";
    const accountId = runtime.getSetting("NEAR_ADDRESS");
    const secretKey = runtime.getSetting("NEAR_WALLET_SECRET_KEY");

    if (!accountId || !secretKey) {
        throw new Error("NEAR wallet credentials not configured");
    }

    // Convert amount to yoctoNEAR (1 NEAR = 10^24 yoctoNEAR)
    // const yoctoAmount = new BigNumber(amount).multipliedBy(new BigNumber(10).pow(24)).toFixed(0);

    // Create keystore and connect to NEAR
    const keyStore = new keyStores.InMemoryKeyStore();
    const keyPair = utils.KeyPair.fromString(secretKey as KeyPairString);
    await keyStore.setKey(networkId, accountId, keyPair);

    const nearConnection = await connect({
        networkId,
        keyStore,
        nodeUrl,
    });

    const account = await nearConnection.account(accountId);

    // Execute transfer with null check
    const parsedAmount = utils.format.parseNearAmount(amount);
    if (!parsedAmount) {
        throw new Error("Failed to parse NEAR amount");
    }

    const result = await account.sendMoney(recipient, BigInt(parsedAmount));

    return result.transaction.hash;
}

export const executeTransfer: Action = {
    name: "SEND_NEAR",
    similes: ["TRANSFER_NEAR", "SEND_TOKENS", "TRANSFER_TOKENS", "PAY_NEAR"],
    validate: async (_runtime: IAgentRuntime, _message: Memory) => {
        return true; // Add your validation logic here
    },
    description: "Transfer NEAR tokens to another account",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
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
        const content = await generateObject({
            runtime,
            context: transferContext,
            modelClass: ModelClass.SMALL,
        });

        // Validate transfer content
        if (!isTransferContent(runtime, content)) {
            elizaLogger.error("Invalid content for TRANSFER_NEAR action.");
            if (callback) {
                callback({
                    text: "Unable to process transfer request. Invalid content provided.",
                    content: { error: "Invalid transfer content" },
                });
            }
            return false;
        }

        try {
            const txHash = await transferNEAR(
                runtime,
                content.recipient,
                content.amount.toString()
            );

            if (callback) {
                callback({
                    text: `Successfully transferred ${content.amount} NEAR to ${content.recipient}\nTransaction: ${txHash}`,
                    content: {
                        success: true,
                        signature: txHash,
                        amount: content.amount,
                        recipient: content.recipient,
                    },
                });
            }

            return true;
        } catch (error) {
            elizaLogger.error("Error during NEAR transfer:", error);
            if (callback) {
                callback({
                    text: `Error transferring NEAR: ${error}`,
                    content: { error: error },
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
                    text: "Send 1.5 NEAR to bob.testnet",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll send 1.5 NEAR now...",
                    action: "SEND_NEAR",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Successfully sent 1.5 NEAR to bob.testnet\nTransaction: ABC123XYZ",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
