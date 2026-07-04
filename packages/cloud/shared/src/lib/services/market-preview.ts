import type {
  CoinGeckoMarketRecord,
  WalletMarketOverviewResponse,
  WalletMarketOverviewSource,
  WalletMarketPrediction,
} from "@elizaos/shared";
import {
  buildCoinGeckoMarketsUrl,
  buildMarketMovers,
  buildMarketPriceSnapshots,
  COINGECKO_MARKET_PROVIDER,
  POLYMARKET_MARKET_PROVIDER,
  parseCoinGeckoMarkets,
} from "@elizaos/shared";
import { getCookieValueFromRequest } from "../http/cookie-header";
import { logger } from "../utils/logger";
import { isValidAddress, isValidChain } from "./proxy/services/address-validation";
import {
  executeMarketDataProviderRequest,
  type MarketDataMethod,
} from "./proxy/services/market-data";

const PREVIEW_FETCH_TIMEOUT_MS = 8_000;
const WALLET_OVERVIEW_CACHE_TTL_MS = 120_000;
const PREDICTIONS_CACHE_TTL_MS = 120_000;
const POLYMARKET_MARKET_LIMIT = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

export const PUBLIC_MARKET_PREVIEW_CORS_METHODS = "GET, OPTIONS";
export const PUBLIC_MARKET_OVERVIEW_CACHE_CONTROL =
  "public, max-age=60, stale-while-revalidate=180";
export const PUBLIC_MARKET_DATA_CACHE_CONTROL = "public, max-age=15, stale-while-revalidate=45";

interface PolymarketMarketRecord {
  slug: string | null;
  question: string;
  outcomeLabels: string[];
  outcomeProbabilities: number[];
  volume24hUsd: number;
  totalVolumeUsd: number | null;
  endsAt: string | null;
  imageUrl: string | null;
}

interface CachedPreview<T> {
  response: T;
  expiresAt: number;
}

export interface PublicPredictionPreviewResponse {
  generatedAt: string;
  cacheTtlSeconds: number;
  stale: boolean;
  source: WalletMarketOverviewSource;
  predictions: WalletMarketPrediction[];
}

let cachedWalletOverview: CachedPreview<WalletMarketOverviewResponse> | null = null;
let walletOverviewInFlight: Promise<WalletMarketOverviewResponse> | null = null;
let cachedPredictions: CachedPreview<PublicPredictionPreviewResponse> | null = null;
let predictionsInFlight: Promise<PublicPredictionPreviewResponse> | null = null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function clampProbability(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function buildMarketOverviewSource(
  source: Pick<WalletMarketOverviewSource, "providerId" | "providerName" | "providerUrl">,
  { available, stale, error }: Pick<WalletMarketOverviewSource, "available" | "stale" | "error">,
): WalletMarketOverviewSource {
  return {
    ...source,
    available,
    stale,
    error,
  };
}

function marketOverviewErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message.trim()
    : "Upstream market feed failed";
}

function markWalletOverviewSourcesStale(
  sources: WalletMarketOverviewResponse["sources"],
): WalletMarketOverviewResponse["sources"] {
  return {
    prices: { ...sources.prices, stale: true },
    movers: { ...sources.movers, stale: true },
    predictions: { ...sources.predictions, stale: true },
  };
}

