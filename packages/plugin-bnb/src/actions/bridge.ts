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
import { parseEther, getContract, parseUnits, erc20Abi } from "viem";

import {
    bnbWalletProvider,
    initWalletProvider,
    WalletProvider,
} from "../providers/wallet";
import { bridgeTemplate } from "../templates";
import {
    L1StandardBridgeAbi,
    L2StandardBridgeAbi,
    type BridgeParams,
    type BridgeResponse,
} from "../types";

export { bridgeTemplate };

// Exported for tests
export class BridgeAction {
    private readonly L1_BRIDGE_ADDRESS =
        "0xF05F0e4362859c3331Cb9395CBC201E3Fa6757Ea" as const;
    private readonly L2_BRIDGE_ADDRESS =
        "0x4000698e3De52120DE28181BaACda82B21568416" as const;
    private readonly LEGACY_ERC20_ETH =
        "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000" as const;

    constructor(private walletProvider: WalletProvider) {}

    async bridge(params: BridgeParams): Promise<BridgeResponse> {
        elizaLogger.debug("Bridge params:", params);
        await this.validateAndNormalizeParams(params);
        elizaLogger.debug("Normalized bridge params:", params);

        const fromAddress = this.walletProvider.getAddress();

        this.walletProvider.switchChain(params.fromChain);
        const walletClient = this.walletProvider.getWalletClient(
            params.fromChain
        );
        const publicClient = this.walletProvider.getPublicClient(
            params.fromChain
        );

        const nativeToken =
            this.walletProvider.chains[params.fromChain].nativeCurrency.symbol;

        const resp: BridgeResponse = {
            fromChain: params.fromChain,
            toChain: params.toChain,
            txHash: "0x",
            recipient: params.toAddress ?? fromAddress,
            amount: params.amount,
            fromToken: params.fromToken ?? nativeToken,
            toToken: params.toToken ?? nativeToken,
        };

        const account = this.walletProvider.getAccount();
        const chain = this.walletProvider.getChainConfigs(params.fromChain);

        const selfBridge = !params.toAddress || params.toAddress == fromAddress;
        const nativeTokenBridge =
            !params.fromToken || params.fromToken == nativeToken;

        let amount: bigint;
        if (nativeTokenBridge) {
            amount = parseEther(params.amount);
        } else {
            const decimals = await publicClient.readContract({
                address: params.fromToken!,
                abi: erc20Abi,
                functionName: "decimals",
            });
            amount = parseUnits(params.amount, decimals);
        }

        if (params.fromChain == "bsc" && params.toChain == "opBNB") {
            // from L1 to L2
            const l1BridgeContract = getContract({
                address: this.L1_BRIDGE_ADDRESS,
                abi: L1StandardBridgeAbi,
                client: {
                    public: publicClient,
                    wallet: walletClient,
                },
            });

            // check ERC20 allowance
            if (!nativeTokenBridge) {
                const allowance = await this.walletProvider.checkERC20Allowance(
                    params.fromChain,
                    params.fromToken!,
                    fromAddress,
                    this.L1_BRIDGE_ADDRESS
                );
                if (allowance < amount) {
                    elizaLogger.log(
                        `Increasing ERC20 allowance for L1 bridge. ${amount - allowance} more needed`
                    );
                    const txHash = await this.walletProvider.approveERC20(
                        params.fromChain,
                        params.fromToken!,
                        this.L1_BRIDGE_ADDRESS,
                        amount
                    );
                    await publicClient.waitForTransactionReceipt({
                        hash: txHash,
                    });
                }
            }

            if (selfBridge && nativeTokenBridge) {
                const args = [1, "0x"] as const;
                await l1BridgeContract.simulate.depositETH(args, {
                    value: amount,
                });
                resp.txHash = await l1BridgeContract.write.depositETH(args, {
                    account,
                    chain,
                    value: amount,
                });
            } else if (selfBridge && !nativeTokenBridge) {
                const args = [
                    params.fromToken!,
                    params.toToken!,
                    amount,
                    1,
                    "0x",
                ] as const;
                await l1BridgeContract.simulate.depositERC20(args, {
                    account,
                });
                resp.txHash = await l1BridgeContract.write.depositERC20(args, {
                    account,
                    chain,
                });
            } else if (!selfBridge && nativeTokenBridge) {
                const args = [params.toAddress!, 1, "0x"] as const;
                await l1BridgeContract.simulate.depositETHTo(args, {
                    value: amount,
                });
                resp.txHash = await l1BridgeContract.write.depositETHTo(args, {
                    account,
                    chain,
                    value: amount,
                });
            } else {
                const args = [
                    params.fromToken!,
                    params.toToken!,
                    params.toAddress!,
                    amount,
                    1,
                    "0x",
                ] as const;
                await l1BridgeContract.simulate.depositERC20To(args, {
                    account,
                });
                resp.txHash = await l1BridgeContract.write.depositERC20To(
                    args,
                    {
                        account,
                        chain,
                    }
                );
            }
        } else if (params.fromChain == "opBNB" && params.toChain == "bsc") {
            // from L2 to L1
            const l2BridgeContract = getContract({
                address: this.L2_BRIDGE_ADDRESS,
                abi: L2StandardBridgeAbi,
                client: {
                    public: publicClient,
                    wallet: walletClient,
                },
            });

            const delegationFee = await publicClient.readContract({
                address: this.L2_BRIDGE_ADDRESS,
                abi: L2StandardBridgeAbi,
                functionName: "delegationFee",
            });

            // check ERC20 allowance
            if (!nativeTokenBridge) {
                const allowance = await this.walletProvider.checkERC20Allowance(
                    params.fromChain,
                    params.fromToken!,
                    fromAddress,
                    this.L2_BRIDGE_ADDRESS
                );
                if (allowance < amount) {
                    elizaLogger.log(
                        `Increasing ERC20 allowance for L2 bridge. ${amount - allowance} more needed`
                    );
                    const txHash = await this.walletProvider.approveERC20(
                        params.fromChain,
                        params.fromToken!,
                        this.L2_BRIDGE_ADDRESS,
                        amount
                    );
                    await publicClient.waitForTransactionReceipt({
                        hash: txHash,
                    });
                }
            }

            if (selfBridge && nativeTokenBridge) {
                const args = [this.LEGACY_ERC20_ETH, amount, 1, "0x"] as const;
                const value = amount + delegationFee;
                await l2BridgeContract.simulate.withdraw(args, { value });
                resp.txHash = await l2BridgeContract.write.withdraw(args, {
                    account,
                    chain,
                    value,
                });
            } else if (selfBridge && !nativeTokenBridge) {
                const args = [params.fromToken!, amount, 1, "0x"] as const;
                const value = delegationFee;
                await l2BridgeContract.simulate.withdraw(args, {
                    account,
                    value,
                });
                resp.txHash = await l2BridgeContract.write.withdraw(args, {
                    account,
                    chain,
                    value,
                });
            } else if (!selfBridge && nativeTokenBridge) {
                const args = [
                    this.LEGACY_ERC20_ETH,
                    params.toAddress!,
                    amount,
                    1,
                    "0x",
                ] as const;
                const value = amount + delegationFee;
                await l2BridgeContract.simulate.withdrawTo(args, { value });
                resp.txHash = await l2BridgeContract.write.withdrawTo(args, {
                    account,
                    chain,
                    value,
                });
            } else {
                const args = [
                    params.fromToken!,
                    params.toAddress!,
                    amount,
                    1,
                    "0x",
                ] as const;
                const value = delegationFee;
                await l2BridgeContract.simulate.withdrawTo(args, {
                    account,
                    value,
                });
                resp.txHash = await l2BridgeContract.write.withdrawTo(args, {
                    account,
                    chain,
                    value,
                });
            }
        } else {
            throw new Error("Unsupported bridge direction");
        }

        if (!resp.txHash || resp.txHash == "0x") {
            throw new Error("Get transaction hash failed");
        }

        // wait for the transaction to be confirmed
        await publicClient.waitForTransactionReceipt({
            hash: resp.txHash,
        });

        return resp;
    }

