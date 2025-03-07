import type { CacheOptions, IAgentRuntime } from "@elizaos/core";
import BigNumber from "bignumber.js";
import * as dotenv from "dotenv";
import {
    BTC_ADDRESS,
    ETH_ADDRESS,
    SOL_ADDRESS
} from "./constants";
import type {
    DexScreenerData,
    DexScreenerPair,
    HolderData,
    Prices,
    TokenOverview,
    TokenSecurityData,
    TokenTradeData,
    WalletPortfolio,
    WalletPortfolioItem
} from "./types";
dotenv.config();

let nextRpcRequestId = 1;

type QueryParams =
    | Record<string, string | number | boolean | null | undefined>
    | URLSearchParams;

interface RetryOptions {
    maxRetries?: number;
    initialDelay?: number;
    maxDelay?: number;
    backoffFactor?: number;
    retryableStatuses?: number[];
}

interface RequestOptions extends RequestInit {
    retryOptions?: RetryOptions;
    params?: QueryParams;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
    maxRetries: 3,
    initialDelay: 1000,
    maxDelay: 30000,
    backoffFactor: 2,
    retryableStatuses: [408, 429, 500, 502, 503, 504],
};

class RequestError extends Error {
    constructor(
        message: string,
        public response?: Response
    ) {
        super(message);
        this.name = "RequestError";
    }
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

const calculateDelay = (
    attempt: number,
    options: Required<RetryOptions>
): number => {
    const delay =
        options.initialDelay * options.backoffFactor ** (attempt - 1);
    return Math.min(delay, options.maxDelay);
};

const isRetryableError = (error: any): boolean =>
    error.name === "TypeError" ||
    error.name === "AbortError" ||
    error instanceof RequestError;

const buildUrl = (url: string, params?: QueryParams): string => {
    if (!params) return url;

    const searchParams =
        params instanceof URLSearchParams
            ? params
            : new URLSearchParams(
                  Object.entries(params)
                      .filter(([_, value]) => value != null)
                      .map(([key, value]) => [key, String(value)])
              );

    const separator = url.includes("?") ? "&" : "?";
    const queryString = searchParams.toString();

    return queryString ? `${url}${separator}${queryString}` : url;
};

export const http = {
    async request(url: string, options?: RequestOptions): Promise<Response> {
        const { params, ...fetchOptions } = options || {};
        const fullUrl = buildUrl(url, params);

        const retryOptions: Required<RetryOptions> = {
            ...DEFAULT_RETRY_OPTIONS,
            ...options?.retryOptions,
        };

        let attempt = 1;

        while (true) {
            try {
                const res = await fetch(fullUrl, fetchOptions);

                if (!res.ok) {
                    const errorText = await res.text();
                    throw new RequestError(
                        `Request failed with status ${res.status}: ${errorText}`,
                        res
                    );
                }

                return res;
            } catch (error: any) {
                if (
                    isRetryableError(error) &&
                    attempt < retryOptions.maxRetries
                ) {
                    const delay = calculateDelay(attempt, retryOptions);
                    console.warn(
                        `Request failed with error: ${error.message}. ` +
                            `Retrying in ${delay}ms (attempt ${attempt}/${retryOptions.maxRetries})`
                    );
                    await sleep(delay);
                    attempt++;
                    continue;
                }
                console.error(
                    `Request failed after ${attempt} attempts:`,
                    error
                );

                throw error;
            }
        }
    },

    async json<T = any>(url: string, options?: RequestOptions) {
        const res = await this.request(url, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                ...options?.headers,
            },
        });
        return (await res.json()) as T;
    },

    get: {
        async request(
            url: string,
            params?: QueryParams,
            options?: RequestInit
        ) {
            return http.request(url, {
                ...options,
                method: "GET",
                params,
            });
        },
        async json<T = any>(
            url: string,
            params?: QueryParams,
            options?: RequestInit
        ) {
            return http.json<T>(url, {
                ...options,
                method: "GET",
                params,
            });
        },
    },

    post: {
        async request(url: string, body: object, options?: RequestOptions) {
            return http.request(url, {
                ...options,
                method: "POST",
                body: JSON.stringify(body),
            });
        },

        async json<ReturnType = any, Body extends object = object>(
            url: string,
            body: Body,
            options?: RequestOptions
        ) {
            return http.json<ReturnType>(url, {
                ...options,
                method: "POST",
                body: JSON.stringify(body),
            });
        },
    },

    async jsonrpc<_ReturnType = any, Params extends object = object>(
        url: string,
        method: string,
        params: Params,
        headers?: HeadersInit
    ) {
        return this.post.json(
            url,
            {
                jsonrpc: "2.0",
                id: nextRpcRequestId++,
                method,
                params,
            },
            { headers }
        );
    },

    async graphql<_ReturnType = any, Variables extends object = object>(
        url: string,
        query: string,
        variables: Variables,
        headers?: HeadersInit
    ) {
        return this.post.json(
            url,
            {
                query,
                variables,
            },
            { headers }
        );
    },
};

