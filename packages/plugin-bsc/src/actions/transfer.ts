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
import { formatEther, parseEther, type Hex } from "viem";

import { initWalletProvider, WalletProvider } from "../providers/wallet";
import { transferTemplate } from "../templates";
import { ERC20Abi, type Transaction, type TransferParams } from "../types";

export { transferTemplate };

// Exported for tests
export class TransferAction {
    private readonly BSC_DEFAULT_GAS_PRICE = 3000000000n as const; // 3 Gwei
    constructor(private walletProvider: WalletProvider) {}

    async transfer(params: TransferParams): Promise<Transaction> {
        const fromAddress = this.walletProvider.getAddress();

        if (!params.data) {
            params.data = "0x";
        }

        this.walletProvider.switchChain(params.chain);
        const walletClient = this.walletProvider.getWalletClient(params.chain);

        try {
            const nativeToken =
                this.walletProvider.chains[params.chain].nativeCurrency.symbol;

            let value: bigint;
            let hash: Hex;
            if (!params.token || params.token == nativeToken) {
                if (!params.amount) {
                    const balance = await this.walletProvider.getWalletBalance(
                        params.chain
                    );
                    if (!balance) {
                        throw new Error("Failed to get wallet balance");
                    }
                    value =
                        parseEther(balance) -
                        this.BSC_DEFAULT_GAS_PRICE * 21000n;

                    hash = await walletClient.sendTransaction({
                        account: walletClient.account!,
                        to: params.toAddress,
                        value: value,
                        gas: 21000n,
                        gasPrice: this.BSC_DEFAULT_GAS_PRICE,
                        data: params.data as Hex,
                        chain: this.walletProvider.getChainConfigs(
                            params.chain
                        ),
                    });
                } else {
                    value = parseEther(params.amount);
                    hash = await walletClient.sendTransaction({
                        account: walletClient.account!,
                        to: params.toAddress,
                        value: value,
                        data: params.data as Hex,
                        chain: this.walletProvider.getChainConfigs(
                            params.chain
                        ),
                    });
                }
            } else {
                let tokenAddress = params.token;
                if (!params.token.startsWith("0x")) {
                    const resolvedAddress =
                        await this.walletProvider.getTokenAddress(
                            params.chain,
                            params.token
                        );
                    if (!resolvedAddress) {
                        throw new Error(
                            `Unknown token symbol ${params.token}. Please provide a valid token address.`
                        );
                    }
                    tokenAddress = resolvedAddress;
                }

                const publicClient = this.walletProvider.getPublicClient(
                    params.chain
                );
                if (!params.amount) {
                    value = await publicClient.readContract({
                        address: tokenAddress as `0x${string}`,
                        abi: ERC20Abi,
                        functionName: "balanceOf",
                        args: [fromAddress],
                    });
                } else {
                    value = parseEther(params.amount);
                }

                const { request } = await publicClient.simulateContract({
                    account: walletClient.account,
                    address: tokenAddress as `0x${string}`,
                    abi: ERC20Abi,
                    functionName: "transfer",
                    args: [params.toAddress as `0x${string}`, value],
                });

                hash = await walletClient.writeContract(request);
            }

            return {
                hash,
                from: fromAddress,
                to: params.toAddress,
                value: value,
                data: params.data as Hex,
            };
        } catch (error) {
            throw new Error(`Transfer failed: ${error.message}`);
        }
    }
}

export const transferAction = {
    name: "transfer",
    description: "Transfer tokens between addresses on the same chain",
    handler: async (
        runtime: IAgentRuntime,
        _message: Memory,
        state: State,
        _options: any,
        callback?: HandlerCallback
    ) => {
        elizaLogger.log("Transfer action handler called");
        const walletProvider = initWalletProvider(runtime);
        const action = new TransferAction(walletProvider);

        // Compose transfer context
        const transferContext = composeContext({
            state,
            template: transferTemplate,
        });
        const content = await generateObjectDeprecated({
            runtime,
            context: transferContext,
            modelClass: ModelClass.LARGE,
        });

        const paramOptions: TransferParams = {
            chain: content.chain,
            token: content.token,
            amount: content.amount,
            toAddress: content.toAddress,
            data: content.data,
        };

        try {
            const transferResp = await action.transfer(paramOptions);
            const tokenText = paramOptions.token
                ? `${paramOptions.token} tokens`
                : "BNB";
            if (callback) {
                callback({
                    text: `Successfully transferred ${transferResp.value} ${tokenText} to ${paramOptions.toAddress}\nTransaction Hash: ${transferResp.hash}`,
                    content: {
                        success: true,
                        hash: transferResp.hash,
                        amount: formatEther(transferResp.value),
                        recipient: transferResp.to,
                        chain: content.fromChain,
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
    template: transferTemplate,
    validate: async (runtime: IAgentRuntime) => {
        const privateKey = runtime.getSetting("BSC_PRIVATE_KEY");
        return typeof privateKey === "string" && privateKey.startsWith("0x");
    },
    examples: [
        [
            {
                user: "assistant",
                content: {
                    text: "I'll help you transfer 1 BNB to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
                    action: "SEND_TOKENS",
                },
            },
            {
                user: "user",
                content: {
                    text: "Transfer 1 BNB to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
                    action: "SEND_TOKENS",
                },
            },
        ],
    ],
    similes: ["SEND_TOKENS", "TOKEN_TRANSFER", "MOVE_TOKENS"],
};
