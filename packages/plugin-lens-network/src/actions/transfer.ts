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
    generateObject,
} from "@elizaos/core";
import { validateLensConfig } from "../environment";
import { getDefaultProvider, Network, Wallet } from "@lens-network/sdk/ethers";
import { ethers, type Provider as EthersProvider } from "ethers";
import { Provider as ZkSyncProvider } from "zksync-ethers";

import {
    type Address,
    parseEther,
    isAddress,
} from "viem";

import { z } from "zod";

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

        typeof content.recipient === "string" &&
        (typeof content.amount === "string" ||
            typeof content.amount === "number");
    if (!validTypes) {
        return false;
    }

    // Validate addresses
    const validAddresses =

        content.recipient.startsWith("0x") &&
        content.recipient.length === 42;

    return validAddresses;
}

const transferTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Here are several frequently used addresses. Use these for the corresponding tokens:
- ETH/eth: 0x000000000000000000000000000000000000800A


Example response:
\`\`\`json
{

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

//const ETH_ADDRESS = "0x000000000000000000000000000000000000800A";

export async function setupProviders(): Promise<{ lensProvider: ZkSyncProvider; ethProvider: EthersProvider }> {
    // Initialize providers for both L2 (Lens) and L1 (Ethereum)
    const lensProvider = getDefaultProvider(Network.Testnet) as unknown as ZkSyncProvider;
    const ethProvider = ethers.getDefaultProvider("sepolia");

    return { lensProvider, ethProvider };
}

export async function setupWallet(
    lensProvider: ZkSyncProvider,
    ethProvider: EthersProvider,
    key: string
) {
    // Create wallet instance with both L2 and L1 providers
    const wallet = new Wallet(key, lensProvider, ethProvider);

    return wallet;
}

export async function transferTokens(
    wallet: Wallet,
    recipientAddress: string,
    amount: string
) {
    try {
        // Validate recipient address
        if (!isAddress(recipientAddress)) {
            throw new Error("Invalid recipient address");
        }

        // Create transaction object
        const tx = {
            to: recipientAddress,
            value: parseEther(amount),
        };

        // Send transaction
        console.log(
            `Initiating transfer of ${amount} tokens to ${recipientAddress}...`
        );
        const transaction = await wallet.sendTransaction(tx);

        // Wait for transaction confirmation
        console.log(`Transaction hash: ${transaction.hash}`);
        const receipt = await transaction.wait();

        console.log("Transfer completed successfully!");
        console.log("Transaction receipt:", receipt);

        return transaction.hash;
    } catch (error) {
        console.error("Error transferring tokens:", error);
        throw error;
    }
}

export default {
    name: "SEND_TOKEN",
    similes: [
        "TRANSFER_TOKEN_ON_LENS",
        "TRANSFER_TOKENS_ON_LENS",
        "SEND_TOKENS_ON_LENS",
        "SEND_GRASS_ON_LENS",
        "PAY_ON_LENS",
        "MOVE_TOKENS_ON_LENS",
        "MOVE_GRASS_ON_LENS",
    ],
    // eslint-disable-next-line
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        await validateLensConfig(runtime);
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
        elizaLogger.log("Starting LENS SEND_TOKEN handler...");

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
        const content = (
            await generateObject({
                runtime,
                context: transferContext,
                modelClass: ModelClass.SMALL,
                schemaName: "TransferSchema",
                schemaDescription: "Schema for token transfer with tokenAddress, recipient, and amount"
            })
        ).object as TransferContent;

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
            const PRIVATE_KEY = runtime.getSetting("LENS_PRIVATE_KEY");
            if (!PRIVATE_KEY) {
                throw new Error("LENS_PRIVATE_KEY not found in runtime settings");
            }
            const { lensProvider, ethProvider } = await setupProviders();
            const wallet = await setupWallet(
                lensProvider,
                ethProvider,
                PRIVATE_KEY
            );
            const amount = content.amount.toString();

            let hash: string;

            hash = await transferTokens(
                wallet,
                content.recipient as Address,
                amount
            );

            elizaLogger.success(
                `Transfer completed successfully! Transaction hash: ${hash}`
            );
            if (callback) {
                callback({
                    text: `Transfer completed successfully! Transaction hash: ${hash}`,
                    content: {},
                });
            }

            return true;
        } catch (error: unknown) {
            elizaLogger.error("Error during token transfer:", error);
            if (callback) {
                callback({
                    text: `Error transferring tokens: ${error instanceof Error ? error.message : String(error)}`,
                    content: { error: error instanceof Error ? error.message : String(error) },
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
                    text: "Send 1 Grass to 0xCCa8009f5e09F8C5dB63cb0031052F9CB635Af62",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Sure, I'll send 1 Grass to that address now.",
                    action: "SEND_TOKEN",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully sent 1 Grass to 0xCCa8009f5e09F8C5dB63cb0031052F9CB635Af62\nTransaction: 0x4fed598033f0added272c3ddefd4d83a521634a738474400b27378db462a76ec",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Please send 0.1 GRASS to 0xbD8679cf79137042214fA4239b02F4022208EE82",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Of course. Sending 0.1 Grass to that address now.",
                    action: "SEND_TOKEN",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully sent 0.1 Grass to 0xbD8679cf79137042214fA4239b02F4022208EE82\nTransaction: 0x0b9f23e69ea91ba98926744472717960cc7018d35bc3165bdba6ae41670da0f0",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
