import { ByteArray, formatEther, parseEther, type Hex, isAddress } from "viem";
import {
    Action,
    composeContext,
    generateObject,
    HandlerCallback,
    ModelClass,
    type IAgentRuntime,
    type Memory,
    type State,
} from "@elizaos/core";
import { z } from "zod";

import { CronosWalletProvider, initCronosWalletProvider } from "../providers/wallet";
import type { Transaction, TransferParams } from "../types";
import { transferTemplate } from "../templates";
import { cronos, cronosTestnet } from "../constants/chains";

const TransferSchema = z.object({
    fromChain: z.enum(["cronos", "cronosTestnet"]),
    toAddress: z.string().refine((val) => isAddress(val), {
        message: "Invalid Ethereum address",
    }),
    amount: z.string().refine((val) => {
        try {
            parseEther(val);
            return true;
        } catch {
            return false;
        }
    }, {
        message: "Invalid amount format",
    }),
    data: z.string().optional(),
});

export class TransferAction {
    constructor(private walletProvider: CronosWalletProvider) {}

    async transfer(params: TransferParams): Promise<Transaction> {
        if (!params.data) {
            params.data = "0x";
        }

        this.walletProvider.switchChain(params.fromChain);
        const walletClient = this.walletProvider.getWalletClient(params.fromChain);
        const chainConfig = params.fromChain === "cronos" ? cronos : cronosTestnet;

        try {
            const hash = await walletClient.sendTransaction({
                account: walletClient.account,
                to: params.toAddress as Hex,
                value: parseEther(params.amount),
                data: params.data as Hex,
                chain: chainConfig,
                gasPrice: undefined,
                maxFeePerGas: undefined,
                maxPriorityFeePerGas: undefined,
                maxFeePerBlobGas: undefined,
                blobs: undefined,
                kzg: undefined,
            });

            return {
                hash,
                from: walletClient.account.address,
                to: params.toAddress,
                value: parseEther(params.amount),
                data: params.data as Hex,
                chainId: chainConfig.id,
            };
        } catch (error) {
            throw new Error(`Transfer failed: ${error.message}`);
        }
    }
}

const buildTransferDetails = async (
    state: State,
    runtime: IAgentRuntime,
    wp: CronosWalletProvider
): Promise<TransferParams> => {
    state.supportedChains = '"cronos"|"cronosTestnet"';

    const context = composeContext({
        state,
        template: transferTemplate,
    });

    const transferDetails = (await generateObject({
        runtime,
        context,
        modelClass: ModelClass.SMALL,
        schema: TransferSchema,
    })).object as TransferParams;

    return transferDetails;
};

export const transferAction: Action = {
    name: "SEND_TOKENS",
    description: "Transfer CRO tokens on Cronos chain",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State | undefined,
        _options: any,
        callback?: HandlerCallback
    ) => {
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        const walletProvider = await initCronosWalletProvider(runtime);
        const action = new TransferAction(walletProvider);

        const paramOptions = await buildTransferDetails(
            state,
            runtime,
            walletProvider
        );

        try {
            const transferResp = await action.transfer(paramOptions);
            if (callback) {
                callback({
                    text: `Successfully transferred ${paramOptions.amount} CRO to ${paramOptions.toAddress}\nTransaction Hash: ${transferResp.hash}`,
                    content: {
                        success: true,
                        hash: transferResp.hash,
                        amount: formatEther(transferResp.value),
                        recipient: transferResp.to,
                        chain: paramOptions.fromChain,
                    },
                });
            }
            return true;
        } catch (error) {
            if (callback) {
                callback({
                    text: `Error transferring tokens: ${error.message}`,
                    content: { error: error.message },
                });
            }
            return false;
        }
    },
    validate: async (runtime: IAgentRuntime) => {
        const privateKey = runtime.getSetting("CRONOS_PRIVATE_KEY");
        return typeof privateKey === "string" && privateKey.startsWith("0x");
    },
    examples: [
        [
            {
                user: "assistant",
                content: {
                    text: "I'll help you transfer 1 CRO to 0x000000000000000000000000000000000000800A on Cronos Testnet",
                    action: "SEND_TOKENS",
                },
            },
            {
                user: "user",
                content: {
                    text: "Transfer 1 CRO to 0x000000000000000000000000000000000000800A on Cronos Testnet",
                    action: "SEND_TOKENS",
                },
            },
        ],
    ],
    similes: ["transfer", "SEND_TOKENS", "TOKEN_TRANSFER", "MOVE_TOKENS"],
};