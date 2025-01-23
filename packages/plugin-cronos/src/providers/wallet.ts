import {
    createPublicClient,
    createWalletClient,
    formatUnits,
    http,
    type Address,
    type WalletClient,
    type PublicClient,
    type Chain,
    type HttpTransport,
    type Account,
    type PrivateKeyAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
    type IAgentRuntime,
    type Memory,
    type State,
    type ICacheManager,
    elizaLogger,
} from "@elizaos/core";
import NodeCache from "node-cache";
import * as path from "path";

import { cronos, cronosTestnet } from "../constants/chains";
import type { CronosChain, CronosProvider } from "../types";

export class CronosWalletProvider {
    private cache: NodeCache;
    private cacheKey: string = "cronos/wallet";
    private currentChain: CronosChain = "cronos";
    private CACHE_EXPIRY_SEC = 5;
    chains: Record<CronosChain, Chain> = {
        cronos,
        cronosTestnet,
    };
    account: PrivateKeyAccount;

    constructor(
        accountOrPrivateKey: PrivateKeyAccount | `0x${string}`,
        private cacheManager: ICacheManager
    ) {
        this.setAccount(accountOrPrivateKey);
        this.cache = new NodeCache({ stdTTL: this.CACHE_EXPIRY_SEC });
    }

    getAddress(): Address {
        return this.account.address;
    }

    getCurrentChain(): Chain {
        return this.chains[this.currentChain];
    }

    getPublicClient(
        chainName: CronosChain
    ): PublicClient<HttpTransport, Chain, Account | undefined> {
        const transport = this.createHttpTransport(chainName);

        const publicClient = createPublicClient({
            chain: this.chains[chainName],
            transport,
        });
        return publicClient;
    }

    getWalletClient(chainName: CronosChain): WalletClient {
        const transport = this.createHttpTransport(chainName);

        const walletClient = createWalletClient({
            chain: this.chains[chainName],
            transport,
            account: this.account,
        });

        return walletClient;
    }

    async getWalletBalance(): Promise<string | null> {
        return this.getAddressBalance(this.account.address);
    }

    async getAddressBalance(address: Address): Promise<string | null> {
        const cacheKey = `balance_${address}_${this.currentChain}`;
        const cachedData = await this.getCachedData<string>(cacheKey);
        if (cachedData) {
            elizaLogger.log(
                `Returning cached balance for address ${address} on chain: ${this.currentChain}`
            );
            return cachedData;
        }

        try {
            const client = this.getPublicClient(this.currentChain);
            const balance = await client.getBalance({
                address,
            });
            const balanceFormatted = formatUnits(balance, 18);
            this.setCachedData<string>(cacheKey, balanceFormatted);
            elizaLogger.log(
                `Balance cached for address ${address} on chain: ${this.currentChain}`
            );
            return balanceFormatted;
        } catch (error) {
            console.error(`Error getting balance for address ${address}:`, error);
            return null;
        }
    }

    switchChain(chainName: CronosChain) {
        if (!this.chains[chainName]) {
            throw new Error(`Invalid Cronos chain: ${chainName}`);
        }
        this.currentChain = chainName;
    }

    private async readFromCache<T>(key: string): Promise<T | null> {
        const cached = await this.cacheManager.get<T>(
            path.join(this.cacheKey, key)
        );
        return cached;
    }

    private async writeToCache<T>(key: string, data: T): Promise<void> {
        await this.cacheManager.set(path.join(this.cacheKey, key), data, {
            expires: Date.now() + this.CACHE_EXPIRY_SEC * 1000,
        });
    }

    private async getCachedData<T>(key: string): Promise<T | null> {
        const cachedData = this.cache.get<T>(key);
        if (cachedData) {
            return cachedData;
        }

        const fileCachedData = await this.readFromCache<T>(key);
        if (fileCachedData) {
            this.cache.set(key, fileCachedData);
            return fileCachedData;
        }

        return null;
    }

    private async setCachedData<T>(cacheKey: string, data: T): Promise<void> {
        this.cache.set(cacheKey, data);
        await this.writeToCache(cacheKey, data);
    }

    private setAccount = (
        accountOrPrivateKey: PrivateKeyAccount | `0x${string}`
    ) => {
        if (typeof accountOrPrivateKey === "string") {
            this.account = privateKeyToAccount(accountOrPrivateKey);
        } else {
            this.account = accountOrPrivateKey;
        }
    };

    private createHttpTransport = (chainName: CronosChain) => {
        const chain = this.chains[chainName];
        return http(chain.rpcUrls.default.http[0]);
    };
}

export const initCronosWalletProvider = async (runtime: IAgentRuntime) => {
    const privateKey = runtime.getSetting("CRONOS_PRIVATE_KEY") as `0x${string}`;
    if (!privateKey) {
        throw new Error("CRONOS_PRIVATE_KEY is missing");
    }
    return new CronosWalletProvider(privateKey, runtime.cacheManager);
};

export const cronosWalletProvider: CronosProvider = {
    async get(
        runtime: IAgentRuntime,
        _message: Memory,
        state?: State
    ): Promise<string | null> {
        try {
            const walletProvider = await initCronosWalletProvider(runtime);
            const address = walletProvider.getAddress();
            const balance = await walletProvider.getWalletBalance();
            const chain = walletProvider.getCurrentChain();
            const agentName = state?.agentName || "The agent";

            return `${agentName}'s Cronos Wallet:
Address: ${address}
Balance: ${balance} ${chain.nativeCurrency.symbol}
Chain: ${chain.name} (ID: ${chain.id})
RPC: ${chain.rpcUrls.default.http[0]}`;
        } catch (error) {
            console.error("Error in Cronos wallet provider:", error);
            return null;
        }
    },
};