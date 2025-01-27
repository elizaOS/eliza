import {
    Action,
    ActionExample,
    composeContext,
    generateObjectDeprecated,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
} from "@elizaos/core";
import { evmWalletProvider, initWalletProvider } from "@elizaos/plugin-evm";
import { GithubRegistry } from "@hyperlane-xyz/registry";

import {
    ChainMap,
    ChainMetadata,
    ChainName,
    HyperlaneCore,
    HyperlaneRelayer,
    MultiProvider,
} from "@hyperlane-xyz/sdk";
import { CommandContext, WriteCommandContext } from "./context";
import { runPreflightChecksForChains, stubMerkleTreeConfig } from "./utils";

import { addressToBytes32, timeout } from "@hyperlane-xyz/utils";
import { MINIMUM_TEST_SEND_GAS } from "./consts";

export async function sendMessage({
    context,
    origin,
    destination,
    recipient,
    messageBody,
    timeoutSec,
    skipWaitForDelivery,
    selfRelay,
}: {
    context: WriteCommandContext;
    origin: ChainName;
    destination: ChainName;
    recipient: string;
    messageBody: string;
    timeoutSec: number;
    skipWaitForDelivery: boolean;
    selfRelay?: boolean;
}) {
    await runPreflightChecksForChains({
        context,
        chains: [origin, destination],
        chainsToGasCheck: [origin],
        minGas: MINIMUM_TEST_SEND_GAS,
    });

    await timeout(
        executeDelivery({
            context,
            origin,
            destination,
            recipient,
            messageBody,
            skipWaitForDelivery,
            selfRelay,
        }),
        timeoutSec * 1000,
        "Timed out waiting for messages to be delivered"
    );
}

async function executeDelivery({
    context,
    origin,
    destination,
    recipient,
    messageBody,
    skipWaitForDelivery,
    selfRelay,
}: {
    context: CommandContext;
    origin: ChainName;
    destination: ChainName;
    recipient: string;
    messageBody: string;
    skipWaitForDelivery: boolean;
    selfRelay?: boolean;
}) {
    const { registry, multiProvider } = context;
    const chainAddresses = await registry.getAddresses();
    const core = HyperlaneCore.fromAddressesMap(chainAddresses, multiProvider);

    try {
        if (!recipient) {
            throw new Error(`Unable to find TestRecipient for ${destination}`);
        }
        const formattedRecipient = addressToBytes32(recipient);

        // log("Dispatching message");
        const { dispatchTx, message } = await core.sendMessage(
            origin,
            destination,
            formattedRecipient,
            messageBody,
            // override the default hook (with IGP) for self-relay to avoid race condition with the production relayer
            selfRelay ? chainAddresses[origin].merkleTreeHook : undefined
        );
        // logBlue(
        //     `Sent message from ${origin} to ${recipient} on ${destination}.`
        // );
        // logBlue(`Message ID: ${message.id}`);
        // logBlue(`Explorer Link: ${EXPLORER_URL}/message/${message.id}`);
        // log(
        //     `Message:\n${indentYamlOrJson(yamlStringify(message, null, 2), 4)}`
        // );

        if (selfRelay) {
            const relayer = new HyperlaneRelayer({ core });

            const hookAddress = await core.getSenderHookAddress(message);
            const merkleAddress = chainAddresses[origin].merkleTreeHook;
            stubMerkleTreeConfig(relayer, origin, hookAddress, merkleAddress);

            // log("Attempting self-relay of message");
            await relayer.relayMessage(dispatchTx);
            // logGreen("Message was self-relayed!");
        } else {
            if (skipWaitForDelivery) {
                return;
            }

            // log("Waiting for message delivery on destination chain...");
            // Max wait 10 minutes
            await core.waitForMessageProcessed(dispatchTx, 10000, 60);
            // logGreen("Message was delivered!");
        }
    } catch (e) {
        // errorRed(
        //     `Encountered error sending message from ${origin} to ${destination}`
        // );
        throw e;
    }
}

export const sendCrossChainMessage: Action = {
    name: "SEND_CROSS_CHAIN_MESSAGE",
    similes: ["SEND_MESSAGE", "TRANSFER_MESSAGE", "CROSS_CHAIN_SEND"],
    description: "Send a message between any supported chains using Hyperlane",
    validate: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State
    ): Promise<boolean> => {
        const res = await evmWalletProvider.get(runtime, message, state);

        if (res) {
            return Promise.resolve(true);
        } else {
            return Promise.reject(false);
        }
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        options?: {
            [key: string]: unknown;
        },
        callback?: HandlerCallback
    ) => {
        try {
            if (!state) {
                state = (await runtime.composeState(message)) as State;
            } else {
                state = await runtime.updateRecentMessageState(state);
            }

            const walletProvider = await initWalletProvider(runtime);

            // Compose swap context
            const sendContext = composeContext({
                state,
                template: "", // TODO: Add template
            });
            const content = await generateObjectDeprecated({
                runtime,
                context: sendContext,
                modelClass: ModelClass.LARGE,
            });

            const registry = new GithubRegistry();
            const chainMetadata = await registry.getMetadata();

            const context: CommandContext = {
                registry: registry, // Initialize with Hyperlane registry instance
                multiProvider: new MultiProvider(chainMetadata), // Initialize with multi-provider instance
                skipConfirmation: true, // Set based on requirements
                key: "your-key", // Optional key if needed
                signerAddress: "signer-address", // Optional EVM signer address
                strategyPath: "path/to/strategy", // Optional strategy path
            };

            const sendOptions = {
                context: context as WriteCommandContext,
                origin: content.sourceChain,
                destination: content.targetChain,
                recipient: content.recipientAddress,
                messageBody: content.message,
                timeoutSec: content.timeoutSec ?? 60,
                skipWaitForDelivery: content.skipWaitForDelivery ?? false,
            };

            await sendMessage({
                ...sendOptions,
            });

            return Promise.resolve(true);
        } catch (error) {
            console.error(
                "Error in sendCrossChainMessage handler:",
                error.message
            );
            if (callback) {
                callback({ text: `Error: ${error.message}` });
            }

            return Promise.resolve(false);
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Send a message from Ethereum to Polygon",
                    options: {
                        sourceChain: "ethereum",
                        targetChain: "polygon",
                        recipientAddress: "0x1234...",
                        message: "Hello Cross Chain!",
                    },
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll send your message across chains.",
                    action: "SEND_CROSS_CHAIN_MESSAGE",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully sent message across chains. Transaction hash: 0xabcd...",
                },
            },
        ],
    ] as ActionExample[][],
};