function withCacheControl(response: Response, cacheControl: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", cacheControl);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

type PreviewIdentityInput = Request | { req: { raw: Request } };

function getPreviewRequest(input: PreviewIdentityInput): Request {
  return input instanceof Request ? input : input.req.raw;
}

function getPreviewIdentity(input: PreviewIdentityInput): string {
  const request = getPreviewRequest(input);
  const anonymousSession =
    request.headers.get("x-anonymous-session") ||
    request.headers.get("X-Anonymous-Session") ||
    getCookieValueFromRequest(request, "eliza-anon-session") ||
    null;

  if (anonymousSession) {
    return `anon:${anonymousSession}`;
  }

  const ip =
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null;

  return ip ? `ip:${ip}` : "public";
}

function createPreviewRateLimitConfig(scope: string, maxRequests: number) {
  return {
    windowMs: RATE_LIMIT_WINDOW_MS,
    maxRequests,
    keyGenerator: (input: PreviewIdentityInput) => `${scope}:${getPreviewIdentity(input)}`,
  };
}

export const PUBLIC_WALLET_OVERVIEW_RATE_LIMIT = createPreviewRateLimitConfig(
  "wallet-overview",
  20,
);
export const PUBLIC_PREDICTIONS_RATE_LIMIT = createPreviewRateLimitConfig("predictions", 20);
export const PUBLIC_MARKET_PRICE_RATE_LIMIT = createPreviewRateLimitConfig("price-preview", 30);
export const PUBLIC_MARKET_TOKEN_RATE_LIMIT = createPreviewRateLimitConfig("token-preview", 30);
export const PUBLIC_MARKET_PORTFOLIO_RATE_LIMIT = createPreviewRateLimitConfig(
  "portfolio-preview",
  20,
);

async function fetchJsonWithTimeout(url: URL, label: "CoinGecko" | "Polymarket"): Promise<unknown> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent": "Eliza Cloud Market Preview/1.0",
    },
    signal: AbortSignal.timeout(PREVIEW_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`${label} responded ${response.status}`);
  }

  return response.json();
}

function mapPolymarketMarket(input: unknown): PolymarketMarketRecord | null {
  const record = asRecord(input);
  if (!record) return null;

  const question = stringFromUnknown(record.question);
  if (!question) return null;

  const outcomeLabels = parseStringArray(record.outcomes);
  const outcomeProbabilities = parseStringArray(record.outcomePrices)
    .map((value) => clampProbability(numberFromUnknown(value)))
    .filter((value): value is number => value !== null);
  const volume24hUsd = numberFromUnknown(record.volume24hr);

  if (volume24hUsd === null) return null;

  return {
    slug: stringFromUnknown(record.slug),
    question,
    outcomeLabels,
    outcomeProbabilities,
    volume24hUsd,
    totalVolumeUsd: numberFromUnknown(record.volume),
    endsAt: stringFromUnknown(record.endDate),
    imageUrl: stringFromUnknown(record.image) ?? stringFromUnknown(record.icon),
  };
}

async function fetchCoinGeckoMarkets(): Promise<CoinGeckoMarketRecord[]> {
  const payload = await fetchJsonWithTimeout(buildCoinGeckoMarketsUrl(), "CoinGecko");
  return parseCoinGeckoMarkets(payload);
}

async function fetchPolymarketMarkets(): Promise<PolymarketMarketRecord[]> {
  const url = new URL("https://gamma-api.polymarket.com/markets");
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("order", "volume24hr");
  url.searchParams.set("ascending", "false");
  url.searchParams.set("limit", String(POLYMARKET_MARKET_LIMIT));

  const payload = await fetchJsonWithTimeout(url, "Polymarket");
  if (!Array.isArray(payload)) {
    throw new Error("Polymarket payload was not an array");
  }

  return payload
    .map(mapPolymarketMarket)
    .filter((market): market is PolymarketMarketRecord => market !== null);
}

function highlightedPredictionOutcome(market: PolymarketMarketRecord): {
  label: string;
  probability: number | null;
} {
  const yesIndex = market.outcomeLabels.findIndex((label) => label.trim().toLowerCase() === "yes");
  if (yesIndex >= 0) {
    return {
      label: market.outcomeLabels[yesIndex] ?? "Yes",
      probability: market.outcomeProbabilities[yesIndex] ?? null,
    };
  }

  let highestIndex = -1;
  let highestProbability = -1;
  for (const [index, probability] of market.outcomeProbabilities.entries()) {
    if (probability > highestProbability) {
      highestIndex = index;
      highestProbability = probability;
    }
  }

  if (highestIndex >= 0) {
    return {
      label: market.outcomeLabels[highestIndex] ?? "Top",
      probability: market.outcomeProbabilities[highestIndex] ?? null,
    };
  }

  return { label: "Top", probability: null };
}