    async validateAndNormalizeParams(params: BridgeParams) {
        if (!params.toAddress) {
            params.toAddress = this.walletProvider.getAddress();
        } else {
            params.toAddress = await this.walletProvider.formatAddress(
                params.toAddress
            );
        }

        if (params.fromChain == "bsc" && params.toChain == "opBNB") {
            if (params.fromToken && !params.toToken) {
                throw new Error(
                    "token address on opBNB is required when bridging ERC20 from BSC to opBNB"
                );
            }
        }
    }
}

// NOTE: The bridge action only supports bridge funds between BSC and opBNB for now. We may adding stargate support later.
export const bridgeAction = {
    name: "bridge",
    description: "Bridge tokens between BSC and opBNB",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: any,
        callback?: HandlerCallback
    ) => {
        elizaLogger.log("Starting bridge action...");

        // Initialize or update state
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }
        state.walletInfo = await bnbWalletProvider.get(runtime, message, state);

        // Compose bridge context
        const bridgeContext = composeContext({
            state,
            template: bridgeTemplate,
        });
        const content = await generateObjectDeprecated({
            runtime,
            context: bridgeContext,
            modelClass: ModelClass.LARGE,
        });

        const walletProvider = initWalletProvider(runtime);
        const action = new BridgeAction(walletProvider);
        const paramOptions: BridgeParams = {
            fromChain: content.fromChain,
            toChain: content.toChain,
            fromToken: content.fromToken,
            toToken: content.toToken,
            amount: content.amount,
            toAddress: content.toAddress,
        };
        try {
            const bridgeResp = await action.bridge(paramOptions);
            callback?.({
                text: `Successfully bridged ${bridgeResp.amount} ${bridgeResp.fromToken} from ${bridgeResp.fromChain} to ${bridgeResp.toChain}\nTransaction Hash: ${bridgeResp.txHash}`,
                content: { ...bridgeResp },
            });
            return true;
        } catch (error) {
            elizaLogger.error("Error during token bridge:", error.message);
            callback?.({
                text: `Bridge failed: ${error.message}`,
                content: { error: error.message },
            });
            return false;
        }
    },
    template: bridgeTemplate,
    validate: async (runtime: IAgentRuntime) => {
        const privateKey = runtime.getSetting("BNB_PRIVATE_KEY");
        return typeof privateKey === "string" && privateKey.startsWith("0x");
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Deposit 1 BNB from BSC to opBNB",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you bridge 1 BNB from BSC to opBNB",
                    action: "BRIDGE",
                    content: {
                        fromChain: "bsc",
                        toChain: "opBNB",
                        fromToken: undefined,
                        toToken: undefined,
                        amount: 1,
                    },
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Transfer 1 BNB from BSC to address 0x1234 on opBNB",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you bridge 1 BNB from BSC to address 0x1234 on opBNB",
                    action: "BRIDGE",
                    content: {
                        fromChain: "bsc",
                        toChain: "opBNB",
                        fromToken: undefined,
                        toToken: undefined,
                        amount: 1,
                        toAddress: "0x1234",
                    },
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Deposit 1 0x123 token from BSC to address 0x456 on opBNB. The corresponding token address on opBNB is 0x789",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you bridge 1 0x123 token from BSC to address 0x456 on opBNB",
                    action: "BRIDGE",
                    content: {
                        fromChain: "bsc",
                        toChain: "opBNB",
                        fromToken: "0x123",
                        toToken: "0x789",
                        amount: 1,
                        toAddress: "0x456",
                    },
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Withdraw 1 BNB from opBNB to BSC",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you bridge 1 BNB from opBNB to BSC",
                    action: "BRIDGE",
                    content: {
                        fromChain: "opBNB",
                        toChain: "bsc",
                        fromToken: undefined,
                        toToken: undefined,
                        amount: 1,
                    },
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Withdraw 1 0x1234 token from opBNB to address 0x5678 on BSC",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you bridge 1 0x1234 token from opBNB to address 0x5678 on BSC",
                    action: "BRIDGE",
                    content: {
                        fromChain: "opBNB",
                        toChain: "bsc",
                        fromToken: "0x1234",
                        toToken: undefined,
                        amount: 1,
                        toAddress: "0x5678",
                    },
                },
            },
        ],
    ],
    similes: ["BRIDGE", "TOKEN_BRIDGE", "DEPOSIT", "WITHDRAW"],
};
