// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import { elizaLogger } from "@elizaos/core";
import {
  API_BASE_URL,
  BIRDEYE_ENDPOINTS,
  DEFAULT_MAX_RETRIES,
  RETRY_DELAY_MS,
} from "./constants";
import type { BirdeyeApiParams, BirdeyeApiResponse } from "./types/api/common";
import type {
  BaseQuoteParams,
  BaseQuoteResponse,
  DefiHistoryPriceParams,
  DefiHistoryPriceResponse,
  DefiMultiPriceParams,
  DefiMultiPriceParamsPOST,
  DefiMultiPriceResponse,
  DefiNetworksResponse,
  DefiPriceParams,
  DefiPriceResponse,
  DefiTradesTokenParams,
  DefiTradesTokenResponse,
  HistoricalPriceUnixParams,
  HistoricalPriceUnixResponse,
  MultiPriceVolumeParams,
  MultiPriceVolumeResponse,
  OHLCVParams,
  OHLCVResponse,
  PriceVolumeParams,
  PriceVolumeResponse,
} from "./types/api/defi";
import type {
  OHLCVPairParams,
  OHLCVPairResponse,
  PairOverviewMultiParams,
  PairOverviewMultiResponse,
  PairOverviewSingleParams,
  PairOverviewSingleResponse,
} from "./types/api/pair";
import type {
  TokenMarketSearchParams,
  TokenMarketSearchResponse,
} from "./types/api/search";
import type {
  AllMarketsParams,
  AllMarketsResponse,
  MintBurnParams,
  MintBurnResponse,
  NewListingParams,
  NewListingResponse,
  TokenCreationInfoParams,
  TokenCreationInfoResponse,
  TokenHoldersParams,
  TokenHoldersResponse,
  TokenListParams,
  TokenListResponse,
  TokenListV2Response,
  TokenMarketDataParams,
  TokenMarketDataResponse,
  TokenMetadataMultiParams,
  TokenMetadataMultiResponse,
  TokenMetadataSingleParams,
  TokenMetadataSingleResponse,
  TokenOverviewParams,
  TokenOverviewResponse,
  TokenSecurityParams,
  TokenSecurityResponse,
  TokenTradeDataMultiParams,
  TokenTradeDataMultiResponse,
  TokenTradeDataSingleParams,
  TokenTradeDataSingleResponse,
  TokenTrendingParams,
  TokenTrendingResponse,
  TopTradersParams,
  TopTradersResponse,
} from "./types/api/token";
import type {
  GainersLosersParams,
  GainersLosersResponse,
  TraderTransactionsSeekParams,
  TraderTransactionsSeekResponse,
} from "./types/api/trader";
import type {
  WalletPortfolioParams,
  WalletPortfolioResponse,
  WalletSimulationParams,
  WalletSimulationResponse,
  WalletTokenBalanceParams,
  WalletTokenBalanceResponse,
  WalletTransactionHistoryParams,
  WalletTransactionHistoryResponse,
} from "./types/api/wallet";
import { convertToStringParams, waitFor } from "./utils";

type FetchParams<T> = T & {
  headers?: Record<string, string>;
};

// emulate settings from 0.x
const settings = process.env;

/*
class BaseCachedProvider {
    private cache: NodeCache;

    constructor(
        private cacheManager: ICacheManager,
        private cacheKey,
        ttl?: number
    ) {
        this.runtime = runtime
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
*/

// Custom error class for HTTP errors to distinguish from network errors
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

// extends BaseCachedProvider
// really more like a service
export class BirdeyeProvider {
  private runtime: unknown;
  private maxRetries: number;

  constructor(
    runtime,
    //cacheManager: ICacheManager,
    _symbolMap?: Record<string, string>,
    maxRetries?: number,
  ) {
    // super(cacheManager, "birdeye/data")
    this.runtime = runtime;
    this.maxRetries = maxRetries || DEFAULT_MAX_RETRIES;
  }

