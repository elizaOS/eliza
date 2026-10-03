/**
 * Read-only market feeds for the crypto terminal view:
 * `GET /api/wallet/terminal/markets` lists the CoinGecko top-market-cap rows,
 * and `GET /api/wallet/terminal/chart?id=<coingecko-id>&days=<1|7|30|90|365>`
 * returns one asset's USD price history.
 *
 * Both responses carry a `WalletMarketOverviewSource` so the client can tell
 * live, stale, and unavailable data apart. Successful upstream reads are cached
 * briefly and concurrent misses share one request; when a refresh fails the
 * last good response is served marked `stale`, and with nothing cached the
 * route answers 502 rather than an empty-but-healthy list. No route here
 * touches wallets, keys, or order execution.
 */
import type http from "node:http";
import { logger } from "@elizaos/core";
import {
  buildCoinGeckoMarketsUrl,
  COINGECKO_MARKET_PROVIDER,
  parseCoinGeckoMarkets,
} from "@elizaos/shared";
import type {
  WalletMarketOverviewSource,
  WalletTerminalChartDays,
  WalletTerminalChartPoint,
  WalletTerminalChartResponse,
  WalletTerminalMarketsResponse,
} from "../contracts.js";

export const TERMINAL_MARKETS_PATH = "/api/wallet/terminal/markets";
export const TERMINAL_CHART_PATH = "/api/wallet/terminal/chart";

const COINGECKO_API_BASE = "https://api.coingecko.com/api/v3";
const FETCH_TIMEOUT_MS = 8_000;
const MARKETS_CACHE_TTL_MS = 60_000;
const CHART_CACHE_TTL_MS: Record<WalletTerminalChartDays, number> = {
  1: 60_000,
  7: 5 * 60_000,
  30: 15 * 60_000,
  90: 30 * 60_000,
  365: 60 * 60_000,
};
const CHART_CACHE_MAX_ENTRIES = 200;
const REFRESH_WINDOW_MS = 60_000;
const REFRESH_LIMIT = 30;
const CHART_DAYS: ReadonlySet<number> = new Set([1, 7, 30, 90, 365]);
const COINGECKO_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;

type TerminalFetch = (
  input: string | URL,
  init: RequestInit,
) => Promise<Response>;

interface CacheEntry<T> {
  response: T;
  expiresAt: number;
}

class UpstreamNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamNotFoundError";
  }
}

const defaultFetch: TerminalFetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

let terminalFetch: TerminalFetch = defaultFetch;
let marketsCache: CacheEntry<WalletTerminalMarketsResponse> | null = null;
let marketsInFlight: Promise<WalletTerminalMarketsResponse> | null = null;
const chartCache = new Map<string, CacheEntry<WalletTerminalChartResponse>>();
const chartInFlight = new Map<string, Promise<WalletTerminalChartResponse>>();
const refreshBuckets = new Map<string, { count: number; resetAt: number }>();

function source(
  available: boolean,
  stale: boolean,
  error: string | null,
): WalletMarketOverviewSource {
  return { ...COINGECKO_MARKET_PROVIDER, available, stale, error };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message.trim()
    : "Upstream market feed failed";
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function getJson(url: URL): Promise<unknown> {
  const response = await terminalFetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent": "Eliza Wallet Terminal Feed/1.0",
    },
  });
  if (response.status === 404) {
    throw new UpstreamNotFoundError("CoinGecko has no such asset");
  }
  if (!response.ok) {
    throw new Error(`CoinGecko responded ${response.status}`);
  }
  return response.json();
}

/** Parse CoinGecko `market_chart` JSON into ordered, finite price points. */
export function parseCoinGeckoMarketChart(
  payload: unknown,
): WalletTerminalChartPoint[] {
  const prices =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { prices?: unknown }).prices
      : undefined;
  if (!Array.isArray(prices)) {
    throw new Error("CoinGecko market_chart payload had no prices array");
  }
  const points: WalletTerminalChartPoint[] = [];
  for (const entry of prices) {
    if (!Array.isArray(entry) || entry.length < 2) {
      throw new Error("CoinGecko market_chart price entry was malformed");
    }
    const [t, priceUsd] = entry;
    if (
      typeof t !== "number" ||
      typeof priceUsd !== "number" ||
      !Number.isFinite(t) ||
      !Number.isFinite(priceUsd) ||
      priceUsd < 0
    ) {
      throw new Error("CoinGecko market_chart price entry was not numeric");
    }
    points.push({ t, priceUsd });
  }
  points.sort((left, right) => left.t - right.t);
  return points;
}

async function buildMarkets(): Promise<WalletTerminalMarketsResponse> {
  const markets = parseCoinGeckoMarkets(
    await getJson(buildCoinGeckoMarketsUrl()),
  ).map((market) => ({
    id: market.id,
    symbol: market.symbol,
    name: market.name,
    priceUsd: market.currentPriceUsd,
    change24hPct: market.change24hPct,
    marketCapRank: market.marketCapRank,
    imageUrl: market.imageUrl,
  }));
  if (markets.length === 0) {
    throw new Error("CoinGecko returned no usable market rows");
  }
  return {
    generatedAt: new Date().toISOString(),
    stale: false,
    source: source(true, false, null),
    markets,
  };
}

async function buildChart(
  id: string,
  days: WalletTerminalChartDays,
): Promise<WalletTerminalChartResponse> {
  const url = new URL(
    `${COINGECKO_API_BASE}/coins/${encodeURIComponent(id)}/market_chart`,
  );
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("days", String(days));
  const points = parseCoinGeckoMarketChart(await getJson(url));
  if (points.length < 2) {
    throw new Error("CoinGecko returned too few price points to chart");
  }
  return {
    id,
    days,
    generatedAt: new Date().toISOString(),
    stale: false,
    source: source(true, false, null),
    points,
  };
}

