import type http from "node:http";
import { fetchWithTimeoutGuard } from "@elizaos/agent/api/server-helpers-fetch";
import { resolveCloudApiBaseUrl } from "@elizaos/plugin-elizacloud/cloud/base-url";
import { logger } from "@elizaos/core";
import type {
  WalletMarketMover,
  WalletMarketOverviewResponse,
  WalletMarketOverviewSource,
  WalletMarketPrediction,
  WalletMarketPriceSnapshot,
} from "@elizaos/shared";

const MARKET_OVERVIEW_PATH = "/api/wallet/market-overview";
const CLOUD_MARKET_OVERVIEW_PREVIEW_PATH = "/market/preview/wallet-overview";
const MARKET_OVERVIEW_CACHE_TTL_MS = 120_000;
const MARKET_OVERVIEW_FETCH_TIMEOUT_MS = 8_000;
const MARKET_OVERVIEW_REFRESH_WINDOW_MS = 60_000;
const MARKET_OVERVIEW_REFRESH_LIMIT = 24;
const COINGECKO_MARKET_LIMIT = 80;
const POLYMARKET_MARKET_LIMIT = 10;
const CACHE_CONTROL_VALUE = "public, max-age=60, stale-while-revalidate=180";
const MARKET_PRICE_IDS = ["bitcoin", "ethereum", "solana"] as const;
const MARKET_PRICE_ID_SET = new Set<string>(MARKET_PRICE_IDS);
const COINGECKO_SOURCE = {
  providerId: "coingecko",
  providerName: "CoinGecko",
  providerUrl: "https://www.coingecko.com/",
} as const satisfies Pick<
  WalletMarketOverviewSource,
  "providerId" | "providerName" | "providerUrl"
>;
const POLYMARKET_SOURCE = {
  providerId: "polymarket",
  providerName: "Polymarket",
  providerUrl: "https://polymarket.com/",
} as const satisfies Pick<
  WalletMarketOverviewSource,
  "providerId" | "providerName" | "providerUrl"
>;
const STABLE_ASSET_IDS = new Set([
  "tether",
  "usd-coin",
  "binance-usd",
  "first-digital-usd",
  "dai",
  "ethena-usde",
  "true-usd",
  "usds",
]);
const STABLE_ASSET_SYMBOLS = new Set([
  "usdt",
  "usdc",
  "busd",
  "fdusd",
  "dai",
  "usde",
  "tusd",
  "usds",
]);

interface CoinGeckoMarketRecord {
  id: string;
  symbol: string;
  name: string;
  currentPriceUsd: number;
  change24hPct: number;
  marketCapRank: number | null;
  imageUrl: string | null;
}

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

interface CachedWalletMarketOverview {
  response: WalletMarketOverviewResponse;
  expiresAt: number;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

type WalletMarketOverviewFetch = typeof fetchWithTimeoutGuard;

let cachedWalletMarketOverview: CachedWalletMarketOverview | null = null;
let walletMarketOverviewInFlight: Promise<WalletMarketOverviewResponse> | null =
  null;
const walletMarketRefreshBuckets = new Map<string, RateLimitBucket>();
let walletMarketOverviewFetch: WalletMarketOverviewFetch =
  fetchWithTimeoutGuard;

function scrubStackFields(value: unknown): unknown {
  if (value instanceof Error) {
    return { error: value.message || "Internal error" };
  }
  if (Array.isArray(value)) {
    return value.map(scrubStackFields);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (key === "stack" || key === "stackTrace") continue;
      out[key] = scrubStackFields(nestedValue);
    }
    return out;
  }
  return value;
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(scrubStackFields(body)));
}

function sendJsonError(
  res: http.ServerResponse,
  status: number,
  message: string,
): void {
  sendJson(res, status, { error: message });
}

function marketOverviewErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message.trim()
    : "Upstream market feed failed";
}

