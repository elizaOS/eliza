import type {
    IAgentRuntime,
    ICacheManager,
    Memory,
    Provider,
    State,
} from "@elizaos/core";

import { TonClient, WalletContractV4, fromNano } from "@ton/ton";
import {
    type KeyPair,
    mnemonicToPrivateKey,
    mnemonicToWalletKey,
} from "@ton/crypto";

import NodeCache from "node-cache";
import * as path from "node:path";  // Changed to use node: protocol
import BigNumber from "bignumber.js";
import { CONFIG_KEYS } from "../enviroment";

const PROVIDER_CONFIG = {
    MAINNET_RPC: "https://toncenter.com/api/v2/jsonRPC",
    RPC_API_KEY: "",
    STONFI_TON_USD_POOL: "EQCGScrZe1xbyWqWDvdI6mzP-GAcAWFv6ZXuaJOuSqemxku4",
    CHAIN_NAME_IN_DEXSCREENER: "ton",
    // USD_DECIMAL=10^6
    MAX_RETRIES: 3,
    RETRY_DELAY: 2000,
    // 10^9
    TON_DECIMAL: BigInt(1000000000),
};

interface WalletPortfolio {
    totalUsd: string;
    totalNativeToken: string;
}

interface Prices {
    nativeToken: { usd: BigNumber };
}

export class WalletProvider {
    keypair: KeyPair;
    wallet: WalletContractV4;
    private cache: NodeCache;
    private cacheKey = "ton/wallet";
    private rpcApiKey: string;

    constructor(
        // mnemonic: string,
        keypair: KeyPair,
        private endpoint: string,
        private cacheManager: ICacheManager,
    ) {
        this.keypair = keypair;
        this.cache = new NodeCache({ stdTTL: 300 });
        this.wallet = WalletContractV4.create({
            workchain: 0,
            publicKey: keypair.publicKey,
        });
        this.rpcApiKey = process.env.TON_RPC_API_KEY || PROVIDER_CONFIG.RPC_API_KEY;
    }

    // thanks to plugin-sui
    private async readFromCache<T>(key: string): Promise<T | null> {
        const cached = await this.cacheManager.get<T>(
            path.join(this.cacheKey, key),
        );
        return cached;
    }

    private async writeToCache<T>(key: string, data: T): Promise<void> {
        await this.cacheManager.set(path.join(this.cacheKey, key), data, {
            expires: Date.now() + 5 * 60 * 1000,
        });
    }

    private async getCachedData<T>(key: string): Promise<T | null> {
        // Check in-memory cache first
        const cachedData = this.cache.get<T>(key);
        if (cachedData) {
            return cachedData;
        }

        // Check file-based cache
        const fileCachedData = await this.readFromCache<T>(key);
        if (fileCachedData) {
            // Populate in-memory cache
            this.cache.set(key, fileCachedData);
            return fileCachedData;
        }

        return null;
    }

    private async setCachedData<T>(cacheKey: string, data: T): Promise<void> {
        // Set in-memory cache
        this.cache.set(cacheKey, data);

        // Write to file-based cache
        await this.writeToCache(cacheKey, data);
    }

    private async fetchPricesWithRetry() {
        let lastError: Error;

        for (let i = 0; i < PROVIDER_CONFIG.MAX_RETRIES; i++) {
            try {
                const response = await fetch(
                    `https://api.dexscreener.com/latest/dex/pairs/${PROVIDER_CONFIG.CHAIN_NAME_IN_DEXSCREENER}/${PROVIDER_CONFIG.STONFI_TON_USD_POOL}`,
                );

                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(
                        `HTTP error! status: ${response.status}, message: ${errorText}`,
                    );
                }

                const data = await response.json();
                return data;
            } catch (error) {
                console.error(`Attempt ${i + 1} failed:`, error);
                lastError = error;
                if (i < PROVIDER_CONFIG.MAX_RETRIES - 1) {
                    const delay = PROVIDER_CONFIG.RETRY_DELAY * (2 ** i);  // Changed Math.pow to ** operator
                    await new Promise((resolve) => setTimeout(resolve, delay));
                    // Removed unnecessary continue
                }
            }
        }