function buildPredictions(markets: PolymarketMarketRecord[]): WalletMarketPrediction[] {
  const seenQuestions = new Set<string>();
  const predictions: WalletMarketPrediction[] = [];

  for (const market of markets) {
    const normalizedQuestion = market.question.trim().toLowerCase();
    if (seenQuestions.has(normalizedQuestion)) continue;
    seenQuestions.add(normalizedQuestion);

    const highlightedOutcome = highlightedPredictionOutcome(market);
    predictions.push({
      id: market.slug ?? normalizedQuestion,
      slug: market.slug,
      question: market.question,
      highlightedOutcomeLabel: highlightedOutcome.label,
      highlightedOutcomeProbability: highlightedOutcome.probability,
      volume24hUsd: market.volume24hUsd,
      totalVolumeUsd: market.totalVolumeUsd,
      endsAt: market.endsAt,
      imageUrl: market.imageUrl,
    });
  }

  return predictions.slice(0, 6);
}

async function buildPublicWalletMarketOverview(): Promise<WalletMarketOverviewResponse> {
  const [coinGeckoResult, polymarketResult] = await Promise.allSettled([
    fetchCoinGeckoMarkets(),
    fetchPolymarketMarkets(),
  ]);

  const coinGeckoMarkets = coinGeckoResult.status === "fulfilled" ? coinGeckoResult.value : [];
  const polymarketMarkets = polymarketResult.status === "fulfilled" ? polymarketResult.value : [];
  const coinGeckoError =
    coinGeckoResult.status === "rejected"
      ? marketOverviewErrorMessage(coinGeckoResult.reason)
      : null;
  const polymarketError =
    polymarketResult.status === "rejected"
      ? marketOverviewErrorMessage(polymarketResult.reason)
      : null;

  if (coinGeckoError) {
    logger.warn(`[MarketPreview] CoinGecko feed unavailable (${coinGeckoError})`);
  }

  if (polymarketError) {
    logger.warn(`[MarketPreview] Polymarket feed unavailable (${polymarketError})`);
  }

  if (coinGeckoError && polymarketError) {
    throw new Error(`CoinGecko: ${coinGeckoError}; Polymarket: ${polymarketError}`);
  }

  return {
    generatedAt: new Date().toISOString(),
    cacheTtlSeconds: Math.floor(WALLET_OVERVIEW_CACHE_TTL_MS / 1000),
    stale: false,
    sources: {
      prices: buildMarketOverviewSource(COINGECKO_MARKET_PROVIDER, {
        available: coinGeckoError === null,
        stale: false,
        error: coinGeckoError,
      }),
      movers: buildMarketOverviewSource(COINGECKO_MARKET_PROVIDER, {
        available: coinGeckoError === null,
        stale: false,
        error: coinGeckoError,
      }),
      predictions: buildMarketOverviewSource(POLYMARKET_MARKET_PROVIDER, {
        available: polymarketError === null,
        stale: false,
        error: polymarketError,
      }),
    },
    prices: buildMarketPriceSnapshots(coinGeckoMarkets),
    movers: buildMarketMovers(coinGeckoMarkets),
    predictions: buildPredictions(polymarketMarkets),
  };
}

function freshWalletOverviewCache(): WalletMarketOverviewResponse | null {
  if (!cachedWalletOverview || cachedWalletOverview.expiresAt <= Date.now()) {
    return null;
  }

  return cachedWalletOverview.response;
}

function staleWalletOverviewCache(): WalletMarketOverviewResponse | null {
  if (!cachedWalletOverview) return null;
  return {
    ...cachedWalletOverview.response,
    stale: true,
    sources: markWalletOverviewSourcesStale(cachedWalletOverview.response.sources),
  };
}

export async function loadPublicWalletMarketOverview(): Promise<WalletMarketOverviewResponse> {
  const fresh = freshWalletOverviewCache();
  if (fresh) return fresh;

  if (!walletOverviewInFlight) {
    walletOverviewInFlight = buildPublicWalletMarketOverview()
      .then((response) => {
        cachedWalletOverview = {
          response,
          expiresAt: Date.now() + WALLET_OVERVIEW_CACHE_TTL_MS,
        };
        return response;
      })
      .catch((error) => {
        const stale = staleWalletOverviewCache();
        if (stale) {
          logger.warn(
            `[MarketPreview] Wallet overview refresh failed; serving stale cache (${error instanceof Error ? error.message : String(error)})`,
          );
          return stale;
        }
        throw error;
      })
      .finally(() => {
        walletOverviewInFlight = null;
      });
  }

  return walletOverviewInFlight;
}

