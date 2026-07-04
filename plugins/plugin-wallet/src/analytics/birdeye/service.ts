/**
 * `BirdeyeService` — the registered Birdeye client service (`serviceType:
 * "birdeye"`). Wraps direct Birdeye REST calls (trending tokens, market data,
 * security, token search, wallet portfolio/tx history) behind
 * `resolveCloudRoute`, so requests use a local `BIRDEYE_API_KEY` or fall back
 * to the Eliza Cloud `/apis/birdeye` proxy. Most lookups are cached via
 * `runtime.getCache`/`setCache` with per-method TTLs (see `CACHE_DEFAULTS`),
 * and `getTokensMarketData` batches uncached addresses into groups of 100 to
 * respect Birdeye's multi-price endpoint limit. `start` also registers a
 * recurring `BIRDEYE_SYNC_WALLET` task when `BIRDEYE_WALLET_ADDR` is set, and
 * opportunistically registers Birdeye with `INTEL_DATAPROVIDER` if present.
 */
import {
  type RouteSpec,
  resolveCloudRoute,
  toRuntimeSettings,
} from "@elizaos/cloud-routing";
import {
  type IAgentRuntime,
  Service,
  type ServiceTypeName,
} from "@elizaos/core";
import Birdeye from "./birdeye-task";
import { BIRDEYE_ENDPOINTS, BIRDEYE_SERVICE_NAME } from "./constants";
import { searchBirdeyeTokens } from "./search-category";
import type { DefiMultiPriceResponse } from "./types/api/defi";
import type {
  TokenMarketSearchParams,
  TokenMarketSearchResponse,
} from "./types/api/search";
import type {
  TokenMarketDataParams,
  TokenMarketDataResponse,
  TokenOverviewParams,
  TokenOverviewResponse,
  TokenSecurityParams,
  TokenSecurityResponse,
  TokenTradeDataSingleParams,
  TokenTradeDataSingleResponse,
} from "./types/api/token";
import type {
  WalletPortfolioResponse,
  WalletTransactionHistoryResponse,
} from "./types/api/wallet";
import type {
  BirdeyeSupportedChain,
  GetCacheTimedOptions,
  IToken,
} from "./types/shared";
import { convertToStringParams, extractChain } from "./utils";

/** Route spec for {@link resolveCloudRoute} — local X-API-KEY or Eliza Cloud `/apis/birdeye` proxy. */
export const BIRDEYE_ROUTE_SPEC: RouteSpec = {
  service: "birdeye",
  localKeySetting: "BIRDEYE_API_KEY",
  upstreamBaseUrl: "https://public-api.birdeye.so",
  localKeyAuth: { kind: "header", headerName: "X-API-KEY" },
};

const CACHE_DEFAULTS = {
  TOKEN_TRADE_DATA_TTL: 30 * 60 * 1000,
  TOKEN_SECURITY_DATA_TTL: 30 * 60 * 1000,
  TOKEN_MARKET_DATA_TTL: 30 * 1000,
};

/** A Birdeye chain identifier, e.g. `"solana"` | `"base"` | `"ethereum"`. */
type Chain = string;

type CacheWrapper<T> = {
  data: T;
  setAt: number;
};

type BirdeyeHeaders = { headers?: Record<string, string> };

type BirdeyeMultiPriceItem = NonNullable<
  DefiMultiPriceResponse["data"][string]
> & {
  priceInNative?: number;
  liquidity?: number;
  market_cap?: number;
  marketcap?: number;
  mc?: number;
  realMc?: number;
};

type BirdeyeMultiPriceResponse = Omit<DefiMultiPriceResponse, "data"> & {
  data: Record<string, BirdeyeMultiPriceItem | undefined>;
};

export interface BirdeyeTokenMarketSnapshot {
  symbol?: string;
  priceUsd: number;
  priceSol?: number;
  liquidity: number;
  priceChange24h: number;
  marketCapUsd?: number;
}

type WalletTransaction =
  WalletTransactionHistoryResponse["data"][string][number];

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
}

