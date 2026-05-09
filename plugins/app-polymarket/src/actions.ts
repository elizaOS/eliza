import { Service } from "@elizaos/core";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
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
export const PREDICTION_MARKET_SERVICE_TYPE = "prediction-market" as const;
const POLYMARKET_CONTEXTS = ["finance", "crypto", "prediction-market"] as const;
const POLYMARKET_ACTION_CONTEXTS = [
  ...POLYMARKET_CONTEXTS,
  "payments",
] as const;
const POLYMARKET_ACTION_NAME = "PREDICTION_MARKET";
const POLYMARKET_READ_COMPAT_NAME = "POLYMARKET_READ";
const POLYMARKET_PLACE_ORDER_COMPAT_NAME = "POLYMARKET_PLACE_ORDER";
const POLYMARKET_READ_KEYWORDS = [
  "polymarket",
  "prediction market",
  "market",
  "markets",
  "orderbook",
  "positions",
  "odds",
  "forecast",
  "predicción",
  "mercado",
  "pronóstico",
  "marché",
  "prévision",
  "prognose",
  "markt",
  "mercado",
  "previsão",
  "mercato",
  "previsione",
  "予測市場",
  "オッズ",
  "预测市场",
  "赔率",
  "예측 시장",
  "배당",
] as const;
const POLYMARKET_TRADE_KEYWORDS = [
  ...POLYMARKET_READ_KEYWORDS,
  "buy",
  "sell",
  "trade",
  "order",
  "comprar",
  "vender",
  "orden",
  "acheter",
  "vendre",
  "ordre",
  "kaufen",
  "verkaufen",
  "auftrag",
  "comprare",
  "vendere",
  "注文",
  "買う",
  "売る",
  "买入",
  "卖出",
  "订单",
  "매수",
  "매도",
] as const;

const READ_KINDS = [
  "status",
  "markets",
  "market",
  "orderbook",
  "positions",
] as const;
type PolymarketReadKind = (typeof READ_KINDS)[number];
const POLYMARKET_OPS = ["read", "place_order"] as const;
type PolymarketOp = (typeof POLYMARKET_OPS)[number];
const PREDICTION_MARKET_SUBACTIONS = ["read", "place-order"] as const;
const POLYMARKET_READ_COMPAT_SIMILES = [
  POLYMARKET_READ_COMPAT_NAME,
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
] as const;
const POLYMARKET_PLACE_ORDER_COMPAT_SIMILES = [
  POLYMARKET_PLACE_ORDER_COMPAT_NAME,
  "POLYMARKET_TRADE",
  "POLYMARKET_BUY",
  "POLYMARKET_SELL",
] as const;
const POLYMARKET_READ_OP_ALIASES = new Set([
  ...READ_KINDS,
  ...POLYMARKET_READ_COMPAT_SIMILES.map((name) => name.toLowerCase()),
]);
const POLYMARKET_PLACE_ORDER_OP_ALIASES = new Set([
  ...POLYMARKET_PLACE_ORDER_COMPAT_SIMILES.map((name) => name.toLowerCase()),
  "trade",
  "order",
  "buy",
  "sell",
]);

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

function normalizeOp(value: unknown): PolymarketOp | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((POLYMARKET_OPS as readonly string[]).includes(normalized)) {
    return normalized as PolymarketOp;
  }
  if (POLYMARKET_READ_OP_ALIASES.has(normalized)) {
    return "read";
  }
  if (POLYMARKET_PLACE_ORDER_OP_ALIASES.has(normalized)) {
    return "place_order";
  }
  return null;
}

function readOp(
  options: HandlerOptions | Record<string, unknown> | undefined,
): PolymarketOp | null {
  const rawOp =
    readStringParam(options, "subaction") ??
    readStringParam(options, "op") ??
    readStringParam(options, "operation") ??
    readStringParam(options, "action") ??
    readStringParam(options, "name");
  const explicit = normalizeOp(rawOp);
  if (explicit) return explicit;
  if (readKind(options)) return "read";
  if (
    readStringParam(options, "side") ||
    readStringParam(options, "marketId") ||
    readStringParam(options, "market_id") ||
    readParam(options, "amount") !== undefined
  ) {
    return "place_order";
  }
  return null;
}