function markStale<
  T extends { stale: boolean; source: WalletMarketOverviewSource },
>(response: T, error: string): T {
  return {
    ...response,
    stale: true,
    source: { ...response.source, stale: true, error },
  };
}

function resolveClientAddress(req: http.IncomingMessage): string {
  const forwardedFor = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const candidate = first?.split(",")[0]?.trim();
  return candidate || req.socket.remoteAddress || "unknown";
}

function consumeRefreshSlot(clientAddress: string): number | null {
  const now = Date.now();
  for (const [key, bucket] of refreshBuckets) {
    if (bucket.resetAt <= now) refreshBuckets.delete(key);
  }
  const bucket = refreshBuckets.get(clientAddress);
  if (!bucket) {
    refreshBuckets.set(clientAddress, {
      count: 1,
      resetAt: now + REFRESH_WINDOW_MS,
    });
    return null;
  }
  if (bucket.count >= REFRESH_LIMIT) {
    return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  }
  bucket.count += 1;
  return null;
}

async function loadMarkets(): Promise<WalletTerminalMarketsResponse> {
  if (!marketsInFlight) {
    marketsInFlight = buildMarkets()
      .then((response) => {
        marketsCache = {
          response,
          expiresAt: Date.now() + MARKETS_CACHE_TTL_MS,
        };
        return response;
      })
      .finally(() => {
        marketsInFlight = null;
      });
  }
  return marketsInFlight;
}

async function loadChart(
  id: string,
  days: WalletTerminalChartDays,
): Promise<WalletTerminalChartResponse> {
  const key = `${id}:${days}`;
  let pending = chartInFlight.get(key);
  if (!pending) {
    pending = buildChart(id, days)
      .then((response) => {
        chartCache.delete(key);
        chartCache.set(key, {
          response,
          expiresAt: Date.now() + CHART_CACHE_TTL_MS[days],
        });
        while (chartCache.size > CHART_CACHE_MAX_ENTRIES) {
          const oldest = chartCache.keys().next().value;
          if (oldest === undefined) break;
          chartCache.delete(oldest);
        }
        return response;
      })
      .finally(() => {
        chartInFlight.delete(key);
      });
    chartInFlight.set(key, pending);
  }
  return pending;
}

async function serveCached<
  T extends { stale: boolean; source: WalletMarketOverviewSource },
>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cached: CacheEntry<T> | null | undefined,
  inFlight: boolean,
  load: () => Promise<T>,
  label: string,
): Promise<void> {
  if (cached && cached.expiresAt > Date.now()) {
    sendJson(res, 200, cached.response);
    return;
  }
  if (!inFlight) {
    const retryAfter = consumeRefreshSlot(resolveClientAddress(req));
    if (retryAfter !== null) {
      if (cached) {
        sendJson(res, 200, markStale(cached.response, "Refresh rate limited"));
        return;
      }
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Too many market refreshes" });
      return;
    }
  }
  try {
    sendJson(res, 200, await load());
  } catch (error) {
    // error-policy:J1 transport boundary: stale cache or a structured 404/502.
    const message = errorMessage(error);
    if (error instanceof UpstreamNotFoundError) {
      sendJson(res, 404, { error: message });
      return;
    }
    if (cached) {
      logger.warn(
        `[WalletTerminalMarketRoute] ${label} refresh failed; serving stale data (${message})`,
      );
      sendJson(res, 200, markStale(cached.response, message));
      return;
    }
    logger.error(
      `[WalletTerminalMarketRoute] ${label} unavailable (${message})`,
    );
    sendJson(res, 502, { error: `Failed to load ${label}` });
  }
}

/** Serve terminal market routes; returns false when the path is not ours. */
export async function handleWalletTerminalMarketRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (
    url.pathname !== TERMINAL_MARKETS_PATH &&
    url.pathname !== TERMINAL_CHART_PATH
  ) {
    return false;
  }
  if ((req.method ?? "GET").toUpperCase() !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return true;
  }
  res.setHeader("Cache-Control", "public, max-age=30");

  if (url.pathname === TERMINAL_MARKETS_PATH) {
    await serveCached(
      req,
      res,
      marketsCache,
      marketsInFlight !== null,
      loadMarkets,
      "terminal markets",
    );
    return true;
  }

  const id = url.searchParams.get("id") ?? "";
  const days = Number(url.searchParams.get("days"));
  if (!COINGECKO_ID_PATTERN.test(id)) {
    sendJson(res, 400, { error: "id must be a CoinGecko asset id" });
    return true;
  }
  if (!CHART_DAYS.has(days)) {
    sendJson(res, 400, { error: "days must be one of 1, 7, 30, 90, 365" });
    return true;
  }
  const chartDays = days as WalletTerminalChartDays;
  const key = `${id}:${chartDays}`;
  await serveCached(
    req,
    res,
    chartCache.get(key),
    chartInFlight.has(key),
    () => loadChart(id, chartDays),
    "price history",
  );
  return true;
}

export function __resetWalletTerminalMarketRouteForTests(): void {
  terminalFetch = defaultFetch;
  marketsCache = null;
  marketsInFlight = null;
  chartCache.clear();
  chartInFlight.clear();
  refreshBuckets.clear();
}

export function __setWalletTerminalFetchForTests(fetcher: TerminalFetch): void {
  terminalFetch = fetcher;
}

export function __expireWalletTerminalCachesForTests(): void {
  if (marketsCache) marketsCache.expiresAt = 0;
  for (const entry of chartCache.values()) entry.expiresAt = 0;
}