  /*
   * COMMON FETCH FUNCTIONS
   */
  private async fetchWithRetry<T extends BirdeyeApiResponse>(
    url: string,
    options: RequestInit = {},
  ): Promise<T> {
    let attempts = 0;

    // allow the user to override the chain
    const chain =
      options.headers?.["x-chain"] || settings.BIRDEYE_CHAIN || "solana";

    while (attempts < this.maxRetries) {
      attempts++;
      try {
        const resp = await fetch(url, {
          ...options,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "x-chain": chain,
            "X-API-KEY": settings.BIRDEYE_API_KEY || "",
            ...options.headers,
          },
        });

        if (!resp.ok) {
          const errorText = await resp.text();
          const error = new HttpError(
            resp.status,
            `HTTP error! status: ${resp.status}, message: ${errorText}`,
          );

          // Only retry on transient errors
          const isRetryable =
            resp.status >= 500 || // 5xx server errors
            resp.status === 429 || // Rate limit
            resp.status === 408 || // Request timeout
            resp.status === 503; // Service unavailable

          if (!isRetryable || attempts === this.maxRetries) {
            throw error;
          }

          // Wait before retry for transient errors
          await waitFor(RETRY_DELAY_MS);
          continue;
        }

        const rawData = await resp.json();
        // If the response already has data and success fields, return it
        if (rawData.data !== undefined && rawData.success !== undefined) {
          return rawData as T;
        }
        // Otherwise wrap the response in the expected format
        return {
          data: rawData,
          success: true,
        } as T;
      } catch (error) {
        // Check if this is an HTTP error (already handled status code logic above)
        if (error instanceof HttpError) {
          // HTTP errors are only retried if isRetryable was true (handled above)
          // If we're here, it means it wasn't retryable, so throw
          throw error;
        }

        // Network errors (fetch failures before getting a response) are retryable
        // This includes: connection failures, DNS errors, timeouts, etc.
        if (attempts === this.maxRetries) {
          // Out of retry attempts
          throw error;
        }

        // Retry network errors
        await waitFor(RETRY_DELAY_MS);
      }
    }
    // Fallback in case loop completes without returning (shouldn't happen)
    throw new Error(`Failed to fetch after ${this.maxRetries} attempts`);
  }

  private async fetchWithCacheAndRetry<T extends BirdeyeApiResponse>({
    url,
    params,
    headers,
    method = "GET",
  }: {
    url: string;
    params?: BirdeyeApiParams;
    headers?: Record<string, string>;
    method?: "GET" | "POST";
  }): Promise<T> {
    const stringParams = params ? convertToStringParams(params) : {};
    const fullUrl = `${API_BASE_URL}${url}`;
    const cacheKey =
      method === "GET"
        ? `${url}?${new URLSearchParams(stringParams)}`
        : `${url}:${JSON.stringify(params)}`;

    // Check cache first
    const cachedVal = await this.runtime.getCache(cacheKey);
    if (cachedVal) return cachedVal as T;

    const urlWithParams =
      method === "GET" && params
        ? `${fullUrl}?${new URLSearchParams(stringParams)}`
        : fullUrl;

    elizaLogger.info(`Birdeye fetch: ${urlWithParams}`);

    const data = await this.fetchWithRetry<T>(urlWithParams, {
      method,
      headers,
      ...(method === "POST" && params && { body: JSON.stringify(params) }),
    });

    await this.runtime.setCache(cacheKey, data);
    return data as T;
  }

  /*
   * DEFI FETCH FUNCTIONS
   */

  // Get a list of all supported networks.
  public async fetchDefiSupportedNetworks() {
    return this.fetchWithCacheAndRetry<DefiNetworksResponse>({
      url: BIRDEYE_ENDPOINTS.defi.networks,
    });
  }

  // Get price update of a token.
  public async fetchDefiPrice(
    params: DefiPriceParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<DefiPriceResponse>({
      url: BIRDEYE_ENDPOINTS.defi.price,
      params,
      headers: options.headers,
    });
  }

  // Get price updates of multiple tokens in a single API call. Maximum 100 tokens
  public async fetchDefiPriceMultiple(
    params: DefiMultiPriceParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<DefiMultiPriceResponse>({
      url: BIRDEYE_ENDPOINTS.defi.price_multi,
      params,
      headers: options.headers,
    });
  }

  // Get price updates of multiple tokens in a single API call. Maximum 100 tokens
  public async fetchDefiPriceMultiple_POST(
    params: DefiMultiPriceParamsPOST,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<DefiMultiPriceResponse>({
      url: BIRDEYE_ENDPOINTS.defi.price_multi_POST,
      params,
      headers: options.headers,
      method: "POST",
    });
  }

  // Get historical price line chart of a token.
  public async fetchDefiPriceHistorical(
    params: DefiHistoryPriceParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<DefiHistoryPriceResponse>({
      url: BIRDEYE_ENDPOINTS.defi.history_price,
      params,
      headers: options.headers,
    });
  }

  // Get historical price by unix timestamp
  public async fetchDefiPriceHistoricalByUnixTime(
    params: HistoricalPriceUnixParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<HistoricalPriceUnixResponse>({
      url: BIRDEYE_ENDPOINTS.defi.historical_price_unix,
      params,
      headers: options.headers,
    });
  }

  // Get list of trades of a certain token.
  public async fetchDefiTradesToken(
    params: DefiTradesTokenParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<DefiTradesTokenResponse>({
      url: BIRDEYE_ENDPOINTS.defi.trades_token,
      params,
      headers: options.headers,
    });
  }

  // Get list of trades of a certain pair or market.
  public async fetchDefiTradesPair(
    params: DefiTradesTokenParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<DefiTradesTokenResponse>({
      url: BIRDEYE_ENDPOINTS.defi.trades_token,
      params,
      headers: options.headers,
    });
  }

  // Get list of trades of a token with time bound option.
  public async fetchDefiTradesTokenSeekByTime(
    params: DefiTradesTokenParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<DefiTradesTokenResponse>({
      url: BIRDEYE_ENDPOINTS.defi.trades_token_seek,
      params,
      headers: options.headers,
    });
  }

  // Get list of trades of a certain pair or market with time bound option.
  public async fetchDefiTradesPairSeekByTime(
    params: DefiTradesTokenParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<DefiTradesTokenResponse>({
      url: BIRDEYE_ENDPOINTS.defi.trades_pair_seek,
      params,
      headers: options.headers,
    });
  }

  // Get OHLCV price of a token.
  public async fetchDefiOHLCV(
    params: OHLCVParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<OHLCVResponse>({
      url: BIRDEYE_ENDPOINTS.defi.ohlcv,
      params,
      headers: options.headers,
    });
  }

  // Get OHLCV price of a pair.
  public async fetchDefiOHLCVPair(
    params: OHLCVPairParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<OHLCVPairResponse>({
      url: BIRDEYE_ENDPOINTS.defi.ohlcv_pair,
      params,
      headers: options.headers,
    });
  }

  // Get OHLCV price of a base-quote pair.
  public async fetchDefiOHLCVBaseQuote(
    params: BaseQuoteParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<BaseQuoteResponse>({
      url: BIRDEYE_ENDPOINTS.defi.ohlcv_base_quote,
      params,
      headers: options.headers,
    });
  }

  // Get price and volume of a token.
  public async fetchDefiPriceVolume(
    params: PriceVolumeParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<PriceVolumeResponse>({
      url: BIRDEYE_ENDPOINTS.defi.price_volume,
      params,
      headers: options.headers,
    });
  }

  // Get price and volume updates of maximum 50 tokens
  public async fetchDefiPriceVolumeMulti_POST(
    params: MultiPriceVolumeParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<MultiPriceVolumeResponse>({
      url: BIRDEYE_ENDPOINTS.defi.price_volume_multi_POST,
      params,
      headers: options.headers,
      method: "POST",
    });
  }

  /*
   * TOKEN FETCH FUNCTIONS
   */

  // Get token list of any supported chains.
  public async fetchTokenList(
    params: TokenListParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<TokenListResponse>({
      url: BIRDEYE_ENDPOINTS.token.list_all,
      params,
      headers: options.headers,
    });
  }

  // Get token security of any supported chains.
  public async fetchTokenSecurityByAddress(
    params: TokenSecurityParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<TokenSecurityResponse>({
      url: BIRDEYE_ENDPOINTS.token.security,
      params,
      headers: options.headers,
    });
  }

  // Get overview of a token.
  public async fetchTokenOverview(
    params: TokenOverviewParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<TokenOverviewResponse>({
      url: BIRDEYE_ENDPOINTS.token.overview,
      params,
      headers: options.headers,
    });
  }

  // Get creation info of token
  public async fetchTokenCreationInfo(
    params: TokenCreationInfoParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<TokenCreationInfoResponse>({
      url: BIRDEYE_ENDPOINTS.token.creation_info,
      params,
      headers: options.headers,
    });
  }

  // Retrieve a dynamic and up-to-date list of trending tokens based on specified sorting criteria.
  public async fetchTokenTrending(
    params?: TokenTrendingParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<TokenTrendingResponse>({
      url: BIRDEYE_ENDPOINTS.token.trending,
      params,
      headers: options.headers,
    });
  }

  // This endpoint facilitates the retrieval of a list of tokens on a specified blockchain network. This upgraded version is exclusive to business and enterprise packages. By simply including the header for the requested blockchain without any query parameters, business and enterprise users can get the full list of tokens on the specified blockchain in the URL returned in the response. This removes the need for the limit response of the previous version and reduces the workload of making multiple calls.
  public async fetchTokenListV2_POST(
    params: FetchParams<Record<string, never>>,
  ) {
    return this.fetchWithCacheAndRetry<TokenListV2Response>({
      url: BIRDEYE_ENDPOINTS.token.list_all_v2_POST,
      params,
      headers: params.headers,
      method: "POST",
    });
  }

  // Get newly listed tokens of any supported chains.
  public async fetchTokenNewListing(
    params?: NewListingParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<NewListingResponse>({
      url: BIRDEYE_ENDPOINTS.token.new_listing,
      params,
      headers: options?.headers,
    });
  }

  // Get top traders of given token.
  public async fetchTokenTopTraders(
    params: TopTradersParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<TopTradersResponse>({
      url: BIRDEYE_ENDPOINTS.token.top_traders,
      params,
      headers: options.headers,
    });
  }

  // The API provides detailed information about the markets for a specific cryptocurrency token on a specified blockchain. Users can retrieve data for one or multiple markets related to a single token. This endpoint requires the specification of a token address and the blockchain to filter results. Additionally, it supports optional query parameters such as offset, limit, and required sorting by liquidity or sort type (ascending or descending) to refine the output.
  public async fetchTokenAllMarketsList(
    params: AllMarketsParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<AllMarketsResponse>({
      url: BIRDEYE_ENDPOINTS.token.all_markets,
      params,
      headers: options.headers,
    });
  }

  // Get metadata of single token
  public async fetchTokenMetadataSingle(
    params: TokenMetadataSingleParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<TokenMetadataSingleResponse>({
      url: BIRDEYE_ENDPOINTS.token.metadata_single,
      params,
      headers: options.headers,
    });
  }

  // Get metadata of multiple tokens
  public async fetchTokenMetadataMulti(
    params: TokenMetadataMultiParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<TokenMetadataMultiResponse>({
      url: BIRDEYE_ENDPOINTS.token.metadata_multi,
      params,
      headers: options.headers,
    });
  }

  // Get market data of single token
  public async fetchTokenMarketData(
    params: TokenMarketDataParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<TokenMarketDataResponse>({
      url: BIRDEYE_ENDPOINTS.token.market_data,
      params,
      headers: options.headers,
    });
  }

  // Get trade data of single token
  public async fetchTokenTradeDataSingle(
    params: TokenTradeDataSingleParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<TokenTradeDataSingleResponse>({
      url: BIRDEYE_ENDPOINTS.token.trade_data_single,
      params,
      headers: options.headers,
    });
  }

  // Get trade data of multiple tokens
  public async fetchTokenTradeDataMultiple(
    params: TokenTradeDataMultiParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<TokenTradeDataMultiResponse>({
      url: BIRDEYE_ENDPOINTS.token.trade_data_multi,
      params,
      headers: options.headers,
    });
  }

  // Get top holder list of the given token
  public async fetchTokenHolders(
    params: TokenHoldersParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<TokenHoldersResponse>({
      url: BIRDEYE_ENDPOINTS.token.holders,
      params,
      headers: options.headers,
    });
  }

  // Get mint/burn transaction list of the given token. Only support solana currently
  public async fetchTokenMintBurn(
    params: MintBurnParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<MintBurnResponse>({
      url: BIRDEYE_ENDPOINTS.token.mint_burn,
      params,
      headers: options.headers,
    });
  }

  /*
   * WALLET FETCH FUNCTIONS
   */
  public async fetchWalletSupportedNetworks(
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<DefiNetworksResponse>({
      url: BIRDEYE_ENDPOINTS.defi.networks,
      headers: options.headers,
    });
  }

  public async fetchWalletPortfolio(
    params: WalletPortfolioParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<WalletPortfolioResponse>({
      url: BIRDEYE_ENDPOINTS.wallet.portfolio,
      params,
      headers: options.headers,
    });
  }

  public async fetchWalletTokenBalance(
    params: WalletTokenBalanceParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<WalletTokenBalanceResponse>({
      url: BIRDEYE_ENDPOINTS.wallet.token_balance,
      params,
      headers: options.headers,
    });
  }

  public async fetchWalletTransactionHistory(
    params: WalletTransactionHistoryParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<WalletTransactionHistoryResponse>({
      url: BIRDEYE_ENDPOINTS.wallet.transaction_history,
      params,
      headers: options.headers,
    });
  }

  public async fetchWalletTransactionSimulate_POST(
    params: WalletSimulationParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<WalletSimulationResponse>({
      url: BIRDEYE_ENDPOINTS.wallet.transaction_simulation_POST,
      params,
      headers: options.headers,
      method: "POST",
    });
  }

  /*
   * TRADER FETCH FUNCTIONS
   */

  // The API provides detailed information top gainers/losers
  public async fetchTraderGainersLosers(
    params: GainersLosersParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<GainersLosersResponse>({
      url: BIRDEYE_ENDPOINTS.trader.gainers_losers,
      params,
      headers: options.headers,
    });
  }

  // Get list of trades of a trader with time bound option.
  public async fetchTraderTransactionsSeek(
    params: TraderTransactionsSeekParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<TraderTransactionsSeekResponse>({
      url: BIRDEYE_ENDPOINTS.trader.trades_seek,
      params,
      headers: options.headers,
    });
  }

  /*
   * PAIR FETCH FUNCTIONS
   */
  public async fetchPairOverviewSingle(
    params: PairOverviewSingleParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<PairOverviewSingleResponse>({
      url: BIRDEYE_ENDPOINTS.pair.overview_single,
      params,
      headers: options.headers,
    });
  }

  // Get overview of multiple pairs
  public async fetchMultiPairOverview(
    params: PairOverviewMultiParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<PairOverviewMultiResponse>({
      url: BIRDEYE_ENDPOINTS.pair.overview_multi,
      params,
      headers: options.headers,
    });
  }

  public async fetchPairOverviewMultiple(
    params: PairOverviewMultiParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<PairOverviewMultiResponse>({
      url: BIRDEYE_ENDPOINTS.pair.overview_multi,
      params,
      headers: options.headers,
    });
  }

  /*
   * SEARCH FETCH FUNCTIONS
   */
  public async fetchSearchTokenMarketData(
    params: TokenMarketSearchParams,
    options: { headers?: Record<string, string> } = {},
  ) {
    return this.fetchWithCacheAndRetry<TokenMarketSearchResponse>({
      url: BIRDEYE_ENDPOINTS.search.token_market,
      params,
      headers: options.headers,
    });
  }
}
