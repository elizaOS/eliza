import type http from "node:http";
import { sendJson, sendJsonError } from "@elizaos/app-core";
import { logger } from "@elizaos/core";
import {
  derivePolymarketTopOfBook,
  type PolymarketOrderbookLevel,
} from "./orderbook";
import {
  POLYMARKET_CLOB_API_BASE,
  POLYMARKET_DATA_API_BASE,
  POLYMARKET_GAMMA_API_BASE,
  POLYMARKET_TRADING_ENV_VARS,
  type PolymarketDisabledResponse,
  type PolymarketMarket,
  type PolymarketMarketOutcome,
  type PolymarketMarketResponse,
  type PolymarketMarketsResponse,
  type PolymarketOrderbookResponse,
  type PolymarketPosition,
  type PolymarketPositionsResponse,
  type PolymarketStatusResponse,
  type PolymarketTradingEnvVar,
} from "./polymarket-contracts";

export interface PolymarketRouteState {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

interface GammaMarketRecord {
  id?: unknown;
  slug?: unknown;
  question?: unknown;
  description?: unknown;
  category?: unknown;
  active?: unknown;
  closed?: unknown;
  archived?: unknown;
  restricted?: unknown;
  enableOrderBook?: unknown;
  conditionId?: unknown;
  clobTokenIds?: unknown;
  outcomes?: unknown;
  outcomePrices?: unknown;
  liquidity?: unknown;
  volume?: unknown;
  volume24hr?: unknown;
  lastTradePrice?: unknown;
  bestBid?: unknown;
  bestAsk?: unknown;
  image?: unknown;
  icon?: unknown;
  endDate?: unknown;
  startDate?: unknown;
  updatedAt?: unknown;
}

interface DataPositionRecord {
  marketId?: unknown;
  conditionId?: unknown;
  question?: unknown;
  outcome?: unknown;
  size?: unknown;
  currentValue?: unknown;
  cashPnl?: unknown;
  percentPnl?: unknown;
  icon?: unknown;
  slug?: unknown;
}

interface ClobOrderbookRecord {
  market?: unknown;
  asset_id?: unknown;
  bids?: unknown;
  asks?: unknown;
  tick_size?: unknown;
  last_trade_price?: unknown;
}

const DISABLED_TRADING_REASON =
  "Trading and order management are disabled in this first native scaffold. Configure CLOB credentials first, then implement signed CLOB order calls before enabling these routes.";

const TRADING_NOT_IMPLEMENTED_REASON =
  "Signed Polymarket CLOB trading is not implemented in this native scaffold yet.";

const TRADING_ENV_ALIASES: Partial<Record<PolymarketTradingEnvVar, string[]>> =
  {
    CLOB_API_KEY: ["POLYMARKET_CLOB_API_KEY"],
    CLOB_API_SECRET: ["POLYMARKET_CLOB_SECRET"],
    CLOB_API_PASSPHRASE: ["POLYMARKET_CLOB_PASSPHRASE"],
  };

export async function handlePolymarketRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: PolymarketRouteState = {},
): Promise<boolean> {
  if (!pathname.startsWith("/api/polymarket")) return false;

  if (method === "GET" && pathname === "/api/polymarket/status") {
    sendJson(res, 200, buildStatusResponse(state.env ?? process.env));
    return true;
  }

  if (method === "GET" && pathname === "/api/polymarket/markets") {
    await handleMarkets(req, res, state.fetchImpl ?? fetch);
    return true;
  }

  if (method === "GET" && pathname === "/api/polymarket/market") {
    await handleMarket(req, res, state.fetchImpl ?? fetch);
    return true;
  }

  if (method === "GET" && pathname === "/api/polymarket/orderbook") {
    await handleOrderbook(req, res, state.fetchImpl ?? fetch);
    return true;
  }

  if (pathname === "/api/polymarket/orders") {
    sendJson(res, 501, buildDisabledResponse());
    return true;
  }

  if (method === "GET" && pathname === "/api/polymarket/positions") {
    await handlePositions(req, res, state.fetchImpl ?? fetch);
    return true;
  }

  if (pathname === "/api/polymarket/positions") {
    sendJson(res, 501, buildDisabledResponse());
    return true;
  }

  return false;
}

function buildStatusResponse(
  env: Record<string, string | undefined>,
): PolymarketStatusResponse {
  const missing = POLYMARKET_TRADING_ENV_VARS.filter(
    (name) => !hasTradingEnvVar(env, name),
  );
  const credentialsReady = missing.length === 0;
  return {
    publicReads: {
      ready: true,
      reason: null,
      gammaApiBase: POLYMARKET_GAMMA_API_BASE,
      dataApiBase: POLYMARKET_DATA_API_BASE,
    },
    trading: {
      ready: false,
      credentialsReady,
      reason: credentialsReady
        ? TRADING_NOT_IMPLEMENTED_REASON
        : "Trading requires POLYMARKET_PRIVATE_KEY plus CLOB API key, secret, and passphrase.",
      missing,
      clobApiBase: POLYMARKET_CLOB_API_BASE,
    },
  };
}