export class JupiterClient {
    static baseUrl = "https://api.jup.ag/swap/v1";
    static xApiKey = process.env.JUPITER_API_KEY || "";

    static async getQuote(
        inputMint: string,
        outputMint: string,
        amount: string,
        slippageBps = 50
    ) {
        const headers: Record<string, string> = {};
        if (JupiterClient.xApiKey) {
            headers["x-api-key"] = JupiterClient.xApiKey;
        }

        const quote = await http.get.json<
            | {
                  inputMint: string;
                  outputMint: string;
                  inAmount: string;
                  outAmount: string;
                  routePlan: any[];
              }
            | { error: unknown }
        >(
            `${JupiterClient.baseUrl}/quote`,
            {
                inputMint,
                outputMint,
                amount,
                slippageBps: slippageBps.toString(),
            },
            { headers }
        );

        if ("error" in quote) {
            console.error("Quote error:", quote);
            throw new Error(
                `Failed to get quote: ${quote?.error || "Unknown error"}`
            );
        }

        return quote;
    }

    static async swap(quoteData: any, walletPublicKey: string) {
        const headers: Record<string, string> = {};
        if (JupiterClient.xApiKey) {
            headers["x-api-key"] = JupiterClient.xApiKey;
        }

        const swapRequestBody = {
            quoteResponse: quoteData,
            userPublicKey: walletPublicKey,
            wrapAndUnwrapSol: true,
            computeUnitPriceMicroLamports: 2000000,
            dynamicComputeUnitLimit: true,
        };

        const swapData = await http.post.json(
            `${JupiterClient.baseUrl}/swap`,
            swapRequestBody,
            { headers }
        );

        if (!swapData || !swapData.swapTransaction) {
            console.error("Swap error:", swapData);
            throw new Error(
                `Failed to get swap transaction: ${swapData?.error || "No swap transaction returned"}`
            );
        }

        return swapData;
    }
}

type DexscreenerOptions = {
    expires?: string | CacheOptions["expires"];
};

export class DexscreenerClient {
    constructor(private runtime: IAgentRuntime) {}

    static createFromRuntime(runtime: IAgentRuntime) {
        return new DexscreenerClient(runtime);
    }

    async request<T = any>(
        path: string,
        params?: QueryParams,
        options?: DexscreenerOptions
    ) {
        const cacheKey = [
            "dexscreener",
            buildUrl(path, params), // remove first "/"
        ]
            .filter(Boolean)
            .join("/");

        if (options?.expires) {
            const cached = await this.runtime.getDatabaseAdapter().getCache<T>(cacheKey);
            if (cached) return cached;
        }

        console.log("Fetching DexScreener: ", { path, params });

        const res = await http.get.json<T>(
            `https://api.dexscreener.com/${path}`,
            params
        );

        if (options?.expires) {
            await this.runtime.getDatabaseAdapter().setCache<T>(cacheKey, res);
        }

        return res;
    }

