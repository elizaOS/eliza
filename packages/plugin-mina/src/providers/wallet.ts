import type {
    IAgentRuntime,
    ICacheManager,
    Memory,
    Provider,
    State,
} from "@elizaos/core";

import { Mina, PublicKey, UInt64, fetchAccount } from "o1js";
import NodeCache from "node-cache";
import * as path from "node:path";
import { parseAccount } from "../utils";
import { MINA_UNIT, USD_UNIT } from "../constants";
import BigNumber from "bignumber.js";

// Provider configuration
const PROVIDER_CONFIG = {
    MAX_RETRIES: 3,
    RETRY_DELAY: 2000,
};

interface WalletPortfolio {
    totalUsd: string;
    totalMina: string;
}

interface Prices {
    mina: { usd: number };
}

export class WalletProvider {
    private cache: NodeCache;
    private cacheKey = "mina/wallet";

    constructor(
        network: string,
        private account: PublicKey,
        private cacheManager: ICacheManager,
    ) {
        const minaClient = Mina.Network({
            mina: `https://api.minascan.io/node/${network}/v1/graphql/`,
            archive: `https://api.minascan.io/archive/${network}/v1/graphql/`,
        });
        Mina.setActiveInstance(minaClient);
        this.cache = new NodeCache({ stdTTL: 300 }); // Cache TTL set to 5 minutes
    }

    get address(): string {
        return this.account.toBase58();
    }

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
                    "https://data-api.binance.vision/api/v3/ticker/price?symbols=[%22MINAUSDT%22]",
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
                    const delay = PROVIDER_CONFIG.RETRY_DELAY * (2 ** i); // Using ** instead of Math.pow
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
            }
        }

        console.error(
            "All attempts failed. Throwing the last error:",
            lastError,
        );
        throw lastError;
    }

    async getBalance(): Promise<UInt64> {
        const account = await fetchAccount({ publicKey: this.account });
        return account.account.balance;
    }

    async fetchPortfolioValue(): Promise<WalletPortfolio> {
        try {
            const cacheKey = `portfolio-${this.address}`;
            const cachedValue =
                await this.getCachedData<WalletPortfolio>(cacheKey);

            if (cachedValue) {
                console.log("Cache hit for fetchPortfolioValue", cachedValue);
                return cachedValue;
            }
            console.log("Cache miss for fetchPortfolioValue");

            const prices = await this.fetchPrices().catch((error) => {
                console.error("Error fetching MINA price:", error);
                throw error;
            });
            const minaAmount = (await this.getBalance()).div(MINA_UNIT);

            const usdPrice = Math.round(prices.mina.usd * USD_UNIT);
            const totalUsd = minaAmount.mul(usdPrice).div(USD_UNIT);

            const portfolio = {
                totalUsd: totalUsd.toString(),
                totalMina: minaAmount.toString(),
            };
            this.setCachedData(cacheKey, portfolio);
            console.log("Fetched portfolio:", portfolio);
            return portfolio;
        } catch (error) {
            console.error("Error fetching portfolio:", error);
            throw error;
        }
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

            const minaPriceData = await this.fetchPricesWithRetry().catch(
                (error) => {
                    console.error("Error fetching MINA price:", error);
                    throw error;
                },
            );
            const prices: Prices = {
                mina: { usd: Number(minaPriceData[0].price) },
            };
            this.setCachedData(cacheKey, prices);
            return prices;
        } catch (error) {
            console.error("Error fetching prices:", error);
            throw error;
        }
    }

    formatPortfolio(
        runtime: IAgentRuntime,
        portfolio: WalletPortfolio,
    ): string {
        const totalUsd = new BigNumber(portfolio.totalUsd).toFixed(2);
        const totalMina = new BigNumber(portfolio.totalMina).toFixed(2);
        return `${runtime.character.name}\nWallet Address: ${this.address}\nTotal Value: $${totalUsd} (${totalMina} MINA)\n`;
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
}

const walletProvider: Provider = {
    get: async (
        runtime: IAgentRuntime,
        _message: Memory,
        _state?: State,
    ): Promise<string | null> => {
        const minaAccount = parseAccount(runtime);

        try {
            const network = runtime.getSetting("MINA_NETWORK");
            const provider = new WalletProvider(
                network,
                minaAccount.toPublicKey(),
                runtime.cacheManager,
            );
            return await provider.getFormattedPortfolio(runtime);
        } catch (error) {
            console.error("Error in wallet provider:", error);
            return null;
        }
    },
};

// Module exports
export { walletProvider };