        console.error(
            "All attempts failed. Throwing the last error:",
            lastError,
        );
        throw lastError;
    }

    async fetchPrices(): Promise<Prices> {
        try {
            const cacheKey = "prices";
            const cachedValue = await this.getCachedData<Prices>(cacheKey);

            if (cachedValue) {
                console.log("Cache hit for fetchPrices");
                return cachedValue;
            }
            console.log("Cache miss for fetchPrices");

            const priceData = await this.fetchPricesWithRetry().catch(
                (error) => {
                    console.error(
                        `Error fetching ${PROVIDER_CONFIG.CHAIN_NAME_IN_DEXSCREENER.toUpperCase()} price:`,
                        error,
                    );
                    throw error;
                },
            );
            const prices: Prices = {
                nativeToken: { usd: new BigNumber(priceData.pair.priceUsd).dividedBy(new BigNumber(priceData.pair.priceNative)) },
            };
            this.setCachedData(cacheKey, prices);
            return prices;
        } catch (error) {
            console.error("Error fetching prices:", error);
            throw error;
        }
    }

    private formatPortfolio(
        runtime: IAgentRuntime,
        portfolio: WalletPortfolio,
    ): string {
        let output = `${runtime.character.name}\n`;
        output += `Wallet Address: ${this.getAddress()}\n`;

        const totalUsdFormatted = new BigNumber(portfolio.totalUsd).toFixed(2);
        const totalNativeTokenFormatted = new BigNumber(
            portfolio.totalNativeToken,
        ).toFixed(4);

        output += `Total Value: $${totalUsdFormatted} (${totalNativeTokenFormatted} ${PROVIDER_CONFIG.CHAIN_NAME_IN_DEXSCREENER.toUpperCase()})\n`;

        return output;
    }

    private async fetchPortfolioValue(): Promise<WalletPortfolio> {
        try {
            const cacheKey = `portfolio-${this.getAddress()}`;
            const cachedValue =
                await this.getCachedData<WalletPortfolio>(cacheKey);

            if (cachedValue) {
                console.log("Cache hit for fetchPortfolioValue", cachedValue);
                return cachedValue;
            }
            console.log("Cache miss for fetchPortfolioValue");

            const prices = await this.fetchPrices().catch((error) => {
                console.error(
                    `Error fetching ${PROVIDER_CONFIG.CHAIN_NAME_IN_DEXSCREENER.toUpperCase()} price:`,
                    error,
                );
                throw error;
            });
            const nativeTokenBalance = await this.getWalletBalance().catch(
                (error) => {
                    console.error(
                        `Error fetching ${PROVIDER_CONFIG.CHAIN_NAME_IN_DEXSCREENER.toUpperCase()} amount:`,
                        error,
                    );
                    throw error;
                },
            );

            const amount =
                Number(nativeTokenBalance) /
                Number(PROVIDER_CONFIG.TON_DECIMAL);
            const totalUsd = new BigNumber(amount.toString()).times(
                prices.nativeToken.usd,
            );

            const portfolio = {
                totalUsd: totalUsd.toString(),
                totalNativeToken: amount.toFixed(4).toString(),
            };

            this.setCachedData(cacheKey, portfolio);
            return portfolio;
        } catch (error) {
            console.error("Error fetching portfolio:", error);
            throw error;
        }
    }

    async getFormattedPortfolio(runtime: IAgentRuntime): Promise<string> {
        try {
            const portfolio = await this.fetchPortfolioValue();
            return this.formatPortfolio(runtime, portfolio);
        } catch (error) {
            console.error("Error generating portfolio report:", error);
            return "Unable to fetch wallet information. Please try again later.";
        }
    }

    getAddress(): string {
        const formattedAddress = this.wallet.address.toString({
            bounceable: false,
            urlSafe: true,
        });
        return formattedAddress;
    }

    getWalletClient(): TonClient {
        const client = new TonClient({
            endpoint: this.endpoint,
            apiKey: this.rpcApiKey,
        });
        return client;
    }

    async getWalletBalance(): Promise<bigint | null> {
        try {
            const client = this.getWalletClient();
            const balance = await client.getBalance(this.wallet.address);
            return balance;
        } catch (error) {
            console.error("Error getting wallet balance:", error);
            return null;
        }
    }
}

// export const initWalletProvider = async (runtime: IAgentRuntime) => {
//     const privateKey = runtime.getSetting(CONFIG_KEYS.TON_PRIVATE_KEY);
//     let mnemonics: string[];

//     if (!privateKey) {
//         throw new Error(`${CONFIG_KEYS.TON_PRIVATE_KEY} is missing`);
//     } else {
//         mnemonics = privateKey.split(" ");
//         if (mnemonics.length < 2) {
//             throw new Error(`${CONFIG_KEYS.TON_PRIVATE_KEY} mnemonic seems invalid`);
//         }
//     }

export const initWalletProvider = async (runtime: IAgentRuntime) => {
    const privateKey = runtime.getSetting(CONFIG_KEYS.TON_PRIVATE_KEY);
    // Removed unnecessary else clause
    if (!privateKey) {
        throw new Error(`${CONFIG_KEYS.TON_PRIVATE_KEY} is missing`);
    }
    
    const mnemonics = privateKey.split(" ");
    if (mnemonics.length < 2) {
        throw new Error(`${CONFIG_KEYS.TON_PRIVATE_KEY} mnemonic seems invalid`);
    }

    const rpcUrl =
        runtime.getSetting("TON_RPC_URL") || PROVIDER_CONFIG.MAINNET_RPC;

    const keypair = await mnemonicToWalletKey(mnemonics, "");
    return new WalletProvider(keypair, rpcUrl, runtime.cacheManager);
};

export const nativeWalletProvider: Provider = {
    async get(
        runtime: IAgentRuntime,
        // eslint-disable-next-line
        _message: Memory,
        // eslint-disable-next-line
        _state?: State,
    ): Promise<string | null> {
        try {
            const walletProvider = await initWalletProvider(runtime);
            const formattedPortfolio =
                await walletProvider.getFormattedPortfolio(runtime);
            console.log(formattedPortfolio);
            return formattedPortfolio;
        } catch (error) {
            console.error(
                `Error in ${PROVIDER_CONFIG.CHAIN_NAME_IN_DEXSCREENER.toUpperCase()} wallet provider:`,
                error,
            );
            return null;
        }
    },
};
