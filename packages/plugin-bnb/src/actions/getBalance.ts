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
import { getToken } from "@lifi/sdk";

import {
    bnbWalletProvider,
    initWalletProvider,
    WalletProvider,
} from "../providers/wallet";
import { getBalanceTemplate } from "../templates";
import type {
    GetBalanceParams,
    GetBalanceResponse,
    SupportedChain,
} from "../types";
import { Address, erc20Abi, formatEther, formatUnits } from "viem";

export { getBalanceTemplate };

export class GetBalanceAction {
    constructor(private walletProvider: WalletProvider) {}

    async getBalance(params: GetBalanceParams): Promise<GetBalanceResponse> {
        elizaLogger.debug("Get balance params:", params);
        await this.validateAndNormalizeParams(params);
        elizaLogger.debug("Normalized get balance params:", params);

        let { chain, address, token } = params;

        this.walletProvider.switchChain(chain);
        const nativeSymbol =
            this.walletProvider.getChainConfigs(chain).nativeCurrency.symbol;
        const chainId = this.walletProvider.getChainConfigs(chain).id;

        let queryNativeToken = false;
        if (
            !token ||
            token == "" ||
            token.toLowerCase() == "bnb" ||
            token.toLowerCase() == "tbnb"
        ) {
            queryNativeToken = true;
        }

        const resp: GetBalanceResponse = {
            chain,
            address: address!,
        };

        // If ERC20 token is requested
        if (!queryNativeToken) {
            let amount: string;
            if (token.startsWith("0x")) {
                amount = await this.getERC20TokenBalance(
                    chain,
                    address!,
                    token as `0x${string}`
                );
            } else {
                if (chainId != 56) {
                    throw new Error(
                        "Only BSC mainnet is supported for querying balance by token symbol"
                    );
                }

                this.walletProvider.configureLiFiSdk(chain);
                const tokenInfo = await getToken(chainId, token);
                amount = await this.getERC20TokenBalance(
                    chain,
                    address!,
                    tokenInfo.address as `0x${string}`
                );
            }

            resp.balance = { token, amount };
        } else {
            // If native token is requested
            const nativeBalanceWei = await this.walletProvider
                .getPublicClient(chain)
                .getBalance({ address: address! });
            resp.balance = {
                token: nativeSymbol,
                amount: formatEther(nativeBalanceWei),
            };
        }

        return resp;
    }

    async getERC20TokenBalance(
        chain: SupportedChain,
        address: Address,
        tokenAddress: Address
    ): Promise<string> {
        const publicClient = this.walletProvider.getPublicClient(chain);

        const balance = await publicClient.readContract({
            address: tokenAddress,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address],
        });

        const decimals = await publicClient.readContract({
            address: tokenAddress,
            abi: erc20Abi,
            functionName: "decimals",
        });

        return formatUnits(balance, decimals);
    }

    async validateAndNormalizeParams(params: GetBalanceParams): Promise<void> {
        if (!params.address) {
            params.address = this.walletProvider.getAddress();
        } else {
            params.address = await this.walletProvider.formatAddress(
                params.address
            );
        }
    }
}

export const getBalanceAction = {
    name: "getBalance",
    description: "Get balance of a token or all tokens for the given address",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: any,
        callback?: HandlerCallback
    ) => {
        elizaLogger.log("Starting getBalance action...");

        // Initialize or update state
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }
        state.walletInfo = await bnbWalletProvider.get(runtime, message, state);

        // Compose swap context
        const getBalanceContext = composeContext({
            state,
            template: getBalanceTemplate,
        });
        const content = await generateObjectDeprecated({
            runtime,
            context: getBalanceContext,
            modelClass: ModelClass.LARGE,
        });

        const walletProvider = initWalletProvider(runtime);
        const action = new GetBalanceAction(walletProvider);
        const getBalanceOptions: GetBalanceParams = {
            chain: content.chain,
            address: content.address,
            token: content.token,
        };
        try {
            const getBalanceResp = await action.getBalance(getBalanceOptions);
            if (callback) {
                let text = `No balance found for ${getBalanceOptions.address} on ${getBalanceOptions.chain}`;
                if (getBalanceResp.balance) {
                    text = `Balance of ${getBalanceResp.address} on ${getBalanceResp.chain}:\n${
                        getBalanceResp.balance.token
                    }: ${getBalanceResp.balance.amount}`;
                }
                callback({
                    text,
                    content: { ...getBalanceResp },
                });
            }
            return true;
        } catch (error) {
            elizaLogger.error("Error during get balance:", error.message);
            callback?.({
                text: `Get balance failed: ${error.message}`,
                content: { error: error.message },
            });
            return false;
        }
    },
    template: getBalanceTemplate,
    validate: async (_runtime: IAgentRuntime) => {
        return true;
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Check my balance of USDC",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you check your balance of USDC",
                    action: "GET_BALANCE",
                    content: {
                        chain: "bsc",
                        address: "{{walletAddress}}",
                        token: "USDC",
                    },
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Check my balance of token 0x1234",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you check your balance of token 0x1234",
                    action: "GET_BALANCE",
                    content: {
                        chain: "bsc",
                        address: "{{walletAddress}}",
                        token: "0x1234",
                    },
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Get USDC balance of 0x1234",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you check USDC balance of 0x1234",
                    action: "GET_BALANCE",
                    content: {
                        chain: "bsc",
                        address: "0x1234",
                        token: "USDC",
                    },
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Check my wallet balance on BSC",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you check your wallet balance on BSC",
                    action: "GET_BALANCE",
                    content: {
                        chain: "bsc",
                        address: "{{walletAddress}}",
                        token: undefined,
                    },
                },
            },
        ],
    ],
    similes: ["GET_BALANCE", "CHECK_BALANCE"],
};