async function buildPublicPredictionPreview(): Promise<PublicPredictionPreviewResponse> {
  const markets = await fetchPolymarketMarkets();

  return {
    generatedAt: new Date().toISOString(),
    cacheTtlSeconds: Math.floor(PREDICTIONS_CACHE_TTL_MS / 1000),
    stale: false,
    source: buildMarketOverviewSource(POLYMARKET_MARKET_PROVIDER, {
      available: true,
      stale: false,
      error: null,
    }),
    predictions: buildPredictions(markets),
  };
}

function freshPredictionCache(): PublicPredictionPreviewResponse | null {
  if (!cachedPredictions || cachedPredictions.expiresAt <= Date.now()) {
    return null;
  }

  return cachedPredictions.response;
}

function stalePredictionCache(): PublicPredictionPreviewResponse | null {
  if (!cachedPredictions) return null;
  return {
    ...cachedPredictions.response,
    stale: true,
    source: {
      ...cachedPredictions.response.source,
      stale: true,
    },
  };
}

export async function loadPublicPredictionPreview(): Promise<PublicPredictionPreviewResponse> {
  const fresh = freshPredictionCache();
  if (fresh) return fresh;

  if (!predictionsInFlight) {
    predictionsInFlight = buildPublicPredictionPreview()
      .then((response) => {
        cachedPredictions = {
          response,
          expiresAt: Date.now() + PREDICTIONS_CACHE_TTL_MS,
        };
        return response;
      })
      .catch((error) => {
        const stale = stalePredictionCache();
        if (stale) {
          logger.warn(
            `[MarketPreview] Prediction refresh failed; serving stale cache (${error instanceof Error ? error.message : String(error)})`,
          );
          return stale;
        }
        throw error;
      })
      .finally(() => {
        predictionsInFlight = null;
      });
  }

  return predictionsInFlight;
}

function invalidChainResponse(): Response {
  return Response.json(
    {
      error: "Invalid chain",
      details:
        "Supported chains: solana, ethereum, arbitrum, avalanche, bsc, optimism, polygon, base, zksync, sui",
    },
    { status: 400 },
  );
}

function invalidAddressResponse(chain: string): Response {
  return Response.json(
    {
      error: "Invalid address format",
      details: `Address format invalid for chain: ${chain}`,
    },
    { status: 400 },
  );
}

export async function handlePublicMarketDataPreviewRequest({
  chain,
  address,
  method,
  parameterName,
  routeLabel,
}: {
  chain: string;
  address: string;
  method: MarketDataMethod;
  parameterName: "address" | "wallet";
  routeLabel: string;
}): Promise<Response> {
  const normalizedChain = chain.toLowerCase();

  if (!isValidChain(normalizedChain)) {
    return invalidChainResponse();
  }

  if (!isValidAddress(normalizedChain, address)) {
    return invalidAddressResponse(normalizedChain);
  }

  try {
    const response = await executeMarketDataProviderRequest({
      method,
      chain: normalizedChain,
      params: {
        [parameterName]: address,
      },
    });

    return withCacheControl(response, PUBLIC_MARKET_DATA_CACHE_CONTROL);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[MarketPreview] Public market data preview failed", {
      route: routeLabel,
      method,
      chain: normalizedChain,
      error: message,
    });

    const status = message.includes("not configured") ? 503 : 502;
    return Response.json(
      {
        error: status === 503 ? "Market preview unavailable" : "Market preview upstream failed",
      },
      { status },
    );
  }
}

export function wrapWalletOverviewPreviewResponse(
  response: WalletMarketOverviewResponse,
): Response {
  return Response.json(response, {
    headers: {
      "Cache-Control": PUBLIC_MARKET_OVERVIEW_CACHE_CONTROL,
    },
  });
}

export function wrapPredictionPreviewResponse(response: PublicPredictionPreviewResponse): Response {
  return Response.json(response, {
    headers: {
      "Cache-Control": PUBLIC_MARKET_OVERVIEW_CACHE_CONTROL,
    },
  });
}

export function __resetPublicMarketPreviewCacheForTests(): void {
  cachedWalletOverview = null;
  walletOverviewInFlight = null;
  cachedPredictions = null;
  predictionsInFlight = null;
}
