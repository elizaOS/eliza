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
import { createPublicClient, createWalletClient, http, parseCFX } from "cive";
import { privateKeyToAccount } from "cive/accounts";
import { testnet } from "cive/chains";
import { confluxTransferTemplate } from "../templates/transfer";
import { TransferSchema, isTransferContent } from "../types";

const sendCFX = async (
    secretKey: `0x${string}`,
    rpcUrl: string,
    to: string,
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

    const hash = await walletClient.sendTransaction({
        account,
        to,
        value: parseCFX(amount),
        chain: testnet,
    });

    // await client.waitForTransactionReceipt({
    //     hash,
    // });
    return hash;
};

export const transfer: Action = {
    name: "SEND_CFX",
    description:
        "Transfer CFX to another address in Conflux Core Space. The address starts with `cfx:` or `cfxtest:`",
    similes: ["SEND_CONFLUX", "SEND_CFX_CORE_SPACE", "TRANSFER_CFX"],
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Send 1 CFX to cfx:aaejuaaaaaaaaaaaaaaaaaaaaaaaaaaaa2eaeg85p5",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "1 CFX sent to cfx:aaejuaaaaaaaaaaaaaaaaaaaaaaaaaaaa2eaeg85p5: 0x1234567890abcdef",
                    content: {
                        to: "cfx:aaejuaaaaaaaaaaaaaaaaaaaaaaaaaaaa2eaeg85p5",
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
            template: confluxTransferTemplate,
        });

        const content = await generateObject({
            runtime,
            context,
            modelClass: ModelClass.SMALL,
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
            const hash = await sendCFX(
                secretKey,
                rpcUrl,
                content.object.to,
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
