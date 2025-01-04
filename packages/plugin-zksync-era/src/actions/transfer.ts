import {
    ActionExample,
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
    type Action,
    elizaLogger,
    composeContext,
    generateObject,
} from "@elizaos/core";
import { validateZKsyncConfig } from "../enviroment";

import { Web3 } from "web3";
import { ZKsyncPlugin, types, Web3ZKsyncL2 } from "web3-plugin-zksync";

export interface TransferContent extends Content {
    tokenAddress: string;
    recipient: string;
    amount: string | number;
}

export function isTransferContent(
    content: TransferContent
): content is TransferContent {
    // Validate types
    const validTypes =
        typeof content.tokenAddress === "string" &&
        typeof content.recipient === "string" &&
        (typeof content.amount === "string" ||
            typeof content.amount === "number");
    if (!validTypes) {
        return false;
    }

    // Validate addresses
    const validAddresses =
        content.tokenAddress.startsWith("0x") &&
        content.tokenAddress.length === 42 &&
        content.recipient.startsWith("0x") &&
        content.recipient.length === 42;

    return validAddresses;
}

const transferTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Here are several frequently used addresses. Use these for the corresponding tokens:
- ZK/zk: 0x5A7d6b2F92C77FAD6CCaBd7EE0624E64907Eaf3E
- ETH/eth: 0x000000000000000000000000000000000000800A
- USDC/usdc: 0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4

Example response:
\`\`\`json
{
    "tokenAddress": "0x5A7d6b2F92C77FAD6CCaBd7EE0624E64907Eaf3E",
    "recipient": "0xCCa8009f5e09F8C5dB63cb0031052F9CB635Af62",
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
    name: "SEND_TOKEN",
    similes: [
        "TRANSFER_TOKEN_ON_ZKSYNC",
        "TRANSFER_TOKEN_ON_ERA",
        "TRANSFER_TOKENS_ON_ZKSYNC",
        "TRANSFER_TOKENS_ON_ERA",
        "SEND_TOKENS_ON_ZKSYNC",
        "SEND_TOKENS_ON_ERA",
        "SEND_ETH_ON_ZKSYNC",
        "SEND_ETH_ON_ERA",
        "PAY_ON_ZKSYNC",
        "PAY_ON_ERA",
    ],
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        await validateZKsyncConfig(runtime);
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

        // Compose transfer context
        const transferContext = composeContext({
            state,
            template: transferTemplate,
        });

        // Generate transfer content
        const content = await generateObject({
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

        try {
            const PRIVATE_KEY = runtime.getSetting("ZKSYNC_PRIVATE_KEY")!;
            const PUBLIC_KEY = runtime.getSetting("ZKSYNC_ADDRESS")!;

            const web3: Web3 = new Web3(/* optional L1 provider */);

            web3.registerPlugin(
                new ZKsyncPlugin(
                    Web3ZKsyncL2.initWithDefaultProvider(types.Network.Mainnet)
                )
            );

            const smartAccount = new web3.ZKsync.SmartAccount({
                address: PUBLIC_KEY,
                secret: "0x" + PRIVATE_KEY,
            });

            const transferTx = await smartAccount.transfer({
                to: content.recipient,
                token: content.tokenAddress,
                amount: web3.utils.toWei(content.amount, "ether"),
            });

            const receipt = await transferTx.wait();

            elizaLogger.success(
                "Transfer completed successfully! tx: " +
                    receipt.transactionHash
            );
            if (callback) {
                callback({
                    text:
                        "Transfer completed successfully! tx: " +
                        receipt.transactionHash,
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
    },

    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Send 100 USDC to 0xCCa8009f5e09F8C5dB63cb0031052F9CB635Af62",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Sure, I'll send 100 USDC to that address now.",
                    action: "SEND_TOKEN",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully sent 100 USDC to 0xCCa8009f5e09F8C5dB63cb0031052F9CB635Af62\nTransaction: 0x4fed598033f0added272c3ddefd4d83a521634a738474400b27378db462a76ec",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Please send 100 ZK tokens to 0xbD8679cf79137042214fA4239b02F4022208EE82",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Of course. Sending 100 ZK to that address now.",
                    action: "SEND_TOKEN",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully sent 100 ZK to 0xbD8679cf79137042214fA4239b02F4022208EE82\nTransaction: 0x0b9f23e69ea91ba98926744472717960cc7018d35bc3165bdba6ae41670da0f0",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