function hasTradingEnvVar(
  env: Record<string, string | undefined>,
  name: PolymarketTradingEnvVar,
): boolean {
  if (env[name]?.trim()) return true;
  return (TRADING_ENV_ALIASES[name] ?? []).some((alias) => env[alias]?.trim());
}

async function handleMarkets(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  fetchImpl: typeof fetch,
): Promise<void> {
  const requestUrl = new URL(req.url ?? "/api/polymarket/markets", "http://x");
  const gammaUrl = new URL("/markets", POLYMARKET_GAMMA_API_BASE);
  gammaUrl.searchParams.set(
    "active",
    readBooleanQuery(requestUrl, "active", true),
  );
  gammaUrl.searchParams.set(
    "closed",
    readBooleanQuery(requestUrl, "closed", false),
  );
  gammaUrl.searchParams.set("order", readOrderQuery(requestUrl));
  gammaUrl.searchParams.set(
    "ascending",
    readBooleanQuery(requestUrl, "ascending", false),
  );
  gammaUrl.searchParams.set(
    "limit",
    String(readIntegerQuery(requestUrl, "limit", 20, 1, 100)),
  );
  gammaUrl.searchParams.set(
    "offset",
    String(readIntegerQuery(requestUrl, "offset", 0, 0, 10_000)),
  );
  const tagId = requestUrl.searchParams.get("tag_id")?.trim();
  if (tagId) gammaUrl.searchParams.set("tag_id", tagId);

  try {
    const payload = await fetchJson(fetchImpl, gammaUrl);
    if (!Array.isArray(payload)) {
      sendJsonError(
        res,
        502,
        "Polymarket Gamma returned an invalid markets payload",
      );
      return;
    }
    const response: PolymarketMarketsResponse = {
      markets: payload.flatMap(readGammaMarket),
      source: { api: "gamma", endpoint: gammaUrl.toString() },
    };
    sendJson(res, 200, response);
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      "[PolymarketRoutes] Gamma markets request failed",
    );
    sendJsonError(res, 502, "Polymarket markets request failed");
  }
}

async function handleMarket(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  fetchImpl: typeof fetch,
): Promise<void> {
  const requestUrl = new URL(req.url ?? "/api/polymarket/market", "http://x");
  const id = requestUrl.searchParams.get("id")?.trim();
  const slug = requestUrl.searchParams.get("slug")?.trim();

  if (!id && !slug) {
    sendJsonError(res, 400, "Missing market id or slug");
    return;
  }

  const gammaUrl = id
    ? new URL(`/markets/${encodeURIComponent(id)}`, POLYMARKET_GAMMA_API_BASE)
    : new URL("/markets", POLYMARKET_GAMMA_API_BASE);
  if (slug && !id) gammaUrl.searchParams.set("slug", slug);

  try {
    const payload = await fetchJson(fetchImpl, gammaUrl);
    const record = Array.isArray(payload) ? payload[0] : payload;
    const market = readGammaMarket(record)[0] ?? null;
    const response: PolymarketMarketResponse = {
      market,
      source: { api: "gamma", endpoint: gammaUrl.toString() },
    };
    sendJson(res, 200, response);
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      "[PolymarketRoutes] Gamma market request failed",
    );
    sendJsonError(res, 502, "Polymarket market request failed");
  }
}

async function handleOrderbook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  fetchImpl: typeof fetch,
): Promise<void> {
  const requestUrl = new URL(
    req.url ?? "/api/polymarket/orderbook",
    "http://x",
  );
  const tokenId =
    requestUrl.searchParams.get("token_id")?.trim() ||
    requestUrl.searchParams.get("tokenId")?.trim();
  if (!tokenId) {
    sendJsonError(res, 400, "Missing token_id");
    return;
  }

  const clobUrl = new URL("/book", POLYMARKET_CLOB_API_BASE);
  clobUrl.searchParams.set("token_id", tokenId);

  try {
    const payload = await fetchJson(fetchImpl, clobUrl);
    if (!isRecord(payload)) {
      sendJsonError(res, 502, "Polymarket CLOB returned an invalid orderbook");
      return;
    }
    const record = payload as ClobOrderbookRecord;
    const bids = readOrderbookLevels(record.bids);
    const asks = readOrderbookLevels(record.asks);
    const top = derivePolymarketTopOfBook({ bids, asks });
    const response: PolymarketOrderbookResponse = {
      tokenId,
      market: readString(record.market),
      assetId: readString(record.asset_id),
      bids,
      asks,
      bestBid: top.bestBid?.price ?? null,
      bestBidSize: top.bestBid?.size ?? null,
      bestAsk: top.bestAsk?.price ?? null,
      bestAskSize: top.bestAsk?.size ?? null,
      midpoint: top.midpoint,
      spread: top.spread,
      bidLevels: bids.length,
      askLevels: asks.length,
      lastTradePrice: readNumericString(record.last_trade_price),
      tickSize: readNumericString(record.tick_size),
      source: { api: "clob", endpoint: clobUrl.toString() },
    };
    sendJson(res, 200, response);
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      "[PolymarketRoutes] CLOB orderbook request failed",
    );
    sendJsonError(res, 502, "Polymarket orderbook request failed");
  }
}