    async search(
        address: string,
        options?: DexscreenerOptions
    ): Promise<DexScreenerData> {
        try {
            const data = await this.request<DexScreenerData>(
                "latest/dex/search",
                {
                    q: address,
                },
                options
            );

            if (!data || !data.pairs) {
                throw new Error("No DexScreener data available");
            }

            return data;
        } catch (error) {
            console.error("Error fetching DexScreener data:", error);
            return {
                schemaVersion: "1.0.0",
                pairs: [],
            };
        }
    }

    async searchForHighestLiquidityPair(
        address: string,
        chain?: string,
        options?: DexscreenerOptions
    ): Promise<DexScreenerPair | null> {
        let { pairs } = await this.search(address, options);

        if (pairs.length === 0) {
            return null;
        }

        if (chain) {
            pairs = pairs.filter((pair) => pair.chainId === chain);
        }

        // Sort pairs by both liquidity and market cap to get the highest one
        return pairs.sort((a, b) => {
            const liquidityA = a.liquidity?.usd ?? 0;
            const liquidityB = b.liquidity?.usd ?? 0;
            return liquidityB < liquidityA ? -1 : 1;
        })[0];
    }
}

export class HeliusClient {
    private runtime: IAgentRuntime;
    
    constructor(
        private readonly apiKey: string,
        _runtime: IAgentRuntime
    ) {}

    static createFromRuntime(runtime: IAgentRuntime) {
        const apiKey = runtime.getSetting("HELIUS_API_KEY");

        if (!apiKey) {
            throw new Error("missing HELIUS_API_KEY");
        }

        return new HeliusClient(apiKey, runtime);
    }

    async fetchHolderList(
        address: string,
        options?: { expires?: string | CacheOptions["expires"] }
    ): Promise<HolderData[]> {
        if (options?.expires) {
            const cached = await this.runtime.getDatabaseAdapter().getCache<HolderData[]>(
                `helius/token-holders/${address}`
            );

            if (cached) return cached;
        }

        console.log("fetching holder list for:", address);

        const allHoldersMap = new Map<string, number>();
        let page = 1;
        const limit = 1000;
        let cursor;
        //HELIOUS_API_KEY needs to be added
        const url = `https://mainnet.helius-rpc.com/?api-key=${this.apiKey}`;

        try {
            while (true) {
                const params = {
                    limit: limit,
                    displayOptions: {},
                    mint: address,
                    cursor: cursor,
                };

                if (cursor !== undefined) {
                    params.cursor = cursor;
                }

                console.log(`Fetching holders - Page ${page}`);

                if (page > 2) {
                    break;
                }

                const data = await http.jsonrpc(
                    url,
                    "getTokenAccounts",
                    params
                );

                if (
                    !data ||
                    !data.result ||
                    !data.result.token_accounts ||
                    data.result.token_accounts.length === 0
                ) {
                    console.log(
                        `No more holders found. Total pages fetched: ${page - 1}`
                    );
                    break;
                }

                console.log(
                    `Processing ${data.result.token_accounts.length} holders from page ${page}`
                );

                data.result.token_accounts.forEach((account: any) => {
                    const owner = account.owner;
                    const balance = Number.parseFloat(account.amount);

                    if (allHoldersMap.has(owner)) {
                        allHoldersMap.set(
                            owner,
                            allHoldersMap.get(owner)! + balance
                        );
                    } else {
                        allHoldersMap.set(owner, balance);
                    }
                });
                cursor = data.result.cursor;
                page++;
            }

            const holders: HolderData[] = Array.from(
                allHoldersMap.entries()
            ).map(([address, balance]) => ({
                address,
                balance: balance.toString(),
            }));

            console.log(`Total unique holders fetched: ${holders.length}`);

            if (options?.expires)
                await this.runtime.getDatabaseAdapter().setCache<HolderData[]>(
                    `helius/token-holders/${address}`,
                    holders
                );

            return holders;
        } catch (error) {
            console.error("Error fetching holder list from Helius:", error);
            throw new Error("Failed to fetch holder list from Helius.");
        }
    }
}

type CoingeckoOptions = {
    expires?: string | CacheOptions["expires"];
};

export class CoingeckoClient {
    constructor(
        private readonly apiKey: string,
        private readonly runtime: IAgentRuntime
    ) {}

