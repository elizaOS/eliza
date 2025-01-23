import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import {
    composeContext,
    generateObjectDeprecated,
    ModelClass,
    elizaLogger,
} from "@elizaos/core";
import {
    createConfig,
    executeRoute,
    type ExtendedChain,
    getRoutes,
    type Route,
} from "@lifi/sdk";

import { initWalletProvider, type WalletProvider } from "../providers/wallet";
import { swapTemplate } from "../templates";
import type { SwapParams, SwapQuote, Transaction } from "../types";
import {
    type Address,
    type ByteArray,
    encodeFunctionData,
    type Hex,
    parseAbi,
    parseUnits,
} from "viem";
import type { BebopRoute } from "../types/index";

export { swapTemplate };

export class SwapAction {
    private lifiConfig;
    private bebopChainsMap;

    constructor(private walletProvider: WalletProvider) {
        this.walletProvider = walletProvider;
        const lifiChains: ExtendedChain[] = [];
        for (const config of Object.values(this.walletProvider.chains)) {
            try {
                lifiChains.push({
                    id: config.id,
                    name: config.name,
                    key: config.name.toLowerCase(),
                    chainType: "EVM" as const,
                    nativeToken: {
                        ...config.nativeCurrency,
                        chainId: config.id,
                        address: "0x0000000000000000000000000000000000000000",
                        coinKey: config.nativeCurrency.symbol,
                        priceUSD: "0",
                        logoURI: "",
                        symbol: config.nativeCurrency.symbol,
                        decimals: config.nativeCurrency.decimals,
                        name: config.nativeCurrency.name,
                    },
                    rpcUrls: {
                        public: { http: [config.rpcUrls.default.http[0]] },
                    },
                    blockExplorerUrls: [config.blockExplorers.default.url],
                    metamask: {
                        chainId: `0x${config.id.toString(16)}`,
                        chainName: config.name,
                        nativeCurrency: config.nativeCurrency,
                        rpcUrls: [config.rpcUrls.default.http[0]],
                        blockExplorerUrls: [config.blockExplorers.default.url],
                    },
                    coin: config.nativeCurrency.symbol,
                    mainnet: true,
                    diamondAddress:
                        "0x0000000000000000000000000000000000000000",
                } as ExtendedChain);
            } catch {
                // Skip chains with missing config in viem
            }
        }
        this.lifiConfig = createConfig({
            integrator: "eliza",
            chains: lifiChains,
        });
        this.bebopChainsMap = {
            mainnet: "ethereum",
        };
    }

    async swap(params: SwapParams): Promise<Transaction> {
        const walletClient = this.walletProvider.getWalletClient(params.chain);
        const [fromAddress] = await walletClient.getAddresses();

        // Getting quotes from different aggregators and sorting them by minAmount (amount after slippage)
        const sortedQuotes: SwapQuote[] = await this.getSortedQuotes(
            fromAddress,
            params
        );

        // Trying to execute the best quote by amount, fallback to the next one if it fails
        for (const quote of sortedQuotes) {
            let res;
            switch (quote.aggregator) {
                case "lifi":
                    res = await this.executeLifiQuote(quote);
                    break;
                case "bebop":
                    res = await this.executeBebopQuote(quote, params);
                    break;
                default:
                    throw new Error("No aggregator found");
            }
            if (res !== undefined) return res;
        }
        throw new Error("Execution failed");
    }

    private async getSortedQuotes(
        fromAddress: Address,
        params: SwapParams
    ): Promise<SwapQuote[]> {
        const decimalsAbi = parseAbi([
            "function decimals() view returns (uint8)",
        ]);
        const decimals = await this.walletProvider
            .getPublicClient(params.chain)
            .readContract({
                address: params.fromToken,
                abi: decimalsAbi,
                functionName: "decimals",
            });
        const quotes: SwapQuote[] | undefined = await Promise.all([
            this.getLifiQuote(fromAddress, params, decimals),
            this.getBebopQuote(fromAddress, params, decimals),
        ]);
        const sortedQuotes: SwapQuote[] = quotes.filter(
            (quote) => quote !== undefined
        ) as SwapQuote[];
        sortedQuotes.sort((a, b) =>
            BigInt(a.minOutputAmount) > BigInt(b.minOutputAmount) ? -1 : 1
        );
        if (sortedQuotes.length === 0) throw new Error("No routes found");
        return sortedQuotes;
    }

