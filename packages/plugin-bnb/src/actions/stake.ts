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
import { formatEther, parseEther, erc20Abi } from "viem";

import {
    bnbWalletProvider,
    initWalletProvider,
    WalletProvider,
} from "../providers/wallet";
import { stakeTemplate } from "../templates";
import { ListaDaoAbi, type StakeParams, type StakeResponse } from "../types";

export { stakeTemplate };

// Exported for tests
export class StakeAction {
    private readonly LISTA_DAO =
        "0x1adB950d8bB3dA4bE104211D5AB038628e477fE6" as const;
    private readonly SLIS_BNB =
        "0xB0b84D294e0C75A6abe60171b70edEb2EFd14A1B" as const;

    constructor(private walletProvider: WalletProvider) {}

    async stake(params: StakeParams): Promise<StakeResponse> {
        elizaLogger.debug("Stake params:", params);
        this.validateStakeParams(params);
        elizaLogger.debug("Normalized stake params:", params);

        this.walletProvider.switchChain("bsc"); // only BSC is supported

        const actions = {
            deposit: async () => await this.doDeposit(params.amount!),
            withdraw: async () => await this.doWithdraw(params.amount),
            claim: async () => await this.doClaim(),
        };
        const resp = await actions[params.action]();
        return { response: resp };
    }

    validateStakeParams(params: StakeParams) {
        if (params.chain != "bsc") {
            throw new Error("Only BSC mainnet is supported");
        }

        if (params.action == "deposit" && !params.amount) {
            throw new Error("Amount is required for deposit");
        }

        if (params.action == "withdraw" && !params.amount) {
            throw new Error("Amount is required for withdraw");
        }
    }

    async doDeposit(amount: string): Promise<string> {
        const publicClient = this.walletProvider.getPublicClient("bsc");
        const walletClient = this.walletProvider.getWalletClient("bsc");

        const { request } = await publicClient.simulateContract({
            account: this.walletProvider.getAccount(),
            address: this.LISTA_DAO,
            abi: ListaDaoAbi,
            functionName: "deposit",
            value: parseEther(amount),
        });
        const txHash = await walletClient.writeContract(request);
        await publicClient.waitForTransactionReceipt({
            hash: txHash,
        });

        const slisBNBBalance = await publicClient.readContract({
            address: this.SLIS_BNB,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [walletClient.account!.address],
        });

        return `Successfully do deposit. ${formatEther(slisBNBBalance)} slisBNB held. \nTransaction Hash: ${txHash}`;
    }

    async doWithdraw(amount?: string): Promise<string> {
        const publicClient = this.walletProvider.getPublicClient("bsc");
        const walletClient = this.walletProvider.getWalletClient("bsc");

        // If amount is not provided, withdraw all slisBNB
        let amountToWithdraw: bigint;
        if (!amount) {
            amountToWithdraw = await publicClient.readContract({
                address: this.SLIS_BNB,
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [walletClient.account!.address],
            });
        } else {
            amountToWithdraw = parseEther(amount);
        }

        // check slisBNB allowance
        const allowance = await this.walletProvider.checkERC20Allowance(
            "bsc",
            this.SLIS_BNB,
            walletClient.account!.address,
            this.LISTA_DAO
        );
        if (allowance < amountToWithdraw) {
            elizaLogger.log(
                `Increasing slisBNB allowance for Lista DAO. ${amountToWithdraw - allowance} more needed`
            );
            const txHash = await this.walletProvider.approveERC20(
                "bsc",
                this.SLIS_BNB,
                this.LISTA_DAO,
                amountToWithdraw
            );
            await publicClient.waitForTransactionReceipt({
                hash: txHash,
            });
        }

        const { request } = await publicClient.simulateContract({
            account: this.walletProvider.getAccount(),
            address: this.LISTA_DAO,
            abi: ListaDaoAbi,
            functionName: "requestWithdraw",
            args: [amountToWithdraw],
        });
        const txHash = await walletClient.writeContract(request);
        await publicClient.waitForTransactionReceipt({
            hash: txHash,
        });

        const slisBNBBalance = await publicClient.readContract({
            address: this.SLIS_BNB,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [walletClient.account!.address],
        });

        return `Successfully do withdraw. ${formatEther(slisBNBBalance)} slisBNB left. \nTransaction Hash: ${txHash}`;
    }