function hasSelectedContext(
  state: State | undefined,
  contexts: readonly string[] = POLYMARKET_ACTION_CONTEXTS,
): boolean {
  const selected = new Set<string>();
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string") selected.add(item);
    }
  };
  collect((state?.values as Record<string, unknown> | undefined)?.selectedContexts);
  collect((state?.data as Record<string, unknown> | undefined)?.selectedContexts);
  const contextObject = (state?.data as Record<string, unknown> | undefined)?.contextObject as
    | { trajectoryPrefix?: { selectedContexts?: unknown }; metadata?: { selectedContexts?: unknown } }
    | undefined;
  collect(contextObject?.trajectoryPrefix?.selectedContexts);
  collect(contextObject?.metadata?.selectedContexts);
  return contexts.some((context) => selected.has(context));
}

function hasKeywordIntent(
  message: Memory,
  state: State | undefined,
  keywords: readonly string[],
): boolean {
  const text = [
    typeof message.content?.text === "string" ? message.content.text : "",
    typeof state?.values?.recentMessages === "string" ? state.values.recentMessages : "",
  ]
    .join("\n")
    .toLowerCase();
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
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
  text: string,
  data: Record<string, any>,
): Promise<ActionResult> {
  if (callback) {
    await callback({ text, actions: [POLYMARKET_ACTION_NAME], data });
  }
  return {
    success: true,
    text,
    data: { actionName: POLYMARKET_ACTION_NAME, ...data },
  };
}