async function handlePositions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  fetchImpl: typeof fetch,
): Promise<void> {
  const requestUrl = new URL(
    req.url ?? "/api/polymarket/positions",
    "http://x",
  );
  const user = requestUrl.searchParams.get("user")?.trim();
  if (!user) {
    sendJsonError(res, 400, "Missing user wallet address");
    return;
  }

  const dataUrl = new URL("/positions", POLYMARKET_DATA_API_BASE);
  dataUrl.searchParams.set("user", user);
  dataUrl.searchParams.set(
    "limit",
    String(readIntegerQuery(requestUrl, "limit", 50, 1, 250)),
  );

  try {
    const payload = await fetchJson(fetchImpl, dataUrl);
    if (!Array.isArray(payload)) {
      sendJsonError(
        res,
        502,
        "Polymarket Data API returned an invalid positions payload",
      );
      return;
    }
    const response: PolymarketPositionsResponse = {
      positions: payload.flatMap(readDataPosition),
      source: { api: "data", endpoint: dataUrl.toString() },
    };
    sendJson(res, 200, response);
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      "[PolymarketRoutes] Data API positions request failed",
    );
    sendJsonError(res, 502, "Polymarket positions request failed");
  }
}

async function fetchJson(fetchImpl: typeof fetch, url: URL): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `${url.pathname} failed with ${response.status}: ${text.slice(0, 200)}`,
    );
  }
  return response.json();
}

function readGammaMarket(value: unknown): PolymarketMarket[] {
  if (!isRecord(value)) return [];
  const record = value as GammaMarketRecord;
  const id = readString(record.id);
  if (!id) return [];
  const outcomes = readStringArray(record.outcomes);
  const outcomePrices = readStringArray(record.outcomePrices);
  return [
    {
      id,
      slug: readString(record.slug),
      question: readString(record.question),
      description: readString(record.description),
      category: readString(record.category),
      active: readBoolean(record.active),
      closed: readBoolean(record.closed),
      archived: readBoolean(record.archived),
      restricted: readBoolean(record.restricted),
      enableOrderBook: readBoolean(record.enableOrderBook),
      conditionId: readString(record.conditionId),
      clobTokenIds: readStringArray(record.clobTokenIds),
      outcomes: outcomes.map<PolymarketMarketOutcome>((name, index) => ({
        name,
        price: outcomePrices[index] ?? null,
      })),
      liquidity: readNumericString(record.liquidity),
      volume: readNumericString(record.volume),
      volume24hr: readNumericString(record.volume24hr),
      lastTradePrice: readNumericString(record.lastTradePrice),
      bestBid: readNumericString(record.bestBid),
      bestAsk: readNumericString(record.bestAsk),
      image: readString(record.image),
      icon: readString(record.icon),
      endDate: readString(record.endDate),
      startDate: readString(record.startDate),
      updatedAt: readString(record.updatedAt),
    },
  ];
}

function readDataPosition(value: unknown): PolymarketPosition[] {
  if (!isRecord(value)) return [];
  const record = value as DataPositionRecord;
  return [
    {
      marketId: readString(record.marketId),
      conditionId: readString(record.conditionId),
      question: readString(record.question),
      outcome: readString(record.outcome),
      size: readNumericString(record.size),
      currentValue: readNumericString(record.currentValue),
      cashPnl: readNumericString(record.cashPnl),
      percentPnl: readNumericString(record.percentPnl),
      icon: readString(record.icon),
      slug: readString(record.slug),
    },
  ];
}

function buildDisabledResponse(): PolymarketDisabledResponse {
  return {
    enabled: false,
    reason: DISABLED_TRADING_REASON,
    requiredForTrading: POLYMARKET_TRADING_ENV_VARS,
  };
}

function readIntegerQuery(
  url: URL,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = url.searchParams.get(key);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function readBooleanQuery(url: URL, key: string, fallback: boolean): string {
  const raw = url.searchParams.get(key);
  if (raw === "true" || raw === "false") return raw;
  return String(fallback);
}

function readOrderQuery(url: URL): string {
  const raw = url.searchParams.get("order")?.trim();
  return raw || "volume_24hr";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readNumericString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function readOrderbookLevels(
  value: unknown,
): readonly PolymarketOrderbookLevel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const price = readNumericString(item.price);
    const size = readNumericString(item.size);
    return price && size ? [{ price, size }] : [];
  });
}

function readStringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const text = readString(item);
      return text ? [text] : [];
    });
  }
  const text = readString(value);
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed)
      ? parsed.flatMap((item) => {
          const itemText = readString(item);
          return itemText ? [itemText] : [];
        })
      : [];
  } catch {
    return [];
  }
}