export class BirdeyeService extends Service {
  static serviceType: string = BIRDEYE_SERVICE_NAME;
  capabilityDescription = "BirdEye data access";

  private readonly access: { baseUrl: string; headers: Record<string, string> };

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (!this.runtime) {
      throw new Error("BirdeyeService requires a runtime");
    }
    const route = resolveCloudRoute(
      toRuntimeSettings(this.runtime),
      BIRDEYE_ROUTE_SPEC,
    );
    if (route.source === "disabled") {
      throw new Error(
        "BirdeyeService requires BIRDEYE_API_KEY or Eliza Cloud (ELIZAOS_CLOUD_API_KEY + ELIZAOS_CLOUD_ENABLED).",
      );
    }
    this.access = {
      baseUrl: route.baseUrl.replace(/\/+$/, ""),
      headers: route.headers,
    };
  }

  private birdeyeUrl(path: string): string {
    const suffix = path.replace(/^\/+/, "");
    return `${this.access.baseUrl}/${suffix}`;
  }

  private getBirdeyeFetchOptions(chain = "solana"): RequestInit {
    return {
      headers: {
        accept: "application/json",
        "x-chain": chain,
        ...this.access.headers,
      },
    };
  }

  private async fetchBirdeyeJson<T>(
    path: string,
    params: object = {},
    options: { headers?: Record<string, string> } = {},
  ): Promise<T> {
    const chain = options.headers?.["x-chain"] ?? "solana";
    const cleanParams = Object.fromEntries(
      Object.entries(params).filter(([, value]) => value !== undefined),
    );
    const query = new URLSearchParams(
      convertToStringParams(cleanParams),
    ).toString();
    const suffix = query ? `${path}?${query}` : path;
    const fetchOptions = this.getBirdeyeFetchOptions(chain);
    const response = await fetch(this.birdeyeUrl(suffix), {
      ...fetchOptions,
      headers: {
        ...(fetchOptions.headers as Record<string, string>),
        ...(options.headers ?? {}),
      },
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Birdeye API error ${response.status}: ${errorText || response.statusText}`,
      );
    }
    return response.json() as Promise<T>;
  }

  async fetchSearchTokenMarketData(
    params: TokenMarketSearchParams,
  ): Promise<TokenMarketSearchResponse> {
    const chain = typeof params.chain === "string" ? params.chain : "solana";
    return this.fetchBirdeyeJson<TokenMarketSearchResponse>(
      BIRDEYE_ENDPOINTS.search.token_market,
      params,
      {
        headers: { "x-chain": chain },
      },
    );
  }

  async fetchTokenOverview(
    params: TokenOverviewParams,
    options: BirdeyeHeaders = {},
  ): Promise<TokenOverviewResponse> {
    return this.fetchBirdeyeJson<TokenOverviewResponse>(
      BIRDEYE_ENDPOINTS.token.overview,
      params,
      options,
    );
  }

  async fetchTokenMarketData(
    params: TokenMarketDataParams,
    options: BirdeyeHeaders = {},
  ): Promise<TokenMarketDataResponse> {
    return this.fetchBirdeyeJson<TokenMarketDataResponse>(
      BIRDEYE_ENDPOINTS.token.market_data,
      params,
      options,
    );
  }

  async fetchTokenSecurityByAddress(
    params: TokenSecurityParams,
    options: BirdeyeHeaders = {},
  ): Promise<TokenSecurityResponse> {
    return this.fetchBirdeyeJson<TokenSecurityResponse>(
      BIRDEYE_ENDPOINTS.token.security,
      params,
      options,
    );
  }

  async fetchTokenTradeDataSingle(
    params: TokenTradeDataSingleParams,
    options: BirdeyeHeaders = {},
  ): Promise<TokenTradeDataSingleResponse> {
    return this.fetchBirdeyeJson<TokenTradeDataSingleResponse>(
      BIRDEYE_ENDPOINTS.token.trade_data_single,
      params,
      options,
    );
  }

  async search(query: string, options: Record<string, unknown> = {}) {
    return searchBirdeyeTokens(
      this.runtime,
      {
        query,
        mode: options.mode as "auto" | "symbol" | "address" | undefined,
        filters: options,
        limit: typeof options.limit === "number" ? options.limit : undefined,
      },
      this,
    );
  }

  /** Solana-only trending cache read; use `getTrendingTokens` for other chains. */
  async getTrending() {
    return this.runtime.getCache<IToken[]>(`tokens_solana`);
  }

  private async getTrendingTokensForChain(
    chain: Chain,
    options?: { notOlderThan?: number; total?: number },
  ): Promise<CacheWrapper<IToken[]>> {
    let validatedChain: BirdeyeSupportedChain;
    try {
      validatedChain = extractChain(undefined, chain);
    } catch (error) {
      this.runtime.logger.warn(
        `getTrendingTokensForChain: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { data: [], setAt: Date.now() };
    }

    // Don't allow 'evm' as a trending chain; callers must choose a concrete chain.
    if (validatedChain === "evm") {
      this.runtime.logger.warn(
        `getTrendingTokensForChain: 'evm' is not a specific chain. Use ethereum, arbitrum, polygon, etc.`,
      );
      return { data: [], setAt: Date.now() };
    }

    const cacheKey = `tokens_v2_${validatedChain}`;
    const wrapper =
      await this.runtime.getCache<CacheWrapper<IToken[]>>(cacheKey);

    const freshEnough =
      !!wrapper &&
      (!options?.notOlderThan ||
        Date.now() - wrapper.setAt <= options.notOlderThan);

    if (freshEnough) {
      this.runtime.logger.debug(
        `birdyeSrv::getTrendingTokensForChain(${chain}) HIT`,
      );
      return wrapper;
    }
    this.runtime.logger.debug(
      `birdyeSrv::getTrendingTokensForChain(${chain}) MISS`,
    );

    const BATCH_SIZE = 20; // max birdeye allows
    const TOTAL = options?.total ?? 100;
    const OFFSETS = Array.from(
      { length: TOTAL / BATCH_SIZE },
      (_, i) => i * BATCH_SIZE,
    );

    const birdeyeFetchOptions: RequestInit = this.getBirdeyeFetchOptions(chain);
    const settled = await Promise.allSettled(
      OFFSETS.map(async (offset) => {
        const res = await fetch(
          `${this.birdeyeUrl("defi/token_trending")}?sort_by=rank&sort_type=asc&offset=${offset}&limit=${BATCH_SIZE}`,
          birdeyeFetchOptions,
        );
        const resp = await res.json();
        const data = resp?.data;

        if (!data?.tokens?.length) return [] as IToken[];

        const last_updated = new Date((data.updateUnixTime ?? 0) * 1000);

        interface RawBirdeyeToken {
          address: string;
          decimals?: number;
          liquidity?: number;
          logoURI?: string;
          name?: string;
          symbol: string;
          volume24hUSD?: number;
          rank?: number;
          price?: number;
          price24hChangePercent?: number;
        }
        return (data.tokens as RawBirdeyeToken[]).map((token) => ({
          address: token.address,
          chain,
          provider: "birdeye",
          decimals: token.decimals || 0,
          liquidity: token.liquidity || 0,
          logoURI: token.logoURI || "",
          name: token.name || token.symbol,
          symbol: token.symbol,
          marketcap: 0,
          volume24hUSD: token.volume24hUSD || 0,
          rank: token.rank || 0,
          price: token.price || 0,
          price24hChangePercent: token.price24hChangePercent || 0,
          last_updated,
        })) as IToken[];
      }),
    );

    const fetched = settled
      .filter(
        (r): r is PromiseFulfilledResult<IToken[]> => r.status === "fulfilled",
      )
      .flatMap((r) => r.value);

    const byKey = new Map<string, IToken>();
    for (const t of fetched) {
      const key = t.address.toLowerCase() || `${t.chain}:${t.rank}`;
      if (!byKey.has(key)) {
        byKey.set(key, t);
      }
    }
    const merged = Array.from(byKey.values());

    // Save to cache (ignore cache errors; don’t block the return path)
    const output = { data: merged, setAt: Date.now() };
    try {
      await this.runtime.setCache<CacheWrapper<IToken[]>>(cacheKey, output);
    } catch (e) {
      this.runtime.logger.warn(
        `setCache failed for ${chain}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return output;
  }

  async getTrendingTokens(
    chains: Chain[],
    options?: { notOlderThan?: number },
  ): Promise<Record<Chain, IToken[]>> {
    try {
      const results = await Promise.all(
        chains.map((chain) => this.getTrendingTokensForChain(chain, options)),
      );

      const out: Record<string, IToken[]> = {};
      for (const i in chains) {
        const c = chains[i];
        out[c] = results[i].data;
      }

      return out;
    } catch (error) {
      this.runtime.logger.error(
        `Failed to sync trending tokens: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  async getTokenMarketData(
    tokenAddress: string,
    chain = "solana",
  ): Promise<
    | {
        price: number;
        marketCap: number;
        liquidity: number;
        volume24h: number;
        priceHistory: number[];
      }
    | false
  > {
    try {
      if (tokenAddress === "So11111111111111111111111111111111111111111") {
        tokenAddress = "So11111111111111111111111111111111111111112"; // WSOL
      }

      const [response, volResponse, priceHistoryResponse] = await Promise.all([
        fetch(
          `${this.birdeyeUrl("defi/v3/token/market-data")}?address=${tokenAddress}`,
          this.getBirdeyeFetchOptions(chain),
        ),
        fetch(
          `${this.birdeyeUrl("defi/price_volume/single")}?address=${tokenAddress}&type=24h`,
          this.getBirdeyeFetchOptions(chain),
        ),
        fetch(
          `${this.birdeyeUrl("defi/history_price")}?address=${tokenAddress}&address_type=token&type=15m`,
          this.getBirdeyeFetchOptions(chain),
        ),
      ]);

      if (!response.ok || !volResponse.ok || !priceHistoryResponse.ok) {
        throw new Error(`Birdeye API error for token ${tokenAddress}`);
      }

      const [data, volData, priceHistoryData] = await Promise.all([
        response.json(),
        volResponse.json(),
        priceHistoryResponse.json(),
      ]);

      if (!data.data) {
        this.runtime.logger.warn(
          `getTokenMarketData - cant save result for ${tokenAddress}: ${JSON.stringify(data)}`,
        );
        return false;
      }

      return {
        price: data.data.price,
        marketCap: data.data.market_cap || 0,
        liquidity: data.data.liquidity || 0,
        volume24h: volData.data.volumeUSD || 0,
        priceHistory: priceHistoryData.data.items.map(
          (item: { value: number }) => item.value,
        ),
      };
    } catch (error) {
      this.runtime.logger.error(
        `Error fetching token market data: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  async getTokenTradeData(
    chain: string,
    tokenAddress: string,
    frames = "2h,8h,24h",
    options: GetCacheTimedOptions = {},
  ): Promise<TokenTradeDataSingleResponse | false> {
    const key = `birdeye_tokenTradeData_${chain}_${tokenAddress}_${frames}`;
    const tsInMs = options.tsInMs ?? CACHE_DEFAULTS.TOKEN_TRADE_DATA_TTL;
    const notOlderThan =
      options.notOlderThan ?? CACHE_DEFAULTS.TOKEN_TRADE_DATA_TTL;

    const cached = await this.getCacheTimed<TokenTradeDataSingleResponse>(key, {
      notOlderThan,
    });
    if (cached) {
      return cached;
    }

    try {
      const resp = await fetch(
        `${this.birdeyeUrl("defi/v3/token/trade-data/single")}?address=${tokenAddress}&frames=${frames}`,
        this.getBirdeyeFetchOptions(chain),
      );
      const data = (await resp.json()) as TokenTradeDataSingleResponse;
      if (data) {
        this.setCacheTimed(key, data, tsInMs);
      }
      return data;
    } catch (e) {
      this.runtime.logger.error(
        `birdeye:getTokenTradeData - ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
  }

  /**
   * Fetches `[Defi] Price - Multiple` (`defi/multi_price`, max 100 addresses
   * per call; Batch CU cost = N^0.8 × 5). Uncached addresses are chunked into
   * batches of 100; a failed batch caches every address in it as `undefined`
   * data rather than leaving them uncached.
   */
  async getTokensMarketData(
    chain: string,
    tokenAddresses: string[],
    options: GetCacheTimedOptions = {},
  ): Promise<Record<string, BirdeyeTokenMarketSnapshot | undefined>> {
    const tokenDb: Record<string, BirdeyeTokenMarketSnapshot | undefined> = {};
    const notOlderThan =
      options.notOlderThan ?? CACHE_DEFAULTS.TOKEN_MARKET_DATA_TTL;
    const tsInMs = options.tsInMs ?? Date.now();
    const cacheKeyFor = (address: string) =>
      `birdeye_tokens_${chain}_${address}`;

    // Initialize all token addresses as undefined so we know they were checked
    for (const ca of tokenAddresses) {
      tokenDb[ca] = undefined;
    }

    try {
      const cacheEntries = await Promise.all(
        tokenAddresses.map(async (address) => {
          const wrapper = await this.runtime.getCache<
            CacheWrapper<BirdeyeTokenMarketSnapshot | undefined>
          >(cacheKeyFor(address));
          if (!wrapper) {
            return { address, cached: false, data: undefined };
          }
          const isFresh = Date.now() - wrapper.setAt <= notOlderThan;
          return {
            address,
            cached: isFresh,
            data: isFresh ? wrapper.data : undefined,
          };
        }),
      );

      const uncachedAddresses: string[] = [];
      for (const entry of cacheEntries) {
        if (entry.cached) {
          tokenDb[entry.address] = entry.data;
        } else {
          uncachedAddresses.push(entry.address);
        }
      }

      if (!uncachedAddresses.length) {
        return tokenDb;
      }

      const chunkArray = (arr: string[], size: number): string[][] =>
        arr
          .map((_, i) => (i % size === 0 ? arr.slice(i, i + size) : null))
          .filter((chunk): chunk is string[] => chunk !== null);

      const hundos = chunkArray(uncachedAddresses, 100);

      const batchesWithAddresses = hundos
        .map((addresses) => {
          if (addresses !== null) {
            const listStr = addresses.join(",");
            return {
              addresses,
              promise: fetch(
                `${this.birdeyeUrl("defi/multi_price")}?list_address=${listStr}&include_liquidity=true`,
                this.getBirdeyeFetchOptions(chain),
              ),
            };
          }
          return undefined;
        })
        .filter(
          (item): item is { addresses: string[]; promise: Promise<Response> } =>
            item !== undefined,
        );

      const multipriceResps = await Promise.all(
        batchesWithAddresses.map((b) => b.promise),
      );
      const multipriceData = await Promise.all(
        multipriceResps.map(
          (resp) => resp.json() as Promise<BirdeyeMultiPriceResponse>,
        ),
      );

      for (let i = 0; i < multipriceData.length; i++) {
        const mpd = multipriceData[i];
        const batchAddresses = batchesWithAddresses[i].addresses;

        if (!mpd?.data || !mpd.success) {
          this.runtime.logger.warn(
            `birdeye:getTokensMarketData - batch failed (${batchAddresses.length} addresses), caching all as failed`,
          );

          for (const ca of batchAddresses) {
            await this.runtime.setCache<
              CacheWrapper<BirdeyeTokenMarketSnapshot | undefined>
            >(cacheKeyFor(ca), {
              data: undefined,
              setAt: tsInMs,
            });
          }
          continue;
        }

        for (const ca of batchAddresses) {
          const t = mpd.data[ca];

          if (t && typeof t.value === "number") {
            const marketSnapshot: BirdeyeTokenMarketSnapshot = {
              priceUsd: t.value,
              priceSol: t.priceInNative,
              liquidity: t.liquidity ?? 0,
              priceChange24h: t.priceChange24h ?? 0,
              marketCapUsd: firstFiniteNumber(
                t.market_cap,
                t.marketcap,
                t.mc,
                t.realMc,
              ),
            };
            tokenDb[ca] = marketSnapshot;
            this.runtime.logger.debug(
              `birdeye:getTokensMarketData - caching token ${ca}`,
            );
            // Cache successful lookups with full TTL
            await this.runtime.setCache<
              CacheWrapper<BirdeyeTokenMarketSnapshot>
            >(cacheKeyFor(ca), {
              data: marketSnapshot,
              setAt: tsInMs,
            });
          } else {
            this.runtime.logger.warn(
              `${ca} no valid data in response: ${JSON.stringify(t)}`,
            );
            await this.runtime.setCache<
              CacheWrapper<BirdeyeTokenMarketSnapshot | undefined>
            >(cacheKeyFor(ca), {
              data: undefined,
              setAt: tsInMs,
            });
          }
        }
      }

      return tokenDb;
    } catch (error) {
      this.runtime.logger.error(
        `Error fetching multiple tokens market data: ${error instanceof Error ? error.message : String(error)}`,
      );
      return tokenDb;
    }
  }

  async getTokenSecurityData(
    chain: string,
    tokenAddress: string,
    options: GetCacheTimedOptions = {},
  ): Promise<TokenSecurityResponse | false> {
    const key = `birdeye_tokenSecurityData_${chain}_${tokenAddress}`;
    const tsInMs = options.tsInMs ?? CACHE_DEFAULTS.TOKEN_SECURITY_DATA_TTL;
    const notOlderThan =
      options.notOlderThan ?? CACHE_DEFAULTS.TOKEN_SECURITY_DATA_TTL;

    const cached = await this.getCacheTimed<TokenSecurityResponse>(key, {
      notOlderThan,
    });
    if (cached) {
      return cached;
    }

    try {
      const resp = await fetch(
        `${this.birdeyeUrl("defi/token_security")}?address=${tokenAddress}`,
        this.getBirdeyeFetchOptions(chain),
      );
      const data = (await resp.json()) as TokenSecurityResponse;
      if (data) {
        this.setCacheTimed(key, data, tsInMs);
      }
      return data;
    } catch (e) {
      this.runtime.logger.error(
        `birdeye:getTokenSecurityData - ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
  }

  async lookupToken(
    chain: string,
    ca: string,
    options: GetCacheTimedOptions = {},
  ): Promise<BirdeyeTokenMarketSnapshot | undefined> {
    try {
      const key = `birdeye_token_${chain}_${ca}`;
      const tsInMs = options.tsInMs ?? Date.now(); // only syscall if absolutely needed
      const notOlderThan = options.notOlderThan ?? 30 * 1000;

      const cache = await this.getCacheTimed<BirdeyeTokenMarketSnapshot>(key, {
        notOlderThan,
      });
      if (cache) {
        this.runtime.logger.debug("birdeye:lookupToken - HIT");
        return cache;
      }
      this.runtime.logger.debug("birdeye:lookupToken - MISS");

      const res = await this.getTokensMarketData(chain, [ca]);
      const data = res[ca];
      if (data) {
        this.setCacheTimed(key, data, tsInMs);
      }

      return data;
    } catch (e) {
      this.runtime.logger.error(
        `birdeyeSvr:lookupToken - err: ${e instanceof Error ? e.message : String(e)}`,
      );
      throw e;
    }
  }

  async lookupTokens(
    chainAndAddresses: Array<{ chain: string; address: string }>,
    options: GetCacheTimedOptions = {},
  ): Promise<Record<string, BirdeyeTokenMarketSnapshot | undefined>> {
    try {
      const results = await Promise.all(
        chainAndAddresses.map((cAA) =>
          this.lookupToken(cAA.chain, cAA.address, options),
        ),
      );

      // Keyed by `${chain}_${address}`.
      const keyedResults: Record<
        string,
        BirdeyeTokenMarketSnapshot | undefined
      > = {};
      chainAndAddresses.forEach((cAA, index) => {
        const key = `${cAA.chain}_${cAA.address}`;
        keyedResults[key] = results[index];
      });

      return keyedResults;
    } catch (e) {
      this.runtime.logger.error(
        `birdeyeSvr:lookupTokens - err: ${e instanceof Error ? e.message : String(e)}`,
      );
      throw e;
    }
  }

  async fetchSearchTokenMarketDataChain(
    chain: string,
    _params: unknown,
    _options: GetCacheTimedOptions = {},
  ): Promise<TokenMarketSearchResponse> {
    const birdeyeFetchOptions: RequestInit = this.getBirdeyeFetchOptions(chain);
    const res = await fetch(
      `${this.birdeyeUrl("defi/v3/search")}`,
      birdeyeFetchOptions,
    );
    const resp = (await res.json()) as TokenMarketSearchResponse;
    this.runtime.logger.log("resp", JSON.stringify(resp));
    return resp;
  }

  async lookupSymbolAllChains(
    symbol: string,
    options: GetCacheTimedOptions = {},
  ): Promise<TokenMarketSearchResponse["data"]["items"] | false> {
    const key = `birdeye_symbol_${symbol}`;
    const tsInMs = options.tsInMs ?? Date.now();
    const notOlderThan = options.notOlderThan ?? 30 * 1000;

    const cache = await this.getCacheTimed<
      TokenMarketSearchResponse["data"]["items"]
    >(key, { notOlderThan });
    if (cache) {
      return cache;
    }

    const birdeyeFetchOptions: RequestInit =
      this.getBirdeyeFetchOptions("solana");
    const res = await fetch(
      `${this.birdeyeUrl("defi/v3/search")}?chain=all&target=token&keyword=${encodeURIComponent(symbol)}`,
      birdeyeFetchOptions,
    );
    const resp = (await res.json()) as TokenMarketSearchResponse;
    const data = resp.data.items;
    if (data) {
      this.setCacheTimed(key, data, tsInMs);
    }
    return data;
  }

  /** Fetches the wallet's entire token portfolio. */
  async fetchWalletTokenList(
    chain: BirdeyeSupportedChain,
    publicKey: string,
    options: GetCacheTimedOptions = {},
  ): Promise<WalletPortfolioResponse["data"] | false> {
    const key = `birdeye_walletTokenList_${chain}_${publicKey}`;
    const tsInMs = options.tsInMs ?? Date.now();
    const notOlderThan = options.notOlderThan ?? 30 * 1000;

    const cache = await this.getCacheTimed<WalletPortfolioResponse["data"]>(
      key,
      { notOlderThan },
    );
    if (cache) {
      return cache;
    }
    const birdeyeFetchOptions: RequestInit = this.getBirdeyeFetchOptions(chain);
    const res = await fetch(
      `${this.birdeyeUrl("v1/wallet/token_list")}?wallet=${publicKey}`,
      birdeyeFetchOptions,
    );

    const resp = (await res.json()) as WalletPortfolioResponse;
    const data = resp.data;
    if (data) {
      this.setCacheTimed(key, data, tsInMs);
    }
    return data;
  }

  async fetchWalletTxList(
    chain: BirdeyeSupportedChain,
    publicKey: string,
    options: GetCacheTimedOptions = {},
  ): Promise<WalletTransaction[] | false> {
    const key = `birdeye_walletTxList_${chain}_${publicKey}`;
    const tsInMs = options.tsInMs ?? Date.now();
    const notOlderThan = options.notOlderThan ?? 30 * 1000;

    const cache = await this.getCacheTimed<WalletTransaction[]>(key, {
      notOlderThan,
    });
    if (cache) {
      return cache;
    }
    const birdeyeFetchOptions: RequestInit = this.getBirdeyeFetchOptions(chain);
    const res = await fetch(
      `${this.birdeyeUrl("v1/wallet/tx_list")}?wallet=${publicKey}&limit=100`,
      birdeyeFetchOptions,
    );
    const resp = (await res.json()) as WalletTransactionHistoryResponse;
    const data = resp.data[chain] || [];
    if (data) {
      this.setCacheTimed(key, data, tsInMs);
    }
    return data;
  }

  static async start(runtime: IAgentRuntime): Promise<BirdeyeService> {
    runtime.logger.log("Initializing Birdeye Service");
    const birdEyeService = new BirdeyeService(runtime);

    // Clean any stale recurring birdeye tasks left over from previous runs.
    runtime.initPromise
      .then(async () => {
        const tasks = await runtime.getTasks({
          tags: ["queue", "repeat", "plugin_birdeye"],
          agentIds: [runtime.agentId],
        });
        for (const task of tasks) {
          if (task.id) {
            await runtime.deleteTask(task.id);
          }
        }

        // Register the BIRDEYE_SYNC_WALLET task worker + recurring task
        // when the agent owns a tracked wallet address.
        const walletAddr = runtime.getSetting("BIRDEYE_WALLET_ADDR");
        if (walletAddr) {
          const birdeye = new Birdeye(runtime);
          runtime.registerTaskWorker({
            name: "BIRDEYE_SYNC_WALLET",
            shouldRun: async () => true,
            execute: async (rt) => {
              try {
                await birdeye.syncWallet();
              } catch (error) {
                rt.logger.error(
                  `Failed to sync trending tokens: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
              return undefined;
            },
          });

          await runtime.createTask({
            name: "BIRDEYE_SYNC_WALLET",
            description: "Sync wallet from Birdeye",
            worldId: runtime.agentId,
            metadata: {
              createdAt: new Date().toISOString(),
              updatedAt: Date.now(),
              updateInterval: 1000 * 60 * 5, // 5 minutes
            },
            tags: ["queue", "repeat", "plugin_birdeye", "immediate"],
          });
          runtime.logger.log("birdeye init - tasks registered");
        }
      })
      .catch((error) => {
        runtime.logger.error(
          `birdeye task setup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

    // Register Birdeye as a data provider with INTEL_DATAPROVIDER once
    // Birdeye is loaded. INTEL_DATAPROVIDER is optional — probe it
    // synchronously and skip registration if it's not present.
    runtime
      .getServiceLoadPromise(BIRDEYE_SERVICE_NAME as ServiceTypeName)
      .then(() => {
        const infoService = runtime.getService("INTEL_DATAPROVIDER") as
          | { registerDataProvder?: (provider: unknown) => void }
          | undefined;

        if (
          !infoService ||
          typeof infoService.registerDataProvder !== "function"
        ) {
          runtime.logger.debug(
            "INTEL_DATAPROVIDER service not available, skipping Birdeye data provider registration",
          );
          return;
        }

        infoService.registerDataProvder({
          name: "Birdeye",
          trendingService: BIRDEYE_SERVICE_NAME,
          lookupService: BIRDEYE_SERVICE_NAME,
        });
        runtime.logger.log(
          "Birdeye data provider registered with INTEL_DATAPROVIDER",
        );
      })
      .catch((e) => {
        runtime.logger.debug(
          `Birdeye service load failed; skipping data provider registration: ${e instanceof Error ? e.message : String(e)}`,
        );
      });

    runtime.logger.log("Birdeye service initialized");
    return birdEyeService;
  }

  static async stop(runtime: IAgentRuntime) {
    const service = runtime.getService(BIRDEYE_SERVICE_NAME);
    if (!service) {
      runtime.logger.error("Birdeye not found");
      return;
    }
    await service.stop();
  }

  async stop(): Promise<void> {
    this.runtime.logger.log("BirdEye service shutdown");
  }

  async getCacheTimed<T>(key: string, options: GetCacheTimedOptions = {}) {
    const wrapper = await this.runtime.getCache<CacheWrapper<T>>(key);
    if (!wrapper) return false;
    if (options.notOlderThan) {
      const now = options.tsInMs ?? Date.now();
      const diff = now - wrapper.setAt;
      if (diff > options.notOlderThan) {
        return false;
      }
    }
    return wrapper.data;
  }

  async setCacheTimed<T>(key: string, val: T, tsInMs = 0) {
    if (tsInMs === 0) tsInMs = Date.now();
    return this.runtime.setCache<CacheWrapper<T>>(key, {
      setAt: tsInMs,
      data: val,
    });
  }
}
