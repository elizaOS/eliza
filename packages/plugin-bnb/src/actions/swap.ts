import {
    composeContext,
    elizaLogger,
    generateObjectDeprecated,
    HandlerCallback,
    ModelClass,
    type IAgentRuntime,
    type Memory,
    type State,
} from "@elizaos/core";
import { executeRoute, getRoutes } from "@lifi/sdk";
import { parseEther } from "viem";

import {
    bnbWalletProvider,
    initWalletProvider,
    WalletProvider,
} from "../providers/wallet";
import { swapTemplate } from "../templates";
import type { SwapParams, SwapResponse } from "../types";

export { swapTemplate };

export class SwapAction {
    constructor(private walletProvider: WalletProvider) {}

    async swap(params: SwapParams): Promise<SwapResponse> {
        elizaLogger.debug("Swap params:", params);
        this.validateAndNormalizeParams(params);
        elizaLogger.debug("Normalized swap params:", params);

        const fromAddress = this.walletProvider.getAddress();
        const chainId = this.walletProvider.getChainConfigs(params.chain).id;

        this.walletProvider.configureLiFiSdk(params.chain);
        try {
            const resp: SwapResponse = {
                chain: params.chain,
                txHash: "0x",
                fromToken: params.fromToken,
                toToken: params.toToken,
                amount: params.amount,
            };

            const routes = await getRoutes({
                fromChainId: chainId,
                toChainId: chainId,
                fromTokenAddress: params.fromToken,
                toTokenAddress: params.toToken,
                fromAmount: parseEther(params.amount).toString(),
                fromAddress: fromAddress,
                options: {
                    slippage: params.slippage,
                    order: "RECOMMENDED",
                },
            });

            if (!routes.routes.length) throw new Error("No routes found");

            const execution = await executeRoute(routes.routes[0]);
            const process =
                execution.steps[0]?.execution?.process[
                    execution.steps[0]?.execution?.process.length - 1
                ];

            if (!process?.status || process.status === "FAILED") {
                throw new Error("Transaction failed");
            }

            resp.txHash = process.txHash as `0x${string}`;

            return resp;
        } catch (error) {
            throw error;
        }
    }

    validateAndNormalizeParams(params: SwapParams): void {
        if (params.chain != "bsc") {
            throw new Error("Only BSC mainnet is supported");
        }
    }
}

export const swapAction = {
    name: "swap",
    description: "Swap tokens on the same chain",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: any,
        callback?: HandlerCallback
    ) => {
        elizaLogger.log("Starting swap action...");

        // Initialize or update state
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }
        state.walletInfo = await bnbWalletProvider.get(runtime, message, state);

        // Compose swap context
        const swapContext = composeContext({
            state,
            template: swapTemplate,
        });
        const content = await generateObjectDeprecated({
            runtime,
            context: swapContext,
            modelClass: ModelClass.LARGE,
        });

        const walletProvider = initWalletProvider(runtime);
        const action = new SwapAction(walletProvider);
        const swapOptions: SwapParams = {
            chain: content.chain,
            fromToken: content.inputToken,
            toToken: content.outputToken,
            amount: content.amount,
            slippage: content.slippage,
        };
        try {
            const swapResp = await action.swap(swapOptions);
            callback?.({
                text: `Successfully swap ${swapResp.amount} ${swapResp.fromToken} tokens to ${swapResp.toToken}\nTransaction Hash: ${swapResp.txHash}`,
                content: { ...swapResp },
            });
            return true;
        } catch (error) {
            elizaLogger.error("Error during swap:", error.message);
            callback?.({
                text: `Swap failed: ${error.message}`,
                content: { error: error.message },
            });
            return false;
        }
    },
    template: swapTemplate,
    validate: async (runtime: IAgentRuntime) => {
        const privateKey = runtime.getSetting("BNB_PRIVATE_KEY");
        return typeof privateKey === "string" && privateKey.startsWith("0x");
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Swap 1 BNB for USDC on BSC",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you swap 1 BNB for USDC on BSC",
                    action: "SWAP",
                    content: {
                        chain: "bsc",
                        inputToken: "BNB",
                        outputToken: "USDC",
                        amount: "1",
                        slippage: undefined,
                    },
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Buy some token of 0x1234 using 1 USDC on BSC. The slippage should be no more than 5%",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you swap 1 USDC for token 0x1234 on BSC",
                    action: "SWAP",
                    content: {
                        chain: "bsc",
                        inputToken: "USDC",
                        outputToken: "0x1234",
                        amount: "1",
                        slippage: 0.05,
                    },
                },
            },
        ],
    ],
    similes: ["SWAP", "TOKEN_SWAP", "EXCHANGE_TOKENS", "TRADE_TOKENS"],
};