    private async getLifiQuote(
        fromAddress: Address,
        params: SwapParams,
        fromTokenDecimals: number
    ): Promise<SwapQuote | undefined> {
        try {
            const routes = await getRoutes({
                fromChainId: this.walletProvider.getChainConfigs(params.chain)
                    .id,
                toChainId: this.walletProvider.getChainConfigs(params.chain).id,
                fromTokenAddress: params.fromToken,
                toTokenAddress: params.toToken,
                fromAmount: parseUnits(
                    params.amount,
                    fromTokenDecimals
                ).toString(),
                fromAddress: fromAddress,
                options: {
                    slippage: params.slippage / 100 || 0.005,
                    order: "RECOMMENDED",
                },
            });
            if (!routes.routes.length) throw new Error("No routes found");
            return {
                aggregator: "lifi",
                minOutputAmount: routes.routes[0].steps[0].estimate.toAmountMin,
                swapData: routes.routes[0],
            };
        } catch (error) {
            elizaLogger.error("Error in getLifiQuote:", error.message);
            return undefined;
        }
    }

    private async getBebopQuote(
        fromAddress: Address,
        params: SwapParams,
        fromTokenDecimals: number
    ): Promise<SwapQuote | undefined> {
        try {
            const url = `https://api.bebop.xyz/router/${this.bebopChainsMap[params.chain] ?? params.chain}/v1/quote`;
            const reqParams = new URLSearchParams({
                sell_tokens: params.fromToken,
                buy_tokens: params.toToken,
                sell_amounts: parseUnits(
                    params.amount,
                    fromTokenDecimals
                ).toString(),
                taker_address: fromAddress,
                approval_type: "Standard",
                skip_validation: "true",
                gasless: "false",
                source: "eliza",
            });
            const response = await fetch(`${url}?${reqParams.toString()}`, {
                method: "GET",
                headers: { accept: "application/json" },
            });
            if (!response.ok) {
                throw Error(response.statusText);
            }
            const data = await response.json();
            const route: BebopRoute = {
                data: data.routes[0].quote.tx.data,
                sellAmount: parseUnits(
                    params.amount,
                    fromTokenDecimals
                ).toString(),
                approvalTarget: data.routes[0].quote
                    .approvalTarget as `0x${string}`,
                from: data.routes[0].quote.tx.from as `0x${string}`,
                value: data.routes[0].quote.tx.value.toString(),
                to: data.routes[0].quote.tx.to as `0x${string}`,
                gas: data.routes[0].quote.tx.gas.toString(),
                gasPrice: data.routes[0].quote.tx.gasPrice.toString(),
            };
            return {
                aggregator: "bebop",
                minOutputAmount:
                    data.routes[0].quote.buyTokens[
                        params.toToken
                    ].minimumAmount.toString(),
                swapData: route,
            };
        } catch (error) {
            elizaLogger.error("Error in getBebopQuote:", error.message);
            return undefined;
        }
    }

    private async executeLifiQuote(
        quote: SwapQuote
    ): Promise<Transaction | undefined> {
        try {
            const route: Route = quote.swapData as Route;
            const execution = await executeRoute(
                quote.swapData as Route,
                this.lifiConfig
            );
            const process = execution.steps[0]?.execution?.process[0];

            if (!process?.status || process.status === "FAILED") {
                throw new Error("Transaction failed");
            }
            return {
                hash: process.txHash as `0x${string}`,
                from: route.fromAddress! as `0x${string}`,
                to: route.steps[0].estimate.approvalAddress as `0x${string}`,
                value: 0n,
                data: process.data as `0x${string}`,
                chainId: route.fromChainId,
            };
        } catch (error) {
            elizaLogger.error(`Failed to execute lifi quote: ${error}`);
            return undefined;
        }
    }