function buildMarketOverviewSource(
  source: Pick<
    WalletMarketOverviewSource,
    "providerId" | "providerName" | "providerUrl"
  >,
  {
    available,
    stale,
    error,
  }: Pick<WalletMarketOverviewSource, "available" | "stale" | "error">,
): WalletMarketOverviewSource {
  return {
    ...source,
    available,
    stale,
    error,
  };
}

function markMarketOverviewSourcesStale(
  sources: WalletMarketOverviewResponse["sources"],
): WalletMarketOverviewResponse["sources"] {
  return {
    prices: {
      ...sources.prices,
      stale: true,
    },
    movers: {
      ...sources.movers,
      stale: true,
    },
    predictions: {
      ...sources.predictions,
      stale: true,
    },
  };
}

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

function integerFromUnknown(value: unknown): number | null {
  const parsed = numberFromUnknown(value);
  if (parsed === null) return null;
  return Number.isInteger(parsed) ? parsed : Math.round(parsed);
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  if (typeof value !== "string" || value.trim().length === 0) return [];

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

function isStableAsset(market: CoinGeckoMarketRecord): boolean {
  const id = market.id.toLowerCase();
  const symbol = market.symbol.toLowerCase();
  return STABLE_ASSET_IDS.has(id) || STABLE_ASSET_SYMBOLS.has(symbol);
}

function mapCoinGeckoMarket(input: unknown): CoinGeckoMarketRecord | null {
  const record = asRecord(input);
  if (!record) return null;

  const id = stringFromUnknown(record.id);
  const symbol = stringFromUnknown(record.symbol);
  const name = stringFromUnknown(record.name);
  const currentPriceUsd = numberFromUnknown(record.current_price);
  const change24hPct = numberFromUnknown(record.price_change_percentage_24h);

  if (
    !id ||
    !symbol ||
    !name ||
    currentPriceUsd === null ||
    change24hPct === null
  ) {
    return null;
  }

  return {
    id,
    symbol: symbol.toUpperCase(),
    name,
    currentPriceUsd,
    change24hPct,
    marketCapRank: integerFromUnknown(record.market_cap_rank),
    imageUrl: stringFromUnknown(record.image),
  };
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

function highlightedPredictionOutcome(market: PolymarketMarketRecord): {
  label: string;
  probability: number | null;
} {
  const yesIndex = market.outcomeLabels.findIndex(
    (label) => label.trim().toLowerCase() === "yes",
  );
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

async function fetchCoinGeckoMarkets(): Promise<CoinGeckoMarketRecord[]> {
  const url = new URL("https://api.coingecko.com/api/v3/coins/markets");
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("order", "market_cap_desc");
  url.searchParams.set("per_page", String(COINGECKO_MARKET_LIMIT));
  url.searchParams.set("page", "1");
  url.searchParams.set("price_change_percentage", "24h");

  const response = await walletMarketOverviewFetch(
    url,
    {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "Eliza Wallet Market Feed/1.0",
      },
    },
    MARKET_OVERVIEW_FETCH_TIMEOUT_MS,
  );

  if (!response.ok) {
    throw new Error(`CoinGecko responded ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("CoinGecko payload was not an array");
  }

  return payload
    .map(mapCoinGeckoMarket)
    .filter((market): market is CoinGeckoMarketRecord => market !== null);
}

async function fetchPolymarketMarkets(): Promise<PolymarketMarketRecord[]> {
  const url = new URL("https://gamma-api.polymarket.com/markets");
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("order", "volume24hr");
  url.searchParams.set("ascending", "false");
  url.searchParams.set("limit", String(POLYMARKET_MARKET_LIMIT));

  const response = await walletMarketOverviewFetch(
    url,
    {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "Eliza Wallet Market Feed/1.0",
      },
    },
    MARKET_OVERVIEW_FETCH_TIMEOUT_MS,
  );

  if (!response.ok) {
    throw new Error(`Polymarket responded ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("Polymarket payload was not an array");
  }

  return payload
    .map(mapPolymarketMarket)
    .filter((market): market is PolymarketMarketRecord => market !== null);
}

function buildPriceSnapshots(
  markets: CoinGeckoMarketRecord[],
): WalletMarketPriceSnapshot[] {
  const byId = new Map(markets.map((market) => [market.id, market]));
  return MARKET_PRICE_IDS.reduce<WalletMarketPriceSnapshot[]>((items, id) => {
    const market = byId.get(id);
    if (!market) return items;
    items.push({
      id: market.id,
      symbol: market.symbol,
      name: market.name,
      priceUsd: market.currentPriceUsd,
      change24hPct: market.change24hPct,
      imageUrl: market.imageUrl,
    });
    return items;
  }, []);
}

function buildMovers(markets: CoinGeckoMarketRecord[]): WalletMarketMover[] {
  return markets
    .filter((market) => !MARKET_PRICE_ID_SET.has(market.id))
    .filter((market) => !isStableAsset(market))
    .filter(
      (market) => market.marketCapRank === null || market.marketCapRank <= 200,
    )
    .sort(
      (left, right) =>
        Math.abs(right.change24hPct) - Math.abs(left.change24hPct),
    )
    .slice(0, 6)
    .map((market) => ({
      id: market.id,
      symbol: market.symbol,
      name: market.name,
      priceUsd: market.currentPriceUsd,
      change24hPct: market.change24hPct,
      marketCapRank: market.marketCapRank,
      imageUrl: market.imageUrl,
    }));
}

function buildPredictions(
  markets: PolymarketMarketRecord[],
): WalletMarketPrediction[] {
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

function isWalletMarketOverviewSource(
  value: unknown,
): value is WalletMarketOverviewResponse["sources"][keyof WalletMarketOverviewResponse["sources"]] {
  const record = asRecord(value);
  return (
    record !== null &&
    typeof record.providerId === "string" &&
    typeof record.providerName === "string" &&
    typeof record.providerUrl === "string" &&
    typeof record.available === "boolean" &&
    typeof record.stale === "boolean" &&
    (typeof record.error === "string" || record.error === null)
  );
}

function isWalletMarketOverviewResponse(
  value: unknown,
): value is WalletMarketOverviewResponse {
  const record = asRecord(value);
  const sources = asRecord(record?.sources);
  return (
    record !== null &&
    typeof record.generatedAt === "string" &&
    typeof record.cacheTtlSeconds === "number" &&
    typeof record.stale === "boolean" &&
    sources !== null &&
    isWalletMarketOverviewSource(sources.prices) &&
    isWalletMarketOverviewSource(sources.movers) &&
    isWalletMarketOverviewSource(sources.predictions) &&
    Array.isArray(record.prices) &&
    Array.isArray(record.movers) &&
    Array.isArray(record.predictions)
  );
}

function resolveWalletMarketOverviewCloudPreviewUrl(): string {
  return `${resolveCloudApiBaseUrl(process.env.ELIZAOS_CLOUD_BASE_URL)}${CLOUD_MARKET_OVERVIEW_PREVIEW_PATH}`;
}

async function fetchCloudWalletMarketOverview(
  clientAddress: string,
): Promise<WalletMarketOverviewResponse> {
  const response = await walletMarketOverviewFetch(
    resolveWalletMarketOverviewCloudPreviewUrl(),
    {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "Eliza Wallet Market Feed/1.0",
        ...(clientAddress !== "unknown"
          ? { "x-forwarded-for": clientAddress }
          : {}),
      },
    },
    MARKET_OVERVIEW_FETCH_TIMEOUT_MS,
  );

  if (!response.ok) {
    throw new Error(`Cloud preview responded ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (!isWalletMarketOverviewResponse(payload)) {
    throw new Error("Cloud preview payload was invalid");
  }

  return payload;
}

async function buildWalletMarketOverview(
  clientAddress: string,
): Promise<WalletMarketOverviewResponse> {
  const [cloudPreviewResult, polymarketResult] = await Promise.allSettled([
    fetchCloudWalletMarketOverview(clientAddress),
    fetchPolymarketMarkets(),
  ]);
  const polymarketMarkets =
    polymarketResult.status === "fulfilled" ? polymarketResult.value : [];
  const polymarketError =
    polymarketResult.status === "rejected"
      ? marketOverviewErrorMessage(polymarketResult.reason)
      : null;

  if (cloudPreviewResult.status === "fulfilled") {
    if (polymarketError) {
      logger.warn(
        `[WalletMarketOverviewRoute] Polymarket feed unavailable (${polymarketError})`,
      );
    }

    return {
      ...cloudPreviewResult.value,
      sources: {
        ...cloudPreviewResult.value.sources,
        predictions: buildMarketOverviewSource(POLYMARKET_SOURCE, {
          available: polymarketError === null,
          stale: false,
          error: polymarketError,
        }),
      },
      predictions:
        polymarketError === null ? buildPredictions(polymarketMarkets) : [],
    };
  }

  {
    const error = cloudPreviewResult.reason;
    logger.warn(
      `[WalletMarketOverviewRoute] Cloud preview unavailable (${marketOverviewErrorMessage(error)}); falling back to direct feeds`,
    );
  }

  const [coinGeckoResult] = await Promise.allSettled([fetchCoinGeckoMarkets()]);
  const coinGeckoMarkets =
    coinGeckoResult.status === "fulfilled" ? coinGeckoResult.value : [];
  const coinGeckoError =
    coinGeckoResult.status === "rejected"
      ? marketOverviewErrorMessage(coinGeckoResult.reason)
      : null;

  if (coinGeckoError) {
    logger.warn(
      `[WalletMarketOverviewRoute] CoinGecko feed unavailable (${coinGeckoError})`,
    );
  }

  if (polymarketError) {
    logger.warn(
      `[WalletMarketOverviewRoute] Polymarket feed unavailable (${polymarketError})`,
    );
  }

  if (coinGeckoError && polymarketError) {
    throw new Error(
      `CoinGecko: ${coinGeckoError}; Polymarket: ${polymarketError}`,
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    cacheTtlSeconds: Math.floor(MARKET_OVERVIEW_CACHE_TTL_MS / 1000),
    stale: false,
    sources: {
      prices: buildMarketOverviewSource(COINGECKO_SOURCE, {
        available: coinGeckoError === null,
        stale: false,
        error: coinGeckoError,
      }),
      movers: buildMarketOverviewSource(COINGECKO_SOURCE, {
        available: coinGeckoError === null,
        stale: false,
        error: coinGeckoError,
      }),
      predictions: buildMarketOverviewSource(POLYMARKET_SOURCE, {
        available: polymarketError === null,
        stale: false,
        error: polymarketError,
      }),
    },
    prices: buildPriceSnapshots(coinGeckoMarkets),
    movers: buildMovers(coinGeckoMarkets),
    predictions: buildPredictions(polymarketMarkets),
  };
}

function freshCachedWalletMarketOverview(): WalletMarketOverviewResponse | null {
  if (
    !cachedWalletMarketOverview ||
    cachedWalletMarketOverview.expiresAt <= Date.now()
  ) {
    return null;
  }

  return cachedWalletMarketOverview.response;
}

function staleCachedWalletMarketOverview(): WalletMarketOverviewResponse | null {
  if (!cachedWalletMarketOverview) return null;
  return {
    ...cachedWalletMarketOverview.response,
    stale: true,
    sources: markMarketOverviewSourcesStale(
      cachedWalletMarketOverview.response.sources,
    ),
  };
}

function resolveClientAddress(req: http.IncomingMessage): string {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim().length > 0) {
    return forwardedFor.split(",")[0]?.trim() || "unknown";
  }
  if (Array.isArray(forwardedFor) && forwardedFor.length > 0) {
    return forwardedFor[0]?.trim() || "unknown";
  }
  return req.socket.remoteAddress ?? "unknown";
}

function consumeRefreshSlot(clientAddress: string): {
  allowed: boolean;
  retryAfterSeconds: number;
} {
  const now = Date.now();

  for (const [key, bucket] of walletMarketRefreshBuckets) {
    if (bucket.resetAt <= now) {
      walletMarketRefreshBuckets.delete(key);
    }
  }

  const bucket = walletMarketRefreshBuckets.get(clientAddress);
  if (!bucket || bucket.resetAt <= now) {
    walletMarketRefreshBuckets.set(clientAddress, {
      count: 1,
      resetAt: now + MARKET_OVERVIEW_REFRESH_WINDOW_MS,
    });
    return {
      allowed: true,
      retryAfterSeconds: Math.ceil(MARKET_OVERVIEW_REFRESH_WINDOW_MS / 1000),
    };
  }

  if (bucket.count >= MARKET_OVERVIEW_REFRESH_LIMIT) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  bucket.count += 1;
  walletMarketRefreshBuckets.set(clientAddress, bucket);
  return {
    allowed: true,
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

function setPublicMarketHeaders(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", CACHE_CONTROL_VALUE);
}

async function loadWalletMarketOverview(
  clientAddress: string,
): Promise<WalletMarketOverviewResponse> {
  const fresh = freshCachedWalletMarketOverview();
  if (fresh) return fresh;

  if (!walletMarketOverviewInFlight) {
    walletMarketOverviewInFlight = buildWalletMarketOverview(clientAddress)
      .then((response) => {
        cachedWalletMarketOverview = {
          response,
          expiresAt: Date.now() + MARKET_OVERVIEW_CACHE_TTL_MS,
        };
        return response;
      })
      .catch((error) => {
        const stale = staleCachedWalletMarketOverview();
        if (stale) {
          logger.warn(
            `[WalletMarketOverviewRoute] Refresh failed; serving stale market overview (${error instanceof Error ? error.message : String(error)})`,
          );
          return stale;
        }
        throw error;
      })
      .finally(() => {
        walletMarketOverviewInFlight = null;
      });
  }

  return walletMarketOverviewInFlight;
}

export async function handleWalletMarketOverviewRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname !== MARKET_OVERVIEW_PATH) {
    return false;
  }

  setPublicMarketHeaders(res);

  if (method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }

  if (method !== "GET") {
    sendJsonError(res, 405, "Method not allowed");
    return true;
  }

  const clientAddress = resolveClientAddress(req);

  const fresh = freshCachedWalletMarketOverview();
  if (fresh) {
    sendJson(res, 200, fresh);
    return true;
  }

  if (!walletMarketOverviewInFlight) {
    const rateLimit = consumeRefreshSlot(clientAddress);
    if (!rateLimit.allowed) {
      const stale = staleCachedWalletMarketOverview();
      if (stale) {
        sendJson(res, 200, stale);
        return true;
      }
      res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
      sendJsonError(res, 429, "Too many market overview refreshes");
      return true;
    }
  }

  try {
    const overview = await loadWalletMarketOverview(clientAddress);
    sendJson(res, 200, overview);
  } catch (error) {
    logger.error(
      `[WalletMarketOverviewRoute] Failed to load market overview (${error instanceof Error ? error.message : String(error)})`,
    );
    sendJsonError(res, 502, "Failed to load market overview");
  }

  return true;
}

export function __resetWalletMarketOverviewCacheForTests(): void {
  cachedWalletMarketOverview = null;
  walletMarketOverviewInFlight = null;
  walletMarketRefreshBuckets.clear();
  walletMarketOverviewFetch = fetchWithTimeoutGuard;
}

export function __setWalletMarketOverviewFetchForTests(
  fetcher: WalletMarketOverviewFetch,
): void {
  walletMarketOverviewFetch = fetcher;
}
