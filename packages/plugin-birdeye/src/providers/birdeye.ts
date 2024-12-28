import {
    elizaLogger,
    IAgentRuntime,
    ICacheManager,
    Memory,
    Provider,
    settings,
    State,
} from "@elizaos/core";
import NodeCache from "node-cache";
import * as path from "path";
import { SearchTokensOptions } from "../types/search-token";
import { BirdeyeChain } from "../types/shared";
import { WalletDataOptions } from "../types/wallet";

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
    tokens: "/defi/tokenlist",
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

    private getUrlByType(type: string, address?: string) {
        const path = ENDPOINT_MAP[type];

        if (!path) {
            throw new Error(`Unsupported symbol ${type} in Birdeye provider`);
        }

        return `${API_BASE_URL}${path}${address || ""}`;
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
        address?: string
    ): Promise<any> {
        const key = `${type}/${address}`;
        const val = await this.readFromCache(key);

        if (val) {
            return val;
        }

        const url = this.getUrlByType(type, address);
        const data = await this.fetchWithRetry(url);

        await this.writeToCache(key, data);
        return data;
    }

    public async fetchTokenList() {
        return this.fetchWithCacheAndRetry("tokens");
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

    public async fetchSearchTokens(options: SearchTokensOptions) {
        const { keyword, chain = "all", limit = 1, offset = 0, type } = options;
        const params = new URLSearchParams({
            keyword,
            limit: limit.toString(),
            offset: offset.toString(),
            chain: chain,
        });

        const url = `${API_BASE_URL}/defi/v3/search?${params.toString()}`;
        const data = await this.fetchWithRetry(url);

        return type === "address"
            ? data.data.items
                  .filter(
                      (item) =>
                          item.type === "token" &&
                          item.result[0].address === keyword.toLowerCase()
                  )
                  .flatMap((item) => item.result)
            : data.data.items
                  .filter(
                      (item) =>
                          item.type === "token" &&
                          item.result[0].symbol === keyword
                  )
                  .flatMap((item) => item.result);
    }

    public async fetchSearchWallets(options: WalletDataOptions) {
        const { wallet, chain = "solana" } = options;
        const params = new URLSearchParams({
            wallet,
            chain: chain,
        });

        const url = `${API_BASE_URL}/v1/wallet/token_list?${params.toString()}`;
        const data = await this.fetchWithRetry(url, {
            headers: { "x-chain": chain },
        });

        return data.data.items;
    }

    public async fetchTokenMetadata(address: string, chain: BirdeyeChain) {
        const isValidAddress = (() => {
            switch (chain) {
                case "solana":
                    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
                case "sui":
                    return /^0x[a-fA-F0-9]{64}$/i.test(address);
                case "ethereum":
                case "arbitrum":
                case "avalanche":
                case "bsc":
                case "optimism":
                case "polygon":
                case "base":
                case "zksync":
                    return /^0x[a-fA-F0-9]{40}$/i.test(address);
                default:
                    return false;
            }
        })();

        if (!isValidAddress) {
            elizaLogger.error(
                `Invalid address format for ${chain}: ${address}`
            );
            return null;
        }

        const params = new URLSearchParams({ address });
        const url = `${API_BASE_URL}/defi/v3/token/meta-data/single?${params.toString()}`;

        return this.fetchWithRetry(url, {
            headers: { "x-chain": chain },
        }).catch(() => null);
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

            const resp = await provider.fetchTokenList().catch((err) => {
                elizaLogger.warn("Couldn't update symbol map", err);
            });

            resp?.data?.tokens?.forEach((item) => {
                DEFAULT_SUPPORTED_SYMBOLS[item.symbol] = item.address;
            });

            const supportedTokens = Object.keys(DEFAULT_SUPPORTED_SYMBOLS).join(
                ", "
            );

            if (!walletAddr) {
                console.warn("No Birdeye wallet was specified");

                return `Birdeye enabled, no wallet found, supported tokens: [${supportedTokens}]`;
            }
            const response = await provider.fetchWalletPortfolio(walletAddr);
            const portfolio = response?.data.items
                .map((e) => e.symbol)
                .join(", ");

            return `Birdeye enabled, wallet addr: ${walletAddr}, portfolio: [${portfolio}], supported tokens: [${supportedTokens}]`;
        } catch (error) {
            console.error("Error fetching token data:", error);
            return "Unable to fetch token information. Please try again later.";
        }
    },
};
