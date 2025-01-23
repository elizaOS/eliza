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
import { isAddress } from "viem";

import { CronosWalletProvider, initCronosWalletProvider } from "../providers/wallet";
import type { BalanceParams } from "../types";
import { balanceTemplate } from "../templates";

const BalanceSchema = z.object({
    chain: z.enum(["cronos", "cronosTestnet"], {
        required_error: "Chain must be either cronos or cronosTestnet",
        invalid_type_error: "Chain must be either cronos or cronosTestnet",
    }),
    address: z.string().refine((val) => isAddress(val), {
        message: "Invalid Ethereum address format",
    }),
});

export class BalanceAction {
    constructor(private walletProvider: CronosWalletProvider) {}

    async getBalance(params: BalanceParams): Promise<string> {
        this.walletProvider.switchChain(params.chain);
        const balance = await this.walletProvider.getAddressBalance(params.address);

        if (!balance) {
            throw new Error("Failed to fetch balance");
        }

        return balance;
    }
}

const buildBalanceDetails = async (
    state: State,
    runtime: IAgentRuntime,
    wp: CronosWalletProvider
): Promise<BalanceParams> => {
    state.supportedChains = '"cronos"|"cronosTestnet"';

    const context = composeContext({
        state,
        template: balanceTemplate,
    });

    const balanceDetails = (await generateObject({
        runtime,
        context,
        modelClass: ModelClass.SMALL,
        schema: BalanceSchema,
    })).object as BalanceParams;

    return balanceDetails;
};

export const balanceAction: Action = {
    name: "CHECK_BALANCE",
    description: "Check CRO token balance on Cronos chain",
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
        const action = new BalanceAction(walletProvider);

        const paramOptions = await buildBalanceDetails(
            state,
            runtime,
            walletProvider
        );

        try {
            const balance = await action.getBalance(paramOptions);
            if (callback) {
                callback({
                    text: `Balance for ${paramOptions.address} on ${paramOptions.chain} is ${balance} CRO`,
                    content: {
                        success: true,
                        balance,
                        chain: paramOptions.chain,
                        address: paramOptions.address,
                    },
                });
            }
            return true;
        } catch (error) {
            if (callback) {
                callback({
                    text: `Error checking balance: ${error.message}`,
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
                    text: "I'll check your balance on Cronos mainnet",
                    action: "CHECK_BALANCE",
                },
            },
            {
                user: "user",
                content: {
                    text: "What's my balance?",
                    action: "CHECK_BALANCE",
                },
            },
        ],
    ],
    similes: ["balance", "CHECK_BALANCE", "GET_BALANCE", "SHOW_BALANCE"],
};