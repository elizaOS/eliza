// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup

import {
  type RouteSpec,
  resolveCloudRoute,
  toRuntimeSettings,
} from "@elizaos/cloud-routing";
import {
  type IAgentRuntime,
  type ServiceTypeName,
  Service,
} from "@elizaos/core";
import Birdeye from "./birdeye-task";
import { BIRDEYE_ENDPOINTS, BIRDEYE_SERVICE_NAME } from "./constants";
import { searchBirdeyeTokens } from "./search-category";
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

// Cache defaults for backwards compatibility
const CACHE_DEFAULTS = {
  // Token trade data cache (30 minutes)
  TOKEN_TRADE_DATA_TTL: 30 * 60 * 1000,
  // Token security data cache (30 minutes)
  TOKEN_SECURITY_DATA_TTL: 30 * 60 * 1000,
};

// 'solana' | 'base' | 'ethereum'
type Chain = string;

type CacheWrapper<T> = {
  data: T;
  setAt: number;
};
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

  private async fetchBirdeyeJson(
    path: string,
    params: Record<string, unknown> = {},
    options: { headers?: Record<string, string> } = {},
  ) {
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
    return response.json();
  }

  async fetchSearchTokenMarketData(params: Record<string, unknown>) {
    const chain = typeof params.chain === "string" ? params.chain : "solana";
    return this.fetchBirdeyeJson(
      BIRDEYE_ENDPOINTS.search.token_market,
      params,
      {
        headers: { "x-chain": chain },
      },
    );
  }

  async fetchTokenOverview(
    params: Record<string, unknown>,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchBirdeyeJson(
      BIRDEYE_ENDPOINTS.token.overview,
      params,
      options,
    );
  }

  async fetchTokenMarketData(
    params: Record<string, unknown>,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchBirdeyeJson(
      BIRDEYE_ENDPOINTS.token.market_data,
      params,
      options,
    );
  }

  async fetchTokenSecurityByAddress(
    params: Record<string, unknown>,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchBirdeyeJson(
      BIRDEYE_ENDPOINTS.token.security,
      params,
      options,
    );
  }

  async fetchTokenTradeDataSingle(
    params: Record<string, unknown>,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchBirdeyeJson(
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

  // definitely should take a list of chains
  async getTrending() {
    //console.log('birdeye needs to get trending data');
    return this.runtime.getCache<IToken[]>(`tokens_solana`);
  }

  private async getTrendingTokensForChain(
    chain: Chain,
    options?: { notOlderThan?: number; total?: number },
  ): Promise<CacheWrapper<IToken[]>> {
    // Validate chain using extractChain
    let validatedChain: BirdeyeSupportedChain;
    try {
      validatedChain = extractChain(undefined, chain);
    } catch (error) {
      this.runtime.logger?.warn(
        `getTrendingTokensForChain: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { data: [], setAt: Date.now() };
    }

    // Don't allow 'evm' as a trending chain (it's just a placeholder)
    if (validatedChain === "evm") {
      this.runtime.logger?.warn(
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
    // Build all offset requests inline (no inner function)
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
      const key = t.address?.toLowerCase?.() || `${t.chain}:${t.rank}`;
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
      this.runtime.logger?.warn(
        `setCache failed for ${chain}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return output;
  }

  // options.depth 5
  // options.notOlderThanMsecs
  async getTrendingTokens(
    chains: Chain[],
    options?: { notOlderThan?: number },
  ): Promise<Record<Chain, IToken[]>> {
    try {
      const results = await Promise.all(
        chains.map((chain) => this.getTrendingTokensForChain(chain, options)),
      );

      // key output per chain - unwrap CacheWrapper to get IToken[] arrays
      const out: Record<string, IToken[]> = {};
      for (const i in chains) {
        const c = chains[i];
        out[c] = results[i].data; // Extract data from CacheWrapper<IToken[]>
      }

      return out;
    } catch (error) {
      this.runtime.logger?.error(
        `Failed to sync trending tokens: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  // FIXME: add chain param
  async getTokenMarketData(tokenAddress: string): Promise<
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
          this.getBirdeyeFetchOptions(),
        ),
        fetch(
          `${this.birdeyeUrl("defi/price_volume/single")}?address=${tokenAddress}&type=24h`,
          this.getBirdeyeFetchOptions(),
        ),
        fetch(
          `${this.birdeyeUrl("defi/history_price")}?address=${tokenAddress}&address_type=token&type=15m`,
          this.getBirdeyeFetchOptions(),
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
        //logger.warn('getTokenMarketData - cant save result', data, 'for', tokenAddress);
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
      //this.runtime.logger.error({ error },'Error fetching token market data:');
      return false;
    }
  }

  // we can do singles

  // Token - Market Data (Multiple) max 20 (BUSINESS $700/mo)
  // https://public-api.birdeye.so/defi/v3/token/market-data/multiple
  // liq,price,supply, circulating,fdv,mcap

  // Token - Trade Data (Multiple) max 20 (BUSINESS $700/mo)
  // https://public-api.birdeye.so/defi/v3/token/trade-data/multiple
  // has a lot of data

  /*
  async getTokensTradeData(chain: string, tokenAddresses: string[]): Promise<any> {
    const tokenDb: Record<string, any> = {};
    const chunkArray = (arr: string[], size: number) =>
      arr.map((_, i) => (i % size === 0 ? arr.slice(i, i + size) : null)).filter(Boolean);
    const twenties = chunkArray(tokenAddresses, 20);
    const multipricePs = twenties.map((addresses) => {
      const listStr = addresses.join(',');
      return fetch(
        `${this.birdeyeUrl('defi/v3/token/trade-data/multiple')}`,
        this.getBirdeyeFetchOptions('solana')
      );
    });
  }
  */

  // https://public-api.birdeye.so/defi/token_overview might be a better target
  // what does this provide? 24h volume
  async getTokenTradeData(
    chain: string,
    tokenAddress: string,
    frames = "2h,8h,24h",
    options: GetCacheTimedOptions = {},
  ): Promise<unknown> {
    const key = `birdeye_tokenTradeData_${chain}_${tokenAddress}_${frames}`;
    const tsInMs = options.tsInMs ?? CACHE_DEFAULTS.TOKEN_TRADE_DATA_TTL;
    const notOlderThan =
      options.notOlderThan ?? CACHE_DEFAULTS.TOKEN_TRADE_DATA_TTL;

    // Check cache
    const cached = await this.getCacheTimed<unknown>(key, { notOlderThan });
    if (cached) {
      return cached;
    }

    // Fetch fresh data
    try {
      const resp = await fetch(
        `${this.birdeyeUrl("defi/v3/token/trade-data/single")}?address=${tokenAddress}&frames=${frames}`,
        this.getBirdeyeFetchOptions(chain),
      );
      const data = await resp.json();
      if (data) {
        this.setCacheTimed(key, data, tsInMs);
      }
      return data;
    } catch (e) {
      this.runtime.logger?.error(
        `birdeye:getTokenTradeData - ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
  }

  // [Defi] Price Volume - Multi max 50 (premium $200/mo)
  // https://public-api.birdeye.so/defi/price_volume/multi
  // getting 500s
  /*
  async getTokensPriceVolume(tokenAddresses: string[], type = '24h'): Promise<any> {
    const tokenDb: Record<string, any> = {};
    const chunkArray = (arr: string[], size: number) =>
      arr.map((_, i) => (i % size === 0 ? arr.slice(i, i + size) : null)).filter(Boolean);
    const fities = chunkArray(tokenAddresses, 50);
    this.runtime.logger?.debug(`getTokensPriceVolume - batches: ${fities.length}`);

    // not sure we want to do this with rate limits...
    const multipricePs = fities.map((addresses) => {
      const listStr = addresses.join(',');
      this.runtime.logger?.debug(`getTokensPriceVolume - batch addresses: ${listStr}`);
      return fetch(
        `${this.birdeyeUrl('defi/price_volume/multi')}?list_address=${listStr}&type=${type}`,
        {...this.getBirdeyeFetchOptions('solana'), method: 'POST' }
      );
    });
    const multipriceResps = await Promise.all(multipricePs); // wait for the requests to finish
    const multipriceData = await Promise.all(
      multipriceResps.map(async (resp) => {
        if (!resp.ok) {
          const text = await resp.text();
          this.runtime.logger?.error(`API error: ${resp.status} - ${text}`);
          return undefined;
        }
        return resp.json();
      })
    );

    for (const mpd of multipriceData) {
      this.runtime.logger?.debug('getTokensPriceVolume - response:', mpd);
    }
  }
  */

  // [Defi] Price - Multiple max 100 (all)
  // https://public-api.birdeye.so/defi/multi_price
  // Batch CU Cost = N^0.8 × 5 (base cost of a single call) (n_max: 100)
  // FIXME: caching
  async getTokensMarketData(
    chain: string,
    tokenAddresses: string[],
  ): Promise<Record<string, IToken | undefined>> {
    const tokenDb: Record<string, IToken | undefined> = {};

    // Initialize all token addresses as undefined so we know they were checked
    for (const ca of tokenAddresses) {
      tokenDb[ca] = undefined;
    }

    //console.log('beSrv:getTokensMarketData chain', chain, 'tokenAddresses', tokenAddresses)

    // no real cache because pricing
    // 1-60s cache might have some benefits tho
    // usually called only once every sell signal (1m atm)

    try {
      const chunkArray = (arr: string[], size: number) =>
        arr
          .map((_, i) => (i % size === 0 ? arr.slice(i, i + size) : null))
          .filter(Boolean);

      const hundos = chunkArray(tokenAddresses, 100);
      //console.log('getTokensMarketData hundos', hundos)

      // Track batches with their addresses for cache management
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
        multipriceResps.map((resp) => resp.json()),
      );

      //const now = Date.now()

      for (let i = 0; i < multipriceData.length; i++) {
        const mpd = multipriceData[i];
        const batchAddresses = batchesWithAddresses[i].addresses;

        // Guard against undefined/null mpd or missing data
        if (!mpd?.data || !mpd.success) {
          this.runtime.logger?.warn(
            `birdeye:getTokensMarketData - batch failed (${batchAddresses.length} addresses), caching all as failed`,
          );

          // Cache all addresses in this failed batch
          for (const ca of batchAddresses) {
            await this.runtime.setCache(`birdeye_tokens_solana_${ca}`, {
              data: undefined,
              setAt: Date.now(),
              ttl: 5 * 60 * 1000, // 5 minutes for failed batch lookups
            });
          }
          continue;
        }

        // Process data from successful batch
        for (const ca of batchAddresses) {
          const t = mpd.data[ca];

          if (t) {
            /*
            t {
              isScaledUiToken: false,
              value: 0.011726789622156722,
              updateUnixTime: 1751591014,
              updateHumanTime: "2025-07-04T01:03:34",
              priceInNative: 0.00007683147650766234,
              priceChange24h: -12.453478899440487,
              liquidity: 1323844.6216610295,
            }
            */
            tokenDb[ca] = {
              //provider: 'birdeye',
              //chain: 'solana',
              //address: ca,
              priceUsd: t.value,
              priceSol: t.priceInNative,
              liquidity: t.liquidity,
              priceChange24h: t.priceChange24h,
              //marketcap
              //volume24hUSD
            };
            const test: IToken = tokenDb[ca];
            this.runtime.logger?.debug(
              `birdeye:getTokensMarketData - caching token ${ca}`,
            );
            // Cache successful lookups with full TTL
            await this.runtime.setCache<IToken>(
              `birdeye_tokens_solana_${ca}`,
              test,
            );
          } else {
            // Token was in batch but has no valid data (or not in response)
            this.runtime.logger?.warn(
              `${ca} no valid data in response: ${JSON.stringify(t)}`,
            );
            // Cache failed lookups with shorter TTL to avoid re-fetching bad addresses
            await this.runtime.setCache(`birdeye_tokens_solana_${ca}`, {
              data: undefined,
              setAt: Date.now(),
              ttl: 5 * 60 * 1000, // 5 minutes for failed lookups
            });
          }
        }
      }

      return tokenDb;
    } catch (error) {
      this.runtime.logger.error(
        `Error fetching multiple tokens market data: ${error instanceof Error ? error.message : String(error)}`,
      );
      //this.runtime.logger.error({ error }, 'Error fetching multiple tokens market data:', error);
      return tokenDb;
    }
  }

  // Token - Security (single) all
  // https://public-api.birdeye.so/defi/token_security
  async getTokenSecurityData(
    chain: string,
    tokenAddress: string,
    options: GetCacheTimedOptions = {},
  ): Promise<unknown> {
    const key = `birdeye_tokenSecurityData_${chain}_${tokenAddress}`;
    const tsInMs = options.tsInMs ?? CACHE_DEFAULTS.TOKEN_SECURITY_DATA_TTL;
    const notOlderThan =
      options.notOlderThan ?? CACHE_DEFAULTS.TOKEN_SECURITY_DATA_TTL;

    // Check cache
    const cached = await this.getCacheTimed<unknown>(key, { notOlderThan });
    if (cached) {
      return cached;
    }

    // Fetch fresh data
    try {
      const resp = await fetch(
        `${this.birdeyeUrl("defi/token_security")}?address=${tokenAddress}`,
        this.getBirdeyeFetchOptions(chain),
      );
      const data = await resp.json();
      if (data) {
        this.setCacheTimed(key, data, tsInMs);
      }
      return data;
    } catch (e) {
      this.runtime.logger?.error(
        `birdeye:getTokenSecurityData - ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
  }

  /*
  async getToken(chain, ca) {
    console.log('birdeye:srv getToken', chain, ca)
    return getTokenMarketData(ca)
  }
  */

  // lookup token
  async lookupToken(
    chain: string,
    ca: string,
    options: GetCacheTimedOptions = {},
  ) {
    try {
      const key = `birdeye_token_${chain}_${ca}`;
      const tsInMs = options.tsInMs ?? Date.now(); // only syscall if absolutely needed
      const notOlderThan = options.notOlderThan ?? 30 * 1000; // a reasonable length (in ms)

      // check cache
      const cache = await this.getCacheTimed<unknown>(key, { notOlderThan });
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
      this.runtime.logger?.error(
        `birdeyeSvr:lookupToken - err: ${e instanceof Error ? e.message : String(e)}`,
      );
      throw e;
    }
  }

  async lookupTokens(
    chainAndAddresses: Array<{ chain: string; address: string }>,
    options: GetCacheTimedOptions = {},
  ) {
    try {
      // Lookup all tokens in parallel
      const results = await Promise.all(
        chainAndAddresses.map((cAA) =>
          this.lookupToken(cAA.chain, cAA.address, options),
        ),
      );

      // Transform results into keyed object: key = `${chain}_${address}`
      const keyedResults: Record<string, unknown> = {};
      chainAndAddresses.forEach((cAA, index) => {
        const key = `${cAA.chain}_${cAA.address}`;
        keyedResults[key] = results[index];
      });

      return keyedResults;
    } catch (e) {
      this.runtime.logger?.error(
        `birdeyeSvr:lookupTokens - err: ${e instanceof Error ? e.message : String(e)}`,
      );
      throw e;
    }
  }

  async fetchSearchTokenMarketDataChain(
    chain: string,
    _params: unknown,
    _options: GetCacheTimedOptions = {},
  ) {
    const birdeyeFetchOptions: RequestInit = this.getBirdeyeFetchOptions(chain);
    const res = await fetch(
      `${this.birdeyeUrl("defi/v3/search")}`,
      birdeyeFetchOptions,
    );
    const resp = await res.json();
    this.runtime.logger.log("resp", resp);
    return resp;
  }

  async lookupSymbolAllChains(
    symbol: string,
    options: GetCacheTimedOptions = {},
  ) {
    // set up cache
    const key = `birdeye_symbol_${symbol}`;
    const tsInMs = options.tsInMs ?? Date.now();
    const notOlderThan = options.notOlderThan ?? 30 * 1000;

    // check cache
    const cache = await this.getCacheTimed<unknown>(key, { notOlderThan });
    if (cache) {
      return cache;
    }

    const birdeyeFetchOptions: RequestInit =
      this.getBirdeyeFetchOptions("solana");
    const res = await fetch(
      `${this.birdeyeUrl("defi/v3/search")}?chain=all&target=token&keyword=${encodeURIComponent(symbol)}`,
      birdeyeFetchOptions,
    );
    const resp = await res.json();
    const data = resp.data.items;
    if (data) {
      this.setCacheTimed(key, data, tsInMs);
    }
    return data;
  }

  async fetchWalletTokenList(
    chain: BirdeyeSupportedChain,
    publicKey: string,
    options: GetCacheTimedOptions = {},
  ) {
    // Get entire portfolio
    // set up cache
    const key = `birdeye_walletTokenList_${chain}_${publicKey}`;
    const tsInMs = options.tsInMs ?? Date.now();
    const notOlderThan = options.notOlderThan ?? 30 * 1000;

    // check cache
    const cache = await this.getCacheTimed<unknown>(key, { notOlderThan });
    if (cache) {
      return cache;
    }
    // get data
    const birdeyeFetchOptions: RequestInit = this.getBirdeyeFetchOptions(chain);
    const res = await fetch(
      `${this.birdeyeUrl("v1/wallet/token_list")}?wallet=${publicKey}`,
      birdeyeFetchOptions,
    );

    const resp = await res.json();
    const data = resp?.data;
    if (data) {
      this.setCacheTimed(key, data, tsInMs);
    }
    return data;
  }

  async fetchWalletTxList(
    chain: BirdeyeSupportedChain,
    publicKey: string,
    options: GetCacheTimedOptions = {},
  ) {
    // set up cache
    const key = `birdeye_walletTxList_${chain}_${publicKey}`;
    const tsInMs = options.tsInMs ?? Date.now();
    const notOlderThan = options.notOlderThan ?? 30 * 1000;

    // check cache
    const cache = await this.getCacheTimed<unknown>(key, { notOlderThan });
    if (cache) {
      return cache;
    }
    // get data
    const birdeyeFetchOptions: RequestInit = this.getBirdeyeFetchOptions(chain);
    const res = await fetch(
      `${this.birdeyeUrl("v1/wallet/tx_list")}?wallet=${publicKey}&limit=100`,
      birdeyeFetchOptions,
    );
    const resp = await res.json();
    const data = resp?.data?.[chain] || [];
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
            validate: async () => true,
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
    // both services have loaded.
    Promise.all(
      ["INTEL_DATAPROVIDER", BIRDEYE_SERVICE_NAME].map((p) =>
        runtime.getServiceLoadPromise(p as ServiceTypeName),
      ),
    )
      .then(() => {
        const infoService = runtime.getService("INTEL_DATAPROVIDER") as
          | { registerDataProvder?: (provider: unknown) => void }
          | undefined;

        if (!infoService) {
          runtime.logger?.warn(
            "INTEL_DATAPROVIDER service not available, skipping data provider registration",
          );
          return;
        }

        if (typeof infoService.registerDataProvder !== "function") {
          runtime.logger?.warn(
            "INTEL_DATAPROVIDER service does not have registerDataProvder method",
          );
          return;
        }

        try {
          infoService.registerDataProvder({
            name: "Birdeye",
            trendingService: BIRDEYE_SERVICE_NAME,
            lookupService: BIRDEYE_SERVICE_NAME,
          });
          runtime.logger?.log(
            "Birdeye data provider registered with INTEL_DATAPROVIDER",
          );
        } catch (error) {
          runtime.logger?.error(
            `Failed to register Birdeye data provider: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })
      .catch((e) => {
        runtime.logger?.error(
          `Failed to load services for data provider registration: ${e instanceof Error ? e.message : String(e)}`,
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
    this.runtime.logger?.log("BirdEye service shutdown");
  }

  async getCacheTimed<T>(key: string, options: GetCacheTimedOptions = {}) {
    const wrapper = await this.runtime.getCache<CacheWrapper<T>>(key);
    if (!wrapper) return false;
    if (options.notOlderThan) {
      const now = options.tsInMs ?? Date.now();
      const diff = now - wrapper.setAt;
      //console.log('checking notOlderThan', diff + 'ms', 'setAt', wrapper.setAt, 'asking', options.notOlderThan)
      if (diff > options.notOlderThan) {
        // no data
        return false;
      }
    }
    // return data
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
