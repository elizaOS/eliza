import NodeCache from "node-cache";
import * as path from "path";
import { ICacheManager, settings } from "@elizaos/core";
import { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";

const DEFAULT_MAX_RETRIES = 3;

const DEFAULT_SUPPORTED_SYMBOLS = {
    SOL: "So11111111111111111111111111111111111111112",
    BTC: "qfnqNqs3nCAHjnyCgLRDbBtq4p2MtHZxw8YjSyYhPoL",
    ETH: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
    Example: "2weMjPLLybRMMva1fM3U31goWWrCpF59CHWNhnCJ9Vyh",
};

const API_BASE_URL = "https://public-api.birdeye.so";
const ENDPOINT_MAP = {
    price: "/defi/price?address=",
    security: "/defi/token_security?address=",
    volume: "/defi/v3/token/trade-data/single?address=",
    portfolio: "/v1/wallet/token_list?wallet=",
};
const RETRY_DELAY_MS = 2_000;

const waitFor = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

class BaseCachedProvider {
    private cache: NodeCache;

    constructor(
        private cacheManager: ICacheManager,
        private cacheKey,
        ttl?: number
    ) {
        this.cache = new NodeCache({ stdTTL: ttl || 300 });
    }

    private readFsCache<T>(key: string): Promise<T | null> {
        return this.cacheManager.get<T>(path.join(this.cacheKey, key));
    }

    private writeFsCache<T>(key: string, data: T): Promise<void> {
        return this.cacheManager.set(path.join(this.cacheKey, key), data, {
            expires: Date.now() + 5 * 60 * 1000,
        });
    }

    public async readFromCache<T>(key: string): Promise<T | null> {
        // get memory cache first
        const val = this.cache.get<T>(key);
        if (val) {
            return val;
        }

        const fsVal = await this.readFsCache<T>(key);
        if (fsVal) {
            // set to memory cache
            this.cache.set(key, fsVal);
        }

        return fsVal;
    }

    public async writeToCache<T>(key: string, val: T): Promise<void> {
        // Set in-memory cache
        this.cache.set(key, val);

        // Write to file-based cache
        await this.writeFsCache(key, val);
    }
}

export class BirdeyeProvider extends BaseCachedProvider {
    private symbolMap: Record<string, string>;
    private maxRetries: number;

    constructor(
        cacheManager: ICacheManager,
        symbolMap?: Record<string, string>,
        maxRetries?: number
    ) {
        super(cacheManager, "birdeye/data");
        this.symbolMap = symbolMap || DEFAULT_SUPPORTED_SYMBOLS;
        this.maxRetries = maxRetries || DEFAULT_MAX_RETRIES;
    }

    public getTokenAddress(symbol: string) {
        const addr = this.symbolMap[symbol];

        if (!addr) {
            throw new Error(`Unsupported symbol ${symbol} in Birdeye provider`);
        }

        return addr;
    }

    private getUrlByType(type: string, address: string) {
        const path = ENDPOINT_MAP[type];

        if (!path) {
            throw new Error(`Unsupported symbol ${type} in Birdeye provider`);
        }

        return `${API_BASE_URL}${path}${address}`;
    }

    private async fetchWithRetry(
        url: string,
        options: RequestInit = {}
    ): Promise<any> {
        let attempts = 0;

        while (attempts < this.maxRetries) {
            attempts++;
            try {
                const resp = await fetch(url, {
                    ...options,
                    headers: {
                        Accept: "application/json",
                        "x-chain": settings.BIRDEYE_CHAIN || "solana",
                        "X-API-KEY": settings.BIRDEYE_API_KEY || "",
                        ...options.headers,
                    },
                });

                if (!resp.ok) {
                    const errorText = await resp.text();
                    throw new Error(
                        `HTTP error! status: ${resp.status}, message: ${errorText}`
                    );
                }

                const data = await resp.json();
                return data;
            } catch (error) {
                if (attempts === this.maxRetries) {
                    // failed after all
                    throw error;
                }
                await waitFor(RETRY_DELAY_MS);
            }
        }
    }

    private async fetchWithCacheAndRetry(
        type: string,
        address: string
    ): Promise<any> {
        const key = `${type}/${address}`
        const val = await this.readFromCache(key)

        if (val) {
            return val
        }

        const url = this.getUrlByType(type, address);
        const data = await this.fetchWithRetry(url);

        await this.writeToCache(key, data)
        return data
    }

    public async fetchPriceBySymbol(symbol: string) {
        return this.fetchPriceByAddress(this.getTokenAddress(symbol));
    }
    public async fetchPriceByAddress(address: string) {
        return this.fetchWithCacheAndRetry("price", address);
    }

    public async fetchTokenSecurityBySymbol(symbol: string) {
        return this.fetchTokenSecurityByAddress(this.getTokenAddress(symbol));
    }
    public async fetchTokenSecurityByAddress(address: string) {
        return this.fetchWithCacheAndRetry("security", address);
    }

    public async fetchTokenTradeDataBySymbol(symbol: string) {
        return this.fetchTokenTradeDataByAddress(this.getTokenAddress(symbol));
    }
    public async fetchTokenTradeDataByAddress(address: string) {
        return this.fetchWithCacheAndRetry("volume", address);
    }

    public async fetchWalletPortfolio(address: string) {
        return this.fetchWithCacheAndRetry("portfolio", address);
    }
}

export const birdeyeProvider: Provider = {
    get: async (
        runtime: IAgentRuntime,
        _message: Memory,
        _state?: State
    ): Promise<string> => {
        try {
            const provider = new BirdeyeProvider(runtime.cacheManager);

            const walletAddr = runtime.getSetting("BIRDEYE_WALLET_ADDR");

            if (!walletAddr) {
                console.warn("No Birdeye wallet was specified");

                return `Birdeye provider initiated with no wallet found`;
            }

            const portfolio = await provider.fetchWalletPortfolio(walletAddr);

            return `Birdeye wallet addr: ${walletAddr}, portfolio: ${portfolio}`;
        } catch (error) {
            console.error("Error fetching token data:", error);
            return "Unable to fetch token information. Please try again later.";
        }
    },
};