    private async executeBebopQuote(
        quote: SwapQuote,
        params: SwapParams
    ): Promise<Transaction | undefined> {
        try {
            const bebopRoute: BebopRoute = quote.swapData as BebopRoute;
            const allowanceAbi = parseAbi([
                "function allowance(address,address) view returns (uint256)",
            ]);
            const allowance: bigint = await this.walletProvider
                .getPublicClient(params.chain)
                .readContract({
                    address: params.fromToken,
                    abi: allowanceAbi,
                    functionName: "allowance",
                    args: [bebopRoute.from, bebopRoute.approvalTarget],
                });
            if (allowance < BigInt(bebopRoute.sellAmount)) {
                const approvalData = encodeFunctionData({
                    abi: parseAbi(["function approve(address,uint256)"]),
                    functionName: "approve",
                    args: [
                        bebopRoute.approvalTarget,
                        BigInt(bebopRoute.sellAmount),
                    ],
                });
                await this.walletProvider
                    .getWalletClient(params.chain)
                    .sendTransaction({
                        account: this.walletProvider.getWalletClient(
                            params.chain
                        ).account,
                        to: params.fromToken,
                        value: 0n,
                        data: approvalData,
                        kzg: {
                            blobToKzgCommitment: (
                                _: ByteArray
                            ): ByteArray => {
                                throw new Error("Function not implemented.");
                            },
                            computeBlobKzgProof: (
                                _blob: ByteArray,
                                _commitment: ByteArray
                            ): ByteArray => {
                                throw new Error("Function not implemented.");
                            },
                        },
                        chain: undefined,
                    });
            }
            const hash = await this.walletProvider
                .getWalletClient(params.chain)
                .sendTransaction({
                    account: this.walletProvider.getWalletClient(params.chain)
                        .account,
                    to: bebopRoute.to,
                    value: BigInt(bebopRoute.value),
                    data: bebopRoute.data as Hex,
                    kzg: {
                        blobToKzgCommitment: (
                            _: ByteArray
                        ): ByteArray => {
                            throw new Error("Function not implemented.");
                        },
                        computeBlobKzgProof: (
                            _blob: ByteArray,
                            _commitment: ByteArray
                        ): ByteArray => {
                            throw new Error("Function not implemented.");
                        },
                    },
                    chain: undefined,
                });
            return {
                hash,
                from: this.walletProvider.getWalletClient(params.chain).account
                    .address,
                to: bebopRoute.to,
                value: BigInt(bebopRoute.value),
                data: bebopRoute.data as Hex,
            };
        } catch (error) {
            elizaLogger.error(`Failed to execute bebop quote: ${error}`);
            return undefined;
        }
    }
}

export const swapAction = {
    name: "swap",
    description: "Swap tokens on the same chain",
    handler: async (
        runtime: IAgentRuntime,
        _message: Memory,
        state: State,
        _options: any,
        callback?: any
    ) => {
        elizaLogger.log("Swap action handler called");
        const walletProvider = await initWalletProvider(runtime);
        const action = new SwapAction(walletProvider);

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

        const swapOptions: SwapParams = {
            chain: content.chain,
            fromToken: content.inputToken,
            toToken: content.outputToken,
            amount: content.amount,
            slippage: content.slippage,
        };

        try {
            const swapResp = await action.swap(swapOptions);
            if (callback) {
                callback({
                    text: `Successfully swap ${swapOptions.amount} ${swapOptions.fromToken} tokens to ${swapOptions.toToken}\nTransaction Hash: ${swapResp.hash}`,
                    content: {
                        success: true,
                        hash: swapResp.hash,
                        recipient: swapResp.to,
                        chain: content.chain,
                    },
                });
            }
            return true;
        } catch (error) {
            elizaLogger.error("Error in swap handler:", error.message);
            if (callback) {
                callback({ text: `Error: ${error.message}` });
            }
            return false;
        }
    },
    template: swapTemplate,
    validate: async (runtime: IAgentRuntime) => {
        const privateKey = runtime.getSetting("EVM_PRIVATE_KEY");
        return typeof privateKey === "string" && privateKey.startsWith("0x");
    },
    examples: [
        [
            {
                user: "user",
                content: {
                    text: "Swap 1 ETH for USDC on Base",
                    action: "TOKEN_SWAP",
                },
            },
        ],
    ],
    similes: ["TOKEN_SWAP", "EXCHANGE_TOKENS", "TRADE_TOKENS"],
}; // TODO: add more examples
