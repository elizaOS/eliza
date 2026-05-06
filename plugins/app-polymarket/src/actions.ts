import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
} from "@elizaos/core";
import { resolveApiToken, resolveDesktopApiPort } from "@elizaos/shared";
import type {
  PolymarketDisabledResponse,
  PolymarketMarket,
  PolymarketMarketResponse,
  PolymarketMarketsResponse,
  PolymarketOrderbookResponse,
  PolymarketPositionsResponse,
  PolymarketStatusResponse,
} from "./polymarket-contracts";

const ACTION_TIMEOUT_MS = 15_000;

const READ_KINDS = [
  "status",
  "markets",
  "market",
  "orderbook",
  "positions",
] as const;
type PolymarketReadKind = (typeof READ_KINDS)[number];

function getApiBase(): string {
  return `http://127.0.0.1:${resolveDesktopApiPort(process.env)}`;
}

function buildAuthHeaders(): Record<string, string> {
  const token = resolveApiToken(process.env);
  if (!token) return {};
  return {
    Authorization: /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`,
  };
}

function readParam(
  options: HandlerOptions | Record<string, unknown> | undefined,
  key: string,
): unknown {
  const maybeOptions = options as { parameters?: Record<string, unknown> };
  if (maybeOptions?.parameters && key in maybeOptions.parameters) {
    return maybeOptions.parameters[key];
  }
  return (options as Record<string, unknown> | undefined)?.[key];
}

function readStringParam(
  options: HandlerOptions | Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = readParam(options, key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumberParam(
  options: HandlerOptions | Record<string, unknown> | undefined,
  key: string,
  fallback: number,
): number {
  const value = readParam(options, key);
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readKind(
  options: HandlerOptions | Record<string, unknown> | undefined,
): PolymarketReadKind | null {
  const raw = readStringParam(options, "kind");
  if (!raw) return null;
  const normalized = raw.toLowerCase() as PolymarketReadKind;
  return (READ_KINDS as readonly string[]).includes(normalized)
    ? normalized
    : null;
}

async function fetchPolymarketJson<T>(
  path: string,
  options: { allowErrorStatus?: boolean } = {},
): Promise<T> {
  const response = await fetch(`${getApiBase()}${path}`, {
    headers: { accept: "application/json", ...buildAuthHeaders() },
    signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
  });
  const payload = (await response.json().catch(() => null)) as T;
  if (options.allowErrorStatus && payload !== null) {
    return payload;
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error?: unknown }).error)
        : `Polymarket API request failed with ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

async function emit(
  callback: HandlerCallback | undefined,
  actionName: string,
  text: string,
  data: Record<string, unknown>,
): Promise<ActionResult> {
  if (callback) {
    await callback({ text, actions: [actionName], data });
  }
  return {
    success: true,
    text,
    data: { actionName, ...data },
  };
}

function marketLine(market: PolymarketMarket): string {
  const price =
    market.bestBid || market.bestAsk
      ? ` bid ${market.bestBid ?? "n/a"} ask ${market.bestAsk ?? "n/a"}`
      : "";
  const volume = market.volume24hr ? ` volume24h ${market.volume24hr}` : "";
  return `- ${market.question ?? market.slug ?? market.id}${price}${volume}`;
}

function formatMarkets(markets: readonly PolymarketMarket[]): string {
  if (markets.length === 0) return "No active Polymarket markets found.";
  return `Polymarket markets:\n${markets
    .slice(0, 12)
    .map(marketLine)
    .join("\n")}`;
}

function formatMarket(response: PolymarketMarketResponse): string {
  const market = response.market;
  if (!market) return "No matching Polymarket market found.";
  const tokens = market.clobTokenIds.length
    ? `\nToken IDs: ${market.clobTokenIds.join(", ")}`
    : "";
  const outcomes = market.outcomes.length
    ? `\nOutcomes: ${market.outcomes
        .map((outcome) => `${outcome.name} ${outcome.price ?? "n/a"}`)
        .join(", ")}`
    : "";
  return `${market.question ?? market.slug ?? market.id}\nStatus: ${
    market.active ? "active" : "inactive"
  }, ${market.closed ? "closed" : "open"}\nBest bid: ${
    market.bestBid ?? "n/a"
  }\nBest ask: ${market.bestAsk ?? "n/a"}${outcomes}${tokens}`;
}

function formatOrderbook(orderbook: PolymarketOrderbookResponse): string {
  return [
    `Polymarket orderbook for ${orderbook.tokenId}:`,
    `Best bid: ${orderbook.bestBid ?? "n/a"} (${orderbook.bestBidSize ?? "n/a"})`,
    `Best ask: ${orderbook.bestAsk ?? "n/a"} (${orderbook.bestAskSize ?? "n/a"})`,
    `Spread: ${orderbook.spread ?? "n/a"}`,
    `Midpoint: ${orderbook.midpoint ?? "n/a"}`,
    `Depth: ${orderbook.bidLevels} bids, ${orderbook.askLevels} asks`,
  ].join("\n");
}

async function handleStatus(
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const status = await fetchPolymarketJson<PolymarketStatusResponse>(
    "/api/polymarket/status",
  );
  const text = `Polymarket public reads: ${
    status.publicReads.ready ? "ready" : "not ready"
  }\nTrading: ${status.trading.ready ? "ready" : "disabled"}\nCredentials: ${
    status.trading.credentialsReady ? "present" : "missing"
  }${status.trading.reason ? `\nReason: ${status.trading.reason}` : ""}`;
  return emit(callback, "POLYMARKET_READ", text, {
    kind: "status" satisfies PolymarketReadKind,
    status,
  });
}

async function handleMarkets(
  options: HandlerOptions | Record<string, unknown> | undefined,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const limit = Math.min(
    100,
    Math.max(1, readNumberParam(options, "limit", 20)),
  );
  const offset = Math.max(0, readNumberParam(options, "offset", 0));
  const response = await fetchPolymarketJson<PolymarketMarketsResponse>(
    `/api/polymarket/markets?limit=${limit}&offset=${offset}`,
  );
  return emit(callback, "POLYMARKET_READ", formatMarkets(response.markets), {
    kind: "markets" satisfies PolymarketReadKind,
    markets: response.markets,
    source: response.source,
  });
}

async function handleMarket(
  options: HandlerOptions | Record<string, unknown> | undefined,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const id = readStringParam(options, "id");
  const slug = readStringParam(options, "slug");
  if (!id && !slug) {
    const text = "Provide a Polymarket market id or slug.";
    if (callback) await callback({ text, actions: ["POLYMARKET_READ"] });
    return { success: false, text, error: "missing_market_identifier" };
  }
  const query = new URLSearchParams();
  if (id) query.set("id", id);
  if (slug && !id) query.set("slug", slug);
  const response = await fetchPolymarketJson<PolymarketMarketResponse>(
    `/api/polymarket/market?${query.toString()}`,
  );
  return emit(callback, "POLYMARKET_READ", formatMarket(response), {
    kind: "market" satisfies PolymarketReadKind,
    market: response.market,
    source: response.source,
  });
}

async function handleOrderbook(
  options: HandlerOptions | Record<string, unknown> | undefined,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const tokenId =
    readStringParam(options, "tokenId") ?? readStringParam(options, "token_id");
  if (!tokenId) {
    const text = "Provide a Polymarket CLOB token id.";
    if (callback) await callback({ text, actions: ["POLYMARKET_READ"] });
    return { success: false, text, error: "missing_token_id" };
  }
  const response = await fetchPolymarketJson<PolymarketOrderbookResponse>(
    `/api/polymarket/orderbook?token_id=${encodeURIComponent(tokenId)}`,
  );
  return emit(callback, "POLYMARKET_READ", formatOrderbook(response), {
    kind: "orderbook" satisfies PolymarketReadKind,
    orderbook: response,
  });
}

async function handlePositions(
  options: HandlerOptions | Record<string, unknown> | undefined,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const user = readStringParam(options, "user");
  if (!user) {
    const text = "Provide a wallet address for Polymarket positions.";
    if (callback) await callback({ text, actions: ["POLYMARKET_READ"] });
    return { success: false, text, error: "missing_wallet_address" };
  }
  const response = await fetchPolymarketJson<PolymarketPositionsResponse>(
    `/api/polymarket/positions?user=${encodeURIComponent(user)}`,
  );
  const text =
    response.positions.length === 0
      ? "No Polymarket positions found for that wallet."
      : `Polymarket positions:\n${response.positions
          .slice(0, 12)
          .map(
            (position) =>
              `- ${position.question ?? position.conditionId ?? "Market"}: ${
                position.outcome ?? "outcome"
              } size ${position.size ?? "n/a"} value ${
                position.currentValue ?? "n/a"
              }`,
          )
          .join("\n")}`;
  return emit(callback, "POLYMARKET_READ", text, {
    kind: "positions" satisfies PolymarketReadKind,
    positions: response.positions,
    source: response.source,
  });
}

export const polymarketReadAction: Action = {
  name: "POLYMARKET_READ",
  similes: [
    "POLYMARKET_STATUS",
    "POLYMARKET_READINESS",
    "POLYMARKET_HEALTH",
    "POLYMARKET_GET_MARKETS",
    "POLYMARKET_MARKETS",
    "SEARCH_POLYMARKET_MARKETS",
    "POLYMARKET_GET_MARKET",
    "POLYMARKET_MARKET",
    "POLYMARKET_MARKET_DETAILS",
    "POLYMARKET_GET_ORDERBOOK",
    "POLYMARKET_ORDERBOOK",
    "POLYMARKET_QUOTE",
    "POLYMARKET_TOKEN_INFO",
    "POLYMARKET_GET_POSITIONS",
    "POLYMARKET_POSITIONS",
    "POLYMARKET_WALLET_POSITIONS",
  ],
  description:
    "Read Polymarket public state. kind selects: status (readiness), markets (list active markets), market (single market by id/slug), orderbook (CLOB quote by tokenId), positions (wallet positions).",
  descriptionCompressed:
    "Polymarket reads: status, markets, market, orderbook, positions.",
  parameters: [
    {
      name: "kind",
      description:
        "Read kind: status | markets | market | orderbook | positions.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "limit",
      description: "markets only: max markets (1-100).",
      required: false,
      schema: { type: "number", default: 20 },
    },
    {
      name: "offset",
      description: "markets only: result offset.",
      required: false,
      schema: { type: "number", default: 0 },
    },
    {
      name: "id",
      description: "market only: Polymarket Gamma market id.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "slug",
      description: "market only: Polymarket market slug.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "tokenId",
      description: "orderbook only: Polymarket CLOB token id.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "user",
      description: "positions only: wallet address.",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async () => true,
  handler: async (_runtime, _message, _state, options, callback) => {
    const kind = readKind(options);
    if (!kind) {
      const text =
        "Provide kind: status | markets | market | orderbook | positions.";
      if (callback) await callback({ text, actions: ["POLYMARKET_READ"] });
      return { success: false, text, error: "missing_or_invalid_kind" };
    }
    try {
      switch (kind) {
        case "status":
          return await handleStatus(callback);
        case "markets":
          return await handleMarkets(options, callback);
        case "market":
          return await handleMarket(options, callback);
        case "orderbook":
          return await handleOrderbook(options, callback);
        case "positions":
          return await handlePositions(options, callback);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (callback) await callback({ text, actions: ["POLYMARKET_READ"] });
      return { success: false, text, error: text };
    }
  },
};

export const polymarketOrdersDisabledAction: Action = {
  name: "POLYMARKET_PLACE_ORDER",
  similes: ["POLYMARKET_TRADE", "POLYMARKET_BUY", "POLYMARKET_SELL"],
  description:
    "Explain Polymarket order placement readiness. Signed trading is disabled in this app scaffold.",
  descriptionCompressed: "Report disabled Polymarket trading readiness.",
  validate: async () => true,
  handler: async (_runtime, _message, _state, _options, callback) => {
    const response = await fetchPolymarketJson<PolymarketDisabledResponse>(
      "/api/polymarket/orders",
      { allowErrorStatus: true },
    ).catch((error) => ({
      enabled: false,
      reason: error instanceof Error ? error.message : String(error),
      requiredForTrading: [],
    }));
    const text = `Polymarket order placement is disabled.\nReason: ${
      response.reason
    }${
      response.requiredForTrading.length
        ? `\nRequired env vars: ${response.requiredForTrading.join(", ")}`
        : ""
    }`;
    return {
      ...(await emit(callback, "POLYMARKET_PLACE_ORDER", text, {
        trading: response,
      })),
      success: false,
      error: response.reason,
    };
  },
};

export const polymarketActions: Action[] = [
  polymarketReadAction,
  polymarketOrdersDisabledAction,
];