    static createFromRuntime(runtime: IAgentRuntime) {
        const apiKey = runtime.getSetting("COINGECKO_API_KEY");

        if (!apiKey) {
            throw new Error("missing COINGECKO_API_KEY");
        }

        return new CoingeckoClient(apiKey, runtime);
    }

    async request<T = any>(
        path: string,
        params?: QueryParams,
        options?: CoingeckoOptions
    ) {
        const cacheKey = ["coingecko", buildUrl(path, params)]
            .filter(Boolean)
            .join("/");

        if (options?.expires) {
            const cached = await this.runtime.getDatabaseAdapter().getCache<T>(cacheKey);
            if (cached) return cached;
        }

        console.log("fetching coingecko", {
            path,
            params,
        });

        const res = await http.get.json<T>(
            `https://api.coingecko.com/api/v3/${path}`,
            params,
            {
                headers: {
                    "x-cg-demo-api-key": this.apiKey,
                },
            }
        );

        if (options?.expires) {
            await this.runtime.getDatabaseAdapter().setCache<T>(cacheKey, res);
        }

        return res;
    }

    async fetchPrices(options?: CoingeckoOptions): Promise<Prices> {
        const prices = await this.request<Prices>(
            "simple/price",
            {
                ids: "solana,bitcoin,ethereum",
                vs_currencies: "usd",
            },
            options
        );

        return prices;
    }

    async fetchGlobal() {
        return this.request(
            "global",
            {},
            {
                expires: "30m",
            }
        );
    }

    async fetchCategories() {
        return this.request(
            "coins/categories",
            {},
            {
                expires: "30m",
            }
        );
    }
}

type WalletTokenListItem = {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    balance: number;
    uiAmount: number;
    chainId: string;
    logoURI: string;
    priceUsd: number;
    valueUsd: number;
};

type WalletTokenList = {
    wallet: string;
    totalUsd: number;
    items: WalletTokenListItem[];
};

type BirdeyeXChain = "solana" | "ethereum";

type BirdeyeClientHeaders = {
    "x-chain"?: BirdeyeXChain;
};

type BirdeyeRequestOptions = {
    chain?: BirdeyeXChain;
    expires?: string | CacheOptions["expires"];
};

export class BirdeyeClient {
    static readonly url = "https://public-api.birdeye.so/";

    static async request<T = any>(
        apiKey: string,
        path: string,
        params?: QueryParams,
        headers?: BirdeyeClientHeaders
    ): Promise<T> {
        const res = await http.get.json<{ success: boolean; data?: T }>(
            BirdeyeClient.url + path,
            params,
            {
                headers: {
                    ...headers,
                    "X-API-KEY": apiKey,
                },
            }
        );

        if (!res.success || !res.data) {
            console.error({ res });
            throw new Error(`Birdeye request failed:${path}`);
        }

        return res.data;
    }

    constructor(
        private readonly apiKey: string,
        private readonly runtime: IAgentRuntime
    ) {}

    static createFromRuntime(runtime: IAgentRuntime) {
        const apiKey = runtime.getSetting("BIRDEYE_API_KEY");

        if (!apiKey) {
            throw new Error("missing BIRDEYE_API_KEY");
        }

        return new BirdeyeClient(apiKey, runtime);
    }

    async request<T = any>(
        path: string,
        params: QueryParams,
        options?: BirdeyeRequestOptions,
        forceRefresh?: boolean
    ) {
        const cacheKey = ["birdeye", options?.chain, buildUrl(path, params)]
            .filter(Boolean)
            .join("/");

        if (options?.expires && !forceRefresh) {
            const cached = await this.runtime.getDatabaseAdapter().getCache<T>(cacheKey);
            if (cached) return cached;
        }

        console.log("fetching birdeye", {
            path,
            params,
        });

        const response = await BirdeyeClient.request<T>(
            this.apiKey,
            path,
            params,
            options?.chain
                ? {
                      "x-chain": options.chain,
                  }
                : undefined
        );

        if (options?.expires) {
            await this.runtime.getDatabaseAdapter().setCache<T>(cacheKey, response);
        }

        return response;
    }

