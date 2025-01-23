import type {
    Action,
    IAgentRuntime,
    Memory,
    State,
    HandlerCallback,
} from "@elizaos/core";
import {
    generateObject,
    composeContext,
    ModelClass,
} from "@elizaos/core";
import {
    createPublicClient,
    createWalletClient,
    http,
    parseCFX,
    encodeFunctionData,
} from "cive";
import { hexAddressToBase32 } from "cive/utils";
import { privateKeyToAccount } from "cive/accounts";
import { testnet } from "cive/chains";
import { confluxBridgeTransferTemplate } from "../templates/bridgeTransfer";
import { TransferSchema, isTransferContent } from "../types";
import CrossSpaceCallAbi from "../abi/crossSpaceCall";

const bridgeSendCFX = async (
    secretKey: `0x${string}`,
    rpcUrl: string,
    espaceTo: `0x${string}`,
    amount: string
) => {
    const client = createPublicClient({
        transport: http(rpcUrl),
    });
    const networkId = await client.getChainId();
    const account = privateKeyToAccount(secretKey, { networkId });

    const walletClient = createWalletClient({
        transport: http(rpcUrl),
        chain: testnet,
    });

    const toAddress = hexAddressToBase32({
        hexAddress: "0x0888000000000000000000000000000000000006",
        networkId,
    }); // crossSpaceCall Address

    const hash = await walletClient.sendTransaction({
        account,
        to: toAddress,
        value: parseCFX(amount),
        chain: testnet,
        data: encodeFunctionData({
            abi: CrossSpaceCallAbi,
            functionName: "transferEVM",
            args: [espaceTo],
        }),
    });

    // await client.waitForTransactionReceipt({
    //     hash,
    // });
    return hash;
};

export const bridgeTransfer: Action = {
    name: "BRIDGE_SEND_CFX",
    description:
        "Bridge transfer CFX from Conflux Core Space to another in Conflux eSpace. The address is a 0x-prefix address",
    similes: [
        "BRIDGE_SEND_CONFLUX",
        "CROSS_SPACE_SEND_CFX",
        "BRIDGE_TRANSFER_CFX",
        "CROSS_SPACE_TRANSFER_CFX",
    ],
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Send 1 CFX to eSpace Address 0x119DA8bbe74B1C5c987D0c64D10eC1dB301d4752",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "1 CFX sent to espace Address 0x119DA8bbe74B1C5c987D0c64D10eC1dB301d4752: 0x1234567890abcdef",
                    content: {
                        to: "0x119DA8bbe74B1C5c987D0c64D10eC1dB301d4752",
                        amount: "1",
                    },
                },
            },
        ],
    ],
    // eslint-disable-next-line
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        // no extra validation needed
        return true;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        options?: { [key: string]: unknown },
        callback?: HandlerCallback
    ) => {
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        const context = composeContext({
            state,
            template: confluxBridgeTransferTemplate,
        });

        const content = await generateObject({
            runtime,
            context,
            modelClass: ModelClass.LARGE,
            schema: TransferSchema,
        });

        if (!isTransferContent(content.object)) {
            throw new Error("Invalid content");
        }

        const secretKey = runtime.getSetting(
            "CONFLUX_CORE_PRIVATE_KEY"
        ) as `0x${string}`;
        const rpcUrl = runtime.getSetting("CONFLUX_CORE_SPACE_RPC_URL");

        let success = false;

        try {
            const hash = await bridgeSendCFX(
                secretKey,
                rpcUrl,
                content.object.to as `0x${string}`,
                content.object.amount.toString()
            );
            success = true;
            if (!callback) {
                return success;
            }
            callback({
                text: `${content.object.amount} CFX sent to ${content.object.to}: ${hash}`,
                content: content.object,
            });
        } catch (error) {
            console.error(`Error sending CFX: ${error}`);
            if (!callback) {
                return success;
            }
            callback({
                text: `Failed to send ${content.object.amount} CFX to ${content.object.to}: ${error}`,
            });
        }
        return success;
    },
};