    async doClaim(): Promise<string> {
        const publicClient = this.walletProvider.getPublicClient("bsc");
        const walletClient = this.walletProvider.getWalletClient("bsc");

        const address = walletClient.account!.address;
        const requests = await publicClient.readContract({
            address: this.LISTA_DAO,
            abi: ListaDaoAbi,
            functionName: "getUserWithdrawalRequests",
            args: [address],
        });

        let totalClaimed = 0n;
        for (let idx = 0; idx < requests.length; idx++) {
            const [isClaimable, amount] = await publicClient.readContract({
                address: this.LISTA_DAO,
                abi: ListaDaoAbi,
                functionName: "getUserRequestStatus",
                args: [address, BigInt(idx)],
            });

            if (isClaimable) {
                const { request } = await publicClient.simulateContract({
                    account: this.walletProvider.getAccount(),
                    address: this.LISTA_DAO,
                    abi: ListaDaoAbi,
                    functionName: "claimWithdraw",
                    args: [BigInt(idx)],
                });

                const txHash = await walletClient.writeContract(request);
                await publicClient.waitForTransactionReceipt({
                    hash: txHash,
                });

                totalClaimed += amount;
            } else {
                break;
            }
        }

        return `Successfully do claim. ${formatEther(totalClaimed)} BNB claimed.`;
    }
}

export const stakeAction = {
    name: "stake",
    description: "Stake related actions through Lista DAO",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: any,
        callback?: HandlerCallback
    ) => {
        elizaLogger.log("Starting stake action...");

        // Validate stake
        if (!(message.content.source === "direct")) {
            callback?.({
                text: "I can't do that for you.",
                content: { error: "Stake not allowed" },
            });
            return false;
        }

        // Initialize or update state
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }
        state.walletInfo = await bnbWalletProvider.get(runtime, message, state);

        // Compose stake context
        const stakeContext = composeContext({
            state,
            template: stakeTemplate,
        });
        const content = await generateObjectDeprecated({
            runtime,
            context: stakeContext,
            modelClass: ModelClass.LARGE,
        });

        const walletProvider = initWalletProvider(runtime);
        const action = new StakeAction(walletProvider);
        const paramOptions: StakeParams = {
            chain: content.chain,
            action: content.action,
            amount: content.amount,
        };
        try {
            const stakeResp = await action.stake(paramOptions);
            callback?.({
                text: stakeResp.response,
                content: { ...stakeResp },
            });

            return true;
        } catch (error) {
            elizaLogger.error("Error during stake:", error.message);
            callback?.({
                text: `Stake failed: ${error.message}`,
                content: { error: error.message },
            });
            return false;
        }
    },
    template: stakeTemplate,
    validate: async (runtime: IAgentRuntime) => {
        const privateKey = runtime.getSetting("BNB_PRIVATE_KEY");
        return typeof privateKey === "string" && privateKey.startsWith("0x");
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Stake 1 BNB on BSC",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you stake 1 BNB to Lista DAO on BSC",
                    action: "STAKE",
                    content: {
                        action: "deposit",
                        amount: "1",
                    },
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Deposit 1 BNB to Lista DAO",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you deposit 1 BNB to Lista DAO on BSC",
                    action: "STAKE",
                    content: {
                        action: "deposit",
                        amount: "1",
                    },
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Undelegate 1 slisBNB on BSC",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you undelegate 1 slisBNB from Lista DAO on BSC",
                    action: "STAKE",
                    content: {
                        action: "withdraw",
                        amount: "1",
                    },
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Withdraw 1 slisBNB from Lista DAO",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you withdraw 1 slisBNB from Lista DAO on BSC",
                    action: "STAKE",
                    content: {
                        action: "withdraw",
                        amount: "1",
                    },
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Claim unlocked BNB from Lista DAO",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you claim unlocked BNB from Lista DAO on BSC",
                    action: "STAKE",
                    content: {
                        action: "claim",
                    },
                },
            },
        ],
    ],
    similes: [
        "DELEGATE",
        "STAKE",
        "DEPOSIT",
        "UNDELEGATE",
        "UNSTAKE",
        "WITHDRAW",
        "CLAIM",
    ],
};
