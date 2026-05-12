import { logger } from "@/lib/utils/logger";
import { getProxyConfig } from "../config";
import { retryFetch } from "../fetch";
import { getServiceMethodCost } from "../pricing";
import type { ServiceConfig, ServiceHandler } from "../types";

/**
 * Market Data Service Handler
 *
 * WHY provider abstraction:
 * - Routes never mention "Birdeye" - they use generic methods like "getPrice"
 * - This map is the ONLY place that knows about Birdeye's API structure
 * - Swapping providers = update this map + getProxyConfig().MARKET_DATA_BASE_URL
 * - Example: Switching to CoinGecko just changes paths here, routes unchanged
 *
 * WHY this specific design:
 * - LLMs can easily add new routes without knowing provider details
 * - Testing is easier: mock at the handler level, not per-route
 * - Migrations are safer: change provider without touching 5+ route files
 */
const PROVIDER_PATHS = {
  getPrice: "/defi/price",
  getPriceHistorical: "/defi/history_price",
  getOHLCV: "/defi/ohlcv",
  getTokenOverview: "/defi/token_overview",
  getTokenSecurity: "/defi/token_security",
  getTokenMetadata: "/defi/v3/token/meta-data/single",
  getTokenTrades: "/defi/txs/token",
  getTrending: "/defi/token_trending",
  getWalletPortfolio: "/v1/wallet/token_list",
  search: "/defi/v3/search",
} as const;

export type MarketDataMethod = keyof typeof PROVIDER_PATHS;

/**
 * WHY these methods are non-cacheable:
 *
 * getTokenTrades: Real-time trade data changes every second
 *   - Caching = users see stale trades while still paying 50% cost
 *   - Better to always fetch fresh data
 *
 * getTrending: Trending tokens change rapidly (5-15 min cycles)
 *   - 30s cache would miss trend shifts
 *   - Users expect "trending now" not "trending 30s ago"
 *
 * search: User input is unique per query
 *   - Cache hit rate would be extremely low
 *   - Wasted Redis memory storing rare queries
 */
const NON_CACHEABLE_METHODS = new Set(["getTokenTrades", "getTrending", "search"]);

export interface MarketDataRequest {
  method: MarketDataMethod;
  chain: string;
  params: Record<string, string | number | boolean>;
}

/**
 * WHY apiKeyWithOrg auth:
 * - Market data is a paid feature (credits required)
 * - Must validate both API key AND org has sufficient balance
 * - Prevents unauthorized access and unpaid usage
 *
 * WHY 100 req/min rate limit:
 * - Prevents single org from monopolizing upstream provider
 * - Birdeye free tier = 150 req/min, we reserve margin for retries
 * - Can increase per-org via pricing tiers later
 *
 * WHY 30s cache TTL:
 * - Token prices change every 1-5s on active pairs
 * - 30s is stale enough to save costs but fresh enough for most use cases
 * - Users can force refresh via Cache-Control: max-age=0 header
 *
 * WHY 50% cost on cache hit:
 * - Zero cost = users abuse cache, spam requests
 * - 100% cost = no incentive to use caching properly
 * - 50% = fair split of savings between user and platform
 *
 * WHY 128KB max response size:
 * - Most market data responses are <10KB
 * - Portfolio endpoints can be 50-100KB (many tokens)
 * - 128KB covers 99% of requests without wasting Redis memory
 * - Oversized responses bypass cache, billed at full cost
 */
export const marketDataConfig: ServiceConfig = {
  id: "market-data",
  name: "Market Data",
  auth: "apiKeyWithOrg",
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 100,
  },
  cache: {
    maxTTL: 30,
    hitCostMultiplier: 0.5,
    isMethodCacheable: (method) => !NON_CACHEABLE_METHODS.has(method),
    maxResponseSize: 131_072,
  },
  getCost: async (body) => {
    const { method } = body as MarketDataRequest;
    return getServiceMethodCost("market-data", method);
  },
};

export async function executeMarketDataProviderRequest({
  method,
  chain,
  params,
}: MarketDataRequest): Promise<Response> {
  const normalizedChain = chain.toLowerCase();

  const path = PROVIDER_PATHS[method];
  if (!path) {
    throw new Error(`Unknown market data method: ${method}`);
  }

  const apiKey = process.env.MARKET_DATA_PROVIDER_API_KEY;
  if (!apiKey) {
    throw new Error("MARKET_DATA_PROVIDER_API_KEY not configured");
  }

  const queryParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    queryParams.append(key, String(value));
  }

  const url = `${getProxyConfig().MARKET_DATA_BASE_URL}${path}?${queryParams.toString()}`;

  try {
    const response = await retryFetch({
      url,
      init: {
        method: "GET",
        headers: {
          "X-API-KEY": apiKey,
          "x-chain": normalizedChain,
        },
      },
      maxRetries: getProxyConfig().MARKET_DATA_MAX_RETRIES,
      initialDelayMs: getProxyConfig().MARKET_DATA_INITIAL_RETRY_DELAY_MS,
      timeoutMs: getProxyConfig().MARKET_DATA_TIMEOUT_MS,
      serviceTag: "Market Data",
      nonRetriableStatuses: [400, 404],
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error("[Market Data] Provider error", {
        method,
        chain: normalizedChain,
        status: response.status,
        body: errorBody,
      });

      return Response.json(
        {
          error: "Market data provider error",
          code: response.status,
        },
        { status: 502 },
      );
    }

    return response;
  } catch (error) {
    logger.error("[Market Data] Request failed", {
      method,
      chain: normalizedChain,
      error: error instanceof Error ? error.message : "Unknown error",
    });

    throw error;
  }
}

export const marketDataHandler: ServiceHandler = async ({ body }) => {
  return {
    response: await executeMarketDataProviderRequest(body as MarketDataRequest),
  };
};
