import {
    type Provider,
    type IAgentRuntime,
    type Memory,
    type State,
    elizaLogger,
} from "@elizaos/core";

import {
    type Address,
    createPublicClient,
    erc20Abi,
    type PublicClient,
    http,
    type WalletClient,
    type HttpTransport,
    type Account,
    type Chain,
    type SendTransactionParameters,
    type Hex,
} from "viem";
import { zksync } from "viem/chains";
import type { PrivateKeyAccount } from "viem/accounts";

import { useGetAccount, useGetWalletClient } from "../hooks";
import type { Item, SendTransactionParams, WalletPortfolio } from "../types";

import NodeCache from "node-cache";

// Add interface for portfolio API response
interface PortfolioItem {
    contract_name: string;
    contract_address: string;
    contract_ticker_symbol: string;
    contract_decimals: number;
}

// Add interface for token API response
interface TokenApiItem {
    name: string;
    address: string;
    symbol: string;
    decimals: number;
}

// Update interface to match the actual return type
interface HoldstationWalletResponse {
    message: string;
    error?: string;
}

export class WalletProvider {
    private cache: NodeCache;
    account: PrivateKeyAccount;
    walletClient: WalletClient;
    publicClient: PublicClient<HttpTransport, typeof zksync, Account | undefined>;

    constructor(account: PrivateKeyAccount) {
        this.account = account;
        this.walletClient = useGetWalletClient();
        this.publicClient = createPublicClient({
            chain: zksync,
            transport: http(),
        }) as PublicClient<HttpTransport, typeof zksync, Account | undefined>;
        this.cache = new NodeCache({ stdTTL: 300 });
    }

    getAddress() {
        return this.account.address;
    }

    getPublicClient() {
        return this.publicClient;
    }

    async getAllowace(
        tokenAddress: Address,
        owner: Address,
        spender: Address
    ): Promise<bigint> {
        return this.publicClient.readContract({
            address: tokenAddress,
            abi: erc20Abi,
            functionName: "allowance",
            args: [owner, spender],
        });
    }

    async approve(
        spenderAddress: Address,
        tokenAddress: Address,
        amount: bigint
    ) {
        await this.walletClient.writeContract({
            account: this.account,
            address: tokenAddress,
            abi: erc20Abi,
            chain: zksync,
            functionName: "approve",
            args: [spenderAddress, amount],
        });
    }

    async sendTransaction(req: SendTransactionParams): Promise<Hex> {
        const txRequest: SendTransactionParameters = {
            ...req,
            account: this.account,
            chain: zksync,
            kzg: undefined,
            data: req.data ? (req.data as `0x${string}`) : undefined,
            to: req.to ? (req.to as `0x${string}`) : undefined,
        };
        const tx = await this.walletClient.sendTransaction(txRequest);
        console.log("sendTransaction txhash:", tx);
        return tx;
    }

    async fetchPortfolio(): Promise<WalletPortfolio> {
        try {
            const cacheKey = `portfolio-${this.getAddress()}`;
            const cachedValue = this.cache.get<WalletPortfolio>(cacheKey);
            if (cachedValue) {
                elizaLogger.info("Cache hit for fetchPortfolio");
                return cachedValue;
            }
            elizaLogger.info("Cache miss for fetchPortfolio");

            const fetchUrl = `https://api.holdstation.com/api/user-balance/chain/324/wallet/${this.getAddress()}`;

            const portfolioResp = await fetch(fetchUrl);
            const portfolioData = await portfolioResp.json();
            if (!portfolioData || !portfolioData.success) {
                elizaLogger.error("Failed to fetch portfolio:", portfolioData);
                throw new Error(
                    `Failed to fetch portfolio: ${
                        portfolioData?.error || "Unknown error"
                    }`
                );
            }

            const items: Array<Item> =
                portfolioData.data.map(
                    (item: PortfolioItem): Item => ({
                        name: item.contract_name,
                        address: item.contract_address.startsWith('0x') 
                            ? item.contract_address as `0x${string}` 
                            : `0x${item.contract_address}` as `0x${string}`,
                        symbol: item.contract_ticker_symbol,
                        decimals: item.contract_decimals,
                    })
                ) || [];
            const portfolio: WalletPortfolio = { items };

            this.cache.set(cacheKey, portfolio);
            return portfolio;
        } catch (error) {
            elizaLogger.error("Error fetching portfolio:", error);
            throw error;
        }
    }

    async fetchAllTokens(): Promise<Array<Item>> {
        try {
            const cacheKey = 'all-hswallet-tokens';
            const cachedValue = this.cache.get<Array<Item>>(cacheKey);
            if (cachedValue) {
                elizaLogger.log("Cache hit for fetch all");
                return cachedValue;
            }
            elizaLogger.log("Cache miss for fetch all");

            const fetchUrl = 'https://tokens.coingecko.com/zksync/all.json';

            const tokensResp = await fetch(fetchUrl);
            const tokensData = await tokensResp.json();
            if (!tokensData || tokensData.error || !tokensData.data) {
                elizaLogger.error("Failed to fetch all tokens:", tokensData);
                throw new Error(
                    `Failed to fetch all tokens: ${
                        tokensData?.error || "Unknown error"
                    }`
                );
            }

            const tokens: Array<Item> =
                tokensData.tokens.map(
                    (item: TokenApiItem): Item => ({
                        name: item.name,
                        address: item.address.startsWith('0x') 
                            ? item.address as `0x${string}` 
                            : `0x${item.address}` as `0x${string}`,
                        symbol: item.symbol,
                        decimals: item.decimals,
                    })
                ) || [];

            this.cache.set(cacheKey, tokens);
            return tokens;
        } catch (error) {
            elizaLogger.error("Error fetching all tokens:", error);
            throw error;
        }
    }
}

export const initWalletProvider = async (runtime: IAgentRuntime) => {
    const account = useGetAccount(runtime);

    return new WalletProvider(account);
};

export const holdstationWalletProvider: Provider = {
    get: async (
        runtime: IAgentRuntime,
        _message: Memory,
        state?: State
    ): Promise<HoldstationWalletResponse> => {
        try {
            const walletProvider = await initWalletProvider(runtime);
            const agentName = state?.agentName || "The agent";
            return {
                message: `${agentName}'s HoldStation Wallet address: ${walletProvider.getAddress()}`
            };
        } catch (error) {
            console.error("Error in HoldStation Wallet provider:", error);
            return {
                message: "Failed to get wallet address",
                error: error instanceof Error ? error.message : "Unknown error"
            };
        }
    },
};