async function emitFailure(
  callback: HandlerCallback | undefined,
  text: string,
  error: string,
  data: Record<string, any>,
): Promise<ActionResult> {
  if (callback) {
    await callback({
      text,
      actions: [POLYMARKET_ACTION_NAME],
      data,
    });
  }
  return { success: false, text, error, data };
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
  return emit(callback, text, {
    op: "read" satisfies PolymarketOp,
    compatActionName: POLYMARKET_READ_COMPAT_NAME,
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
  return emit(callback, formatMarkets(response.markets), {
    op: "read" satisfies PolymarketOp,
    compatActionName: POLYMARKET_READ_COMPAT_NAME,
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
    return emitFailure(callback, text, "missing_market_identifier", {
      actionName: POLYMARKET_ACTION_NAME,
      op: "read" satisfies PolymarketOp,
      compatActionName: POLYMARKET_READ_COMPAT_NAME,
      kind: "market" satisfies PolymarketReadKind,
    });
  }
  const query = new URLSearchParams();
  if (id) query.set("id", id);
  if (slug && !id) query.set("slug", slug);
  const response = await fetchPolymarketJson<PolymarketMarketResponse>(
    `/api/polymarket/market?${query.toString()}`,
  );
  return emit(callback, formatMarket(response), {
    op: "read" satisfies PolymarketOp,
    compatActionName: POLYMARKET_READ_COMPAT_NAME,
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
    return emitFailure(callback, text, "missing_token_id", {
      actionName: POLYMARKET_ACTION_NAME,
      op: "read" satisfies PolymarketOp,
      compatActionName: POLYMARKET_READ_COMPAT_NAME,
      kind: "orderbook" satisfies PolymarketReadKind,
    });
  }
  const response = await fetchPolymarketJson<PolymarketOrderbookResponse>(
    `/api/polymarket/orderbook?token_id=${encodeURIComponent(tokenId)}`,
  );
  return emit(callback, formatOrderbook(response), {
    op: "read" satisfies PolymarketOp,
    compatActionName: POLYMARKET_READ_COMPAT_NAME,
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
    return emitFailure(callback, text, "missing_wallet_address", {
      actionName: POLYMARKET_ACTION_NAME,
      op: "read" satisfies PolymarketOp,
      compatActionName: POLYMARKET_READ_COMPAT_NAME,
      kind: "positions" satisfies PolymarketReadKind,
    });
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
  return emit(callback, text, {
    op: "read" satisfies PolymarketOp,
    compatActionName: POLYMARKET_READ_COMPAT_NAME,
    kind: "positions" satisfies PolymarketReadKind,
    positions: response.positions,
    source: response.source,
  });
}

async function handleReadOperation(
  options: HandlerOptions | Record<string, unknown> | undefined,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const kind = readKind(options);
  if (!kind) {
    const text =
      "Provide kind: status | markets | market | orderbook | positions.";
    return emitFailure(callback, text, "missing_or_invalid_kind", {
      actionName: POLYMARKET_ACTION_NAME,
      op: "read" satisfies PolymarketOp,
      compatActionName: POLYMARKET_READ_COMPAT_NAME,
      availableKinds: [...READ_KINDS],
    });
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
    return emitFailure(callback, text, text, {
      actionName: POLYMARKET_ACTION_NAME,
      op: "read" satisfies PolymarketOp,
      compatActionName: POLYMARKET_READ_COMPAT_NAME,
      kind,
    });
  }
}

async function handlePlaceOrderOperation(
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
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
    ...(await emit(callback, text, {
      op: "place_order" satisfies PolymarketOp,
      compatActionName: POLYMARKET_PLACE_ORDER_COMPAT_NAME,
      trading: response,
    })),
    success: false,
    error: response.reason,
  };
}

interface PredictionMarketProviderMetadata {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly supportedSubactions: readonly PolymarketOp[];
  readonly description?: string;
}

interface PredictionMarketProvider extends PredictionMarketProviderMetadata {
  execute(context: {
    readonly options?: HandlerOptions | Record<string, unknown>;
    readonly op: PolymarketOp;
    readonly callback?: HandlerCallback;
  }): Promise<ActionResult>;
}

function normalizeProviderKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function readTarget(
  options: HandlerOptions | Record<string, unknown> | undefined,
): string {
  return (
    readStringParam(options, "target") ??
    readStringParam(options, "provider") ??
    "polymarket"
  );
}

function createPolymarketProvider(): PredictionMarketProvider {
  return {
    name: "polymarket",
    aliases: ["poly-market", "clob"],
    supportedSubactions: ["read", "place_order"],
    description:
      "Polymarket public market reads, orderbook data, positions, and trading readiness.",
    execute: async ({ options, op, callback }) => {
      switch (op) {
        case "read":
          return await handleReadOperation(options, callback);
        case "place_order":
          return await handlePlaceOrderOperation(callback);
      }
    },
  };
}

export class PredictionMarketService extends Service {
  static override serviceType = PREDICTION_MARKET_SERVICE_TYPE;

  override capabilityDescription =
    "Prediction market provider registry; currently registers Polymarket";

  private readonly providers = new Map<string, PredictionMarketProvider>();
  private readonly aliases = new Map<string, string>();

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<PredictionMarketService> {
    const service = new PredictionMarketService(runtime);
    service.registerProvider(createPolymarketProvider());
    return service;
  }

  registerProvider(provider: PredictionMarketProvider): void {
    const key = normalizeProviderKey(provider.name);
    this.providers.set(key, provider);
    for (const alias of [provider.name, ...provider.aliases]) {
      this.aliases.set(normalizeProviderKey(alias), key);
    }
  }

  listProviders(): PredictionMarketProviderMetadata[] {
    return [...this.providers.values()].map((provider) => ({
      name: provider.name,
      aliases: [...provider.aliases],
      supportedSubactions: [...provider.supportedSubactions],
      description: provider.description,
    }));
  }

  async route(args: {
    readonly target?: string;
    readonly op: PolymarketOp;
    readonly options?: HandlerOptions | Record<string, unknown>;
    readonly callback?: HandlerCallback;
  }): Promise<ActionResult> {
    const target = args.target ?? "polymarket";
    const key = this.aliases.get(normalizeProviderKey(target));
    const provider = key ? this.providers.get(key) : undefined;
    if (!provider) {
      const text = `Unsupported prediction market provider "${target}".`;
      await args.callback?.({
        text,
        actions: [POLYMARKET_ACTION_NAME],
        data: {
          actionName: POLYMARKET_ACTION_NAME,
          error: "UNSUPPORTED_PROVIDER",
          providers: this.listProviders(),
        },
      });
      return {
        success: false,
        text,
        error: "UNSUPPORTED_PROVIDER",
        data: {
          actionName: POLYMARKET_ACTION_NAME,
          providers: this.listProviders(),
        },
      };
    }
    if (!provider.supportedSubactions.includes(args.op)) {
      const text = `${provider.name} does not support ${args.op}.`;
      await args.callback?.({
        text,
        actions: [POLYMARKET_ACTION_NAME],
        data: {
          actionName: POLYMARKET_ACTION_NAME,
          error: "UNSUPPORTED_SUBACTION",
          provider: provider.name,
        },
      });
      return {
        success: false,
        text,
        error: "UNSUPPORTED_SUBACTION",
        data: {
          actionName: POLYMARKET_ACTION_NAME,
          provider: provider.name,
        },
      };
    }

    const result = await provider.execute(args);
    return {
      ...result,
      data: {
        ...(result.data ?? {}),
        actionName: POLYMARKET_ACTION_NAME,
        target: provider.name,
        supportedProviders: this.listProviders(),
      },
    };
  }

  override async stop(): Promise<void> {
    this.providers.clear();
    this.aliases.clear();
  }
}

export const polymarketAction: Action = {
  name: POLYMARKET_ACTION_NAME,
  contexts: [...POLYMARKET_ACTION_CONTEXTS],
  contextGate: { anyOf: [...POLYMARKET_ACTION_CONTEXTS] },
  roleGate: { minRole: "USER" },
  similes: [
    ...POLYMARKET_READ_COMPAT_SIMILES,
    ...POLYMARKET_PLACE_ORDER_COMPAT_SIMILES,
  ],
  description:
    "Use registered prediction market providers. target selects the provider; Polymarket is registered today. subaction=read reads public state with kind: status, markets, market, orderbook, or positions. subaction=place-order reports trading readiness; signed order placement is disabled in this app scaffold.",
  descriptionCompressed:
    "Prediction market router: target polymarket; subaction read or place-order.",
  parameters: [
    {
      name: "target",
      description: "Prediction market provider.",
      required: false,
      schema: { type: "string", enum: ["polymarket"], default: "polymarket" },
    },
    {
      name: "subaction",
      description: "Prediction market operation: read or place-order.",
      required: false,
      schema: { type: "string", enum: [...PREDICTION_MARKET_SUBACTIONS] },
    },
    {
      name: "kind",
      description:
        "read only: status | markets | market | orderbook | positions.",
      required: false,
      schema: { type: "string", enum: [...READ_KINDS] },
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
    {
      name: "side",
      description: "place_order only: intended side, buy or sell.",
      required: false,
      schema: { type: "string", enum: ["buy", "sell"] },
    },
    {
      name: "marketId",
      description: "place_order only: Polymarket market id or condition id.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "amount",
      description: "place_order only: intended order amount.",
      required: false,
      schema: { type: "number" },
    },
  ],
  validate: async (_runtime, message: Memory, state?: State) =>
    hasSelectedContext(state) ||
    hasKeywordIntent(message, state, POLYMARKET_READ_KEYWORDS) ||
    hasKeywordIntent(message, state, POLYMARKET_TRADE_KEYWORDS),
  handler: async (runtime, _message, _state, options, callback) => {
    const op = readOp(options);
    if (!op) {
      const text =
        "Provide subaction: read | place-order. For read, also provide kind: status | markets | market | orderbook | positions.";
      return emitFailure(callback, text, "missing_or_invalid_op", {
        actionName: POLYMARKET_ACTION_NAME,
        availableSubactions: [...PREDICTION_MARKET_SUBACTIONS],
      });
    }
    const service = runtime.getService(
      PREDICTION_MARKET_SERVICE_TYPE,
    ) as PredictionMarketService | null;
    if (!service || typeof service.route !== "function") {
      const text = "Prediction market service is not available.";
      return emitFailure(callback, text, "service_unavailable", {
        actionName: POLYMARKET_ACTION_NAME,
      });
    }
    return service.route({
      target: readTarget(options),
      op,
      options,
      callback,
    });
  },
};

export const predictionMarketAction = polymarketAction;
export const polymarketActions: Action[] = [predictionMarketAction];