    async fetchPrice(
        address: string,
        options?: BirdeyeRequestOptions
    ): Promise<number> {
        const price = await this.request<{ value: number }>(
            "defi/price",
            { address },
            options
        );

        return price.value;
    }

    async fetchPrices(): Promise<Prices> {
        const prices = await this.request<Record<string, { value: number }>>(
            "defi/multi_price",
            { list_address: [SOL_ADDRESS, ETH_ADDRESS, BTC_ADDRESS].join(",") },
            {
                chain: "solana",
                expires: "5m",
            }
        );

        return {
            bitcoin: { usd: prices[BTC_ADDRESS].value.toString() },
            ethereum: { usd: prices[ETH_ADDRESS].value.toString() },
            solana: { usd: prices[SOL_ADDRESS].value.toString() },
        };
    }

    async fetchTokenOverview(
        address: string,
        options?: BirdeyeRequestOptions,
        forceRefresh = false
    ): Promise<TokenOverview> {
        const token = await this.request<TokenOverview>(
            "defi/token_overview",
            { address },
            options,
            forceRefresh
        );

        return token;
    }

    async fetchTokenSecurity(
        address: string,
        options?: BirdeyeRequestOptions
    ): Promise<TokenSecurityData> {
        const security = await this.request<TokenSecurityData>(
            "defi/token_security",
            { address },
            options
        );

        return security;
    }

    async fetchTokenTradeData(
        address: string,
        options?: BirdeyeRequestOptions
    ): Promise<TokenTradeData> {
        const tradeData = await this.request<TokenTradeData>(
            "defi/v3/token/trade-data/single",
            { address },
            options
        );

        return tradeData;
    }

    async fetchWalletTokenList(
        address: string,
        options?: BirdeyeRequestOptions
    ) {
        const tokenList = await this.request<WalletTokenList>(
            "v1/wallet/token_list",
            { wallet: address },
            options
        );

        return tokenList;
    }

    async fetchPortfolioValue(
        address: string,
        options?: BirdeyeRequestOptions
    ): Promise<WalletPortfolio> {
        try {
            const portfolio: WalletPortfolio = {
                totalUsd: "0",
                totalSol: "0",
                items: [],
            };

            const tokenList = await this.fetchWalletTokenList(address, options);

            const totalUsd = new BigNumber(tokenList.totalUsd.toString());

            const solPriceInUSD = new BigNumber(
                await this.fetchPrice(SOL_ADDRESS)
            );

            const items: WalletPortfolioItem[] = tokenList.items.map(
                (item) => ({
                    address: item.address,
                    name: item.name || "Unknown",
                    symbol: item.symbol || "Unknown",
                    decimals: item.decimals,
                    valueSol: new BigNumber(item.valueUsd || 0)
                        .div(solPriceInUSD)
                        .toFixed(6),
                    priceUsd: item.priceUsd?.toString() || "0",
                    valueUsd: item.valueUsd?.toString() || "0",
                    uiAmount: item.uiAmount?.toString() || "0",
                    balance: item.balance?.toString() || "0",
                })
            );

            const totalSol = totalUsd.div(solPriceInUSD);
            portfolio.totalUsd = totalUsd.toString();
            portfolio.totalSol = totalSol.toFixed(6);
            portfolio.items = items.sort((a, b) =>
                new BigNumber(b.valueUsd)
                    .minus(new BigNumber(a.valueUsd))
                    .toNumber()
            );

            return portfolio;
        } catch (error) {
            console.error("Error fetching portfolio:", error);
            throw error;
        }
    }
}

// todo: maybe move this into the cacheManager
const units = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
};

function parseTimeToMs(timeStr: string) {
    const match = timeStr.match(/^(\d+)([a-z]+)$/i);
    if (!match) return 0;

    const [_, value, unit] = match;
    return units[unit.toLowerCase()] * Number.parseInt(value);
}

function parseExpires(expires: string | number) {
    return typeof expires === "string" ? parseTimeToMs(expires) : expires;
}