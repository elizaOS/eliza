import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  ProviderDataRecord,
  State,
} from "@elizaos/core";
import { Service } from "@elizaos/core";
import { resolveApiToken, resolveDesktopApiPort } from "@elizaos/shared";
import type {
  HyperliquidMarket,
  HyperliquidMarketsResponse,
  HyperliquidOrdersResponse,
  HyperliquidPositionsResponse,
  HyperliquidStatusResponse,
} from "../hyperliquid-contracts";

const ACTION_TIMEOUT_MS = 15_000;
export const PERPETUAL_MARKET_SERVICE_TYPE = "perpetual-market" as const;
const HYPERLIQUID_CONTEXTS = ["finance", "crypto", "trading"] as const;
const HYPERLIQUID_ACTION_CONTEXTS = [
  ...HYPERLIQUID_CONTEXTS,
  "payments",
] as const;
const PERPETUAL_MARKET_ACTION_NAME = "PERPETUAL_MARKET";
const HYPERLIQUID_READ_COMPAT_NAME = "HYPERLIQUID_READ";
const HYPERLIQUID_PLACE_ORDER_COMPAT_NAME = "HYPERLIQUID_PLACE_ORDER";
const HYPERLIQUID_READ_KEYWORDS = [
  "hyperliquid",
  "perp",
  "perps",
  "perpetual",
  "perpetuals",
  "funding",
  "funding rate",
  "futures",
  "leverage",
  "liquidation",
  "perpétuel",
  "perpetuo",
  "perpetuelle",
  "ewig",
  "永続",
  "永久",
  "永续",
  "선물",
  "무기한",
] as const;
const HYPERLIQUID_TRADE_KEYWORDS = [
  ...HYPERLIQUID_READ_KEYWORDS,
  "buy",
  "sell",
  "trade",
  "order",
  "long",
  "short",
  "open position",
  "close position",
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
  "positions",
  "funding",
] as const;
type HyperliquidReadKind = (typeof READ_KINDS)[number];
const HYPERLIQUID_OPS = ["read", "place_order"] as const;
type HyperliquidOp = (typeof HYPERLIQUID_OPS)[number];
const HYPERLIQUID_READ_COMPAT_SIMILES = [
  "HYPERLIQUID",
  "PERP_MARKET",
  HYPERLIQUID_READ_COMPAT_NAME,
  "HYPERLIQUID_STATUS",
  "HYPERLIQUID_READINESS",
  "HYPERLIQUID_HEALTH",
  "HYPERLIQUID_GET_MARKETS",
  "HYPERLIQUID_MARKETS",
  "HYPERLIQUID_GET_MARKET",
  "HYPERLIQUID_MARKET",
  "HYPERLIQUID_GET_POSITIONS",
  "HYPERLIQUID_POSITIONS",
  "HYPERLIQUID_FUNDING",
] as const;
const HYPERLIQUID_PLACE_ORDER_COMPAT_SIMILES = [
  HYPERLIQUID_PLACE_ORDER_COMPAT_NAME,
  "HYPERLIQUID_TRADE",
  "HYPERLIQUID_BUY",
  "HYPERLIQUID_SELL",
  "HYPERLIQUID_LONG",
  "HYPERLIQUID_SHORT",
] as const;
const HYPERLIQUID_READ_OP_ALIASES = new Set([
  ...READ_KINDS,
  ...HYPERLIQUID_READ_COMPAT_SIMILES.map((name) => name.toLowerCase()),
]);
const HYPERLIQUID_PLACE_ORDER_OP_ALIASES = new Set([
  ...HYPERLIQUID_PLACE_ORDER_COMPAT_SIMILES.map((name) => name.toLowerCase()),
  "trade",
  "order",
  "buy",
  "sell",
  "long",
  "short",
]);

const FUNDING_NOT_WIRED_REASON =
  "Hyperliquid funding-rate reads are not yet wired to a route in the native app. Use kind=markets for perpetual metadata or kind=status for credential readiness.";

const PLACE_ORDER_DISABLED_REASON =
  "Signed Hyperliquid exchange execution is disabled in the native app. Use the Hyperliquid UI or a dedicated signer to place orders.";

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

function readKind(
  options: HandlerOptions | Record<string, unknown> | undefined,
): HyperliquidReadKind | null {
  const raw = readStringParam(options, "kind");
  if (!raw) return null;
  const normalized = raw.toLowerCase() as HyperliquidReadKind;
  return (READ_KINDS as readonly string[]).includes(normalized)
    ? normalized
    : null;
}

function normalizeOp(value: unknown): HyperliquidOp | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if ((HYPERLIQUID_OPS as readonly string[]).includes(normalized)) {
    return normalized as HyperliquidOp;
  }
  if (HYPERLIQUID_READ_OP_ALIASES.has(normalized)) {
    return "read";
  }
  if (HYPERLIQUID_PLACE_ORDER_OP_ALIASES.has(normalized)) {
    return "place_order";
  }
  return null;
}

function readOp(
  options: HandlerOptions | Record<string, unknown> | undefined,
): HyperliquidOp | null {
  const rawOp =
    readStringParam(options, "action") ??
    readStringParam(options, "subaction") ??
    readStringParam(options, "op") ??
    readStringParam(options, "operation") ??
    readStringParam(options, "name");
  const explicit = normalizeOp(rawOp);
  if (explicit) return explicit;
  if (readKind(options)) return "read";
  if (
    readStringParam(options, "side") ||
    readStringParam(options, "coin") ||
    readStringParam(options, "asset") ||
    readParam(options, "size") !== undefined
  ) {
    return "place_order";
  }
  return null;
}

function hasSelectedContext(
  state: State | undefined,
  contexts: readonly string[] = HYPERLIQUID_ACTION_CONTEXTS,
): boolean {
  const selected = new Set<string>();
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string") selected.add(item);
    }
  };
  collect(
    (state?.values as Record<string, unknown> | undefined)?.selectedContexts,
  );
  collect(
    (state?.data as Record<string, unknown> | undefined)?.selectedContexts,
  );
  const contextObject = (state?.data as Record<string, unknown> | undefined)
    ?.contextObject as
    | {
        trajectoryPrefix?: { selectedContexts?: unknown };
        metadata?: { selectedContexts?: unknown };
      }
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
    typeof state?.values?.recentMessages === "string"
      ? state.values.recentMessages
      : "",
  ]
    .join("\n")
    .toLowerCase();
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

async function fetchHyperliquidJson<T>(path: string): Promise<T> {
  const response = await fetch(`${getApiBase()}${path}`, {
    headers: { accept: "application/json", ...buildAuthHeaders() },
    signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
  });
  const payload = (await response.json().catch(() => null)) as T;
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error?: unknown }).error)
        : `Hyperliquid API request failed with ${response.status}`;
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
    await callback({ text, actions: [PERPETUAL_MARKET_ACTION_NAME], data });
  }
  return {
    success: true,
    text,
    data: { actionName: PERPETUAL_MARKET_ACTION_NAME, ...data },
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
      actions: [PERPETUAL_MARKET_ACTION_NAME],
      data,
    });
  }
  return { success: false, text, error, data };
}

function marketLine(market: HyperliquidMarket): string {
  const leverage =
    market.maxLeverage !== null ? ` maxLeverage ${market.maxLeverage}x` : "";
  const isolated = market.onlyIsolated ? " isolated-only" : "";
  return `- ${market.name}${leverage}${isolated}`;
}

function formatMarkets(markets: readonly HyperliquidMarket[]): string {
  if (markets.length === 0) return "No active Hyperliquid markets found.";
  const active = markets.filter((m) => !m.isDelisted);
  return `Hyperliquid perpetual markets (${active.length} active):\n${active
    .slice(0, 20)
    .map(marketLine)
    .join("\n")}`;
}

function formatMarket(market: HyperliquidMarket | null): string {
  if (!market) return "No matching Hyperliquid market found.";
  return [
    `Hyperliquid ${market.name} perpetual`,
    `Status: ${market.isDelisted ? "delisted" : "active"}`,
    `Size decimals: ${market.szDecimals}`,
    `Max leverage: ${market.maxLeverage ?? "n/a"}`,
    `Isolated only: ${market.onlyIsolated ? "yes" : "no"}`,
  ].join("\n");
}

async function handleStatus(
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const status = await fetchHyperliquidJson<HyperliquidStatusResponse>(
    "/api/hyperliquid/status",
  );
  const text = [
    `Hyperliquid public reads: ${status.publicReadReady ? "ready" : "not ready"}`,
    `Account reads: ${status.readiness.accountReads ? "ready" : "not ready"}`,
    `Signer: ${status.signerReady ? "ready" : "not ready"}`,
    `Execution: disabled`,
    status.executionBlockedReason
      ? `Reason: ${status.executionBlockedReason}`
      : null,
    `Credential mode: ${status.credentialMode}`,
    status.accountAddress ? `Account: ${status.accountAddress}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
  return emit(callback, text, {
    op: "read" satisfies HyperliquidOp,
    compatActionName: HYPERLIQUID_READ_COMPAT_NAME,
    kind: "status" satisfies HyperliquidReadKind,
    status,
  });
}

async function handleMarkets(
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const response = await fetchHyperliquidJson<HyperliquidMarketsResponse>(
    "/api/hyperliquid/markets",
  );
  return emit(callback, formatMarkets(response.markets), {
    op: "read" satisfies HyperliquidOp,
    compatActionName: HYPERLIQUID_READ_COMPAT_NAME,
    kind: "markets" satisfies HyperliquidReadKind,
    markets: response.markets,
    source: response.source,
    fetchedAt: response.fetchedAt,
  });
}

async function handleMarket(
  options: HandlerOptions | Record<string, unknown> | undefined,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const coin =
    readStringParam(options, "coin") ??
    readStringParam(options, "asset") ??
    readStringParam(options, "name") ??
    readStringParam(options, "symbol");
  if (!coin) {
    const text =
      "Provide a Hyperliquid coin/asset symbol (e.g. BTC, ETH, SOL).";
    return emitFailure(callback, text, "missing_market_identifier", {
      actionName: PERPETUAL_MARKET_ACTION_NAME,
      op: "read" satisfies HyperliquidOp,
      compatActionName: HYPERLIQUID_READ_COMPAT_NAME,
      kind: "market" satisfies HyperliquidReadKind,
    });
  }
  const response = await fetchHyperliquidJson<HyperliquidMarketsResponse>(
    "/api/hyperliquid/markets",
  );
  const target = coin.toUpperCase();
  const market =
    response.markets.find((m) => m.name.toUpperCase() === target) ?? null;
  return emit(callback, formatMarket(market), {
    op: "read" satisfies HyperliquidOp,
    compatActionName: HYPERLIQUID_READ_COMPAT_NAME,
    kind: "market" satisfies HyperliquidReadKind,
    market,
    source: response.source,
    fetchedAt: response.fetchedAt,
  });
}

async function handlePositions(
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const response = await fetchHyperliquidJson<HyperliquidPositionsResponse>(
    "/api/hyperliquid/positions",
  );
  if (!response.accountAddress) {
    const text = response.readBlockedReason
      ? `Hyperliquid positions unavailable: ${response.readBlockedReason}`
      : "Hyperliquid positions unavailable: no account address configured.";
    return emit(callback, text, {
      op: "read" satisfies HyperliquidOp,
      compatActionName: HYPERLIQUID_READ_COMPAT_NAME,
      kind: "positions" satisfies HyperliquidReadKind,
      accountAddress: null,
      positions: [],
      readBlockedReason: response.readBlockedReason,
    });
  }
  const text =
    response.positions.length === 0
      ? `No Hyperliquid positions for ${response.accountAddress}.`
      : `Hyperliquid positions for ${response.accountAddress}:\n${response.positions
          .slice(0, 12)
          .map(
            (position) =>
              `- ${position.coin}: size ${position.size}` +
              (position.entryPx ? ` entry ${position.entryPx}` : "") +
              (position.unrealizedPnl
                ? ` uPnL ${position.unrealizedPnl}`
                : "") +
              (position.leverageValue !== null
                ? ` ${position.leverageType ?? "leverage"} ${position.leverageValue}x`
                : ""),
          )
          .join("\n")}`;
  return emit(callback, text, {
    op: "read" satisfies HyperliquidOp,
    compatActionName: HYPERLIQUID_READ_COMPAT_NAME,
    kind: "positions" satisfies HyperliquidReadKind,
    accountAddress: response.accountAddress,
    positions: response.positions,
    fetchedAt: response.fetchedAt,
  });
}

async function handleFunding(
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  return emit(callback, FUNDING_NOT_WIRED_REASON, {
    op: "read" satisfies HyperliquidOp,
    compatActionName: HYPERLIQUID_READ_COMPAT_NAME,
    kind: "funding" satisfies HyperliquidReadKind,
    notWired: true,
    reason: FUNDING_NOT_WIRED_REASON,
  });
}

async function handleReadOperation(
  options: HandlerOptions | Record<string, unknown> | undefined,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const kind = readKind(options);
  if (!kind) {
    const text =
      "Provide kind: status | markets | market | positions | funding.";
    return emitFailure(callback, text, "missing_or_invalid_kind", {
      actionName: PERPETUAL_MARKET_ACTION_NAME,
      op: "read" satisfies HyperliquidOp,
      compatActionName: HYPERLIQUID_READ_COMPAT_NAME,
      availableKinds: [...READ_KINDS],
    });
  }
  try {
    switch (kind) {
      case "status":
        return await handleStatus(callback);
      case "markets":
        return await handleMarkets(callback);
      case "market":
        return await handleMarket(options, callback);
      case "positions":
        return await handlePositions(callback);
      case "funding":
        return await handleFunding(callback);
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return emitFailure(callback, text, text, {
      actionName: PERPETUAL_MARKET_ACTION_NAME,
      op: "read" satisfies HyperliquidOp,
      compatActionName: HYPERLIQUID_READ_COMPAT_NAME,
      kind,
    });
  }
}

async function handlePlaceOrderOperation(
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  let status: HyperliquidStatusResponse | null = null;
  try {
    status = await fetchHyperliquidJson<HyperliquidStatusResponse>(
      "/api/hyperliquid/status",
    );
  } catch {
    status = null;
  }
  const reason = status?.executionBlockedReason ?? PLACE_ORDER_DISABLED_REASON;
  const text = `Hyperliquid order placement is disabled.\nReason: ${reason}`;
  return {
    ...(await emit(callback, text, {
      op: "place_order" satisfies HyperliquidOp,
      compatActionName: HYPERLIQUID_PLACE_ORDER_COMPAT_NAME,
      trading: {
        enabled: false,
        reason,
        credentialMode: status?.credentialMode ?? "none",
        signerReady: status?.signerReady ?? false,
      },
    })),
    success: false,
    error: reason,
  };
}

async function handleOrders(
  callback: HandlerCallback | undefined,
): Promise<ActionResult | null> {
  return await emit(
    callback,
    "Hyperliquid open-order reads (kind=orders) are not exposed in this read action; use kind=positions for held perps or the Hyperliquid UI for working orders.",
    {
      op: "read" satisfies HyperliquidOp,
      compatActionName: HYPERLIQUID_READ_COMPAT_NAME,
      kind: "orders",
      notExposed: true,
    },
  );
}

void handleOrders;
void ({} as HyperliquidOrdersResponse);

interface PerpetualMarketProviderMetadata {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly supportedSubactions: readonly HyperliquidOp[];
  readonly description?: string;
}

interface PerpetualMarketProvider extends PerpetualMarketProviderMetadata {
  execute(context: {
    readonly options?: HandlerOptions | Record<string, unknown>;
    readonly op: HyperliquidOp;
    readonly callback?: HandlerCallback;
  }): Promise<ActionResult>;
}

function normalizeProviderKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function readTarget(
  options: HandlerOptions | Record<string, unknown> | undefined,
): string {
  return (
    readStringParam(options, "target") ??
    readStringParam(options, "provider") ??
    "hyperliquid"
  );
}

function createHyperliquidProvider(): PerpetualMarketProvider {
  return {
    name: "hyperliquid",
    aliases: ["hl", "hyperliquid-perps"],
    supportedSubactions: ["read", "place_order"],
    description:
      "Hyperliquid perpetual market discovery, position reads, and execution readiness.",
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

export class PerpetualMarketService extends Service {
  static override serviceType = PERPETUAL_MARKET_SERVICE_TYPE;

  override capabilityDescription =
    "Perpetual market provider registry; currently registers Hyperliquid";

  private readonly providers = new Map<string, PerpetualMarketProvider>();
  private readonly aliases = new Map<string, string>();

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<PerpetualMarketService> {
    const service = new PerpetualMarketService(runtime);
    service.registerProvider(createHyperliquidProvider());
    return service;
  }

  registerProvider(provider: PerpetualMarketProvider): void {
    const key = normalizeProviderKey(provider.name);
    this.providers.set(key, provider);
    for (const alias of [provider.name, ...provider.aliases]) {
      this.aliases.set(normalizeProviderKey(alias), key);
    }
  }

  listProviders(): PerpetualMarketProviderMetadata[] {
    return [...this.providers.values()].map((provider) => ({
      name: provider.name,
      aliases: [...provider.aliases],
      supportedSubactions: [...provider.supportedSubactions],
      description: provider.description,
    }));
  }

  async route(args: {
    readonly target?: string;
    readonly op: HyperliquidOp;
    readonly options?: HandlerOptions | Record<string, unknown>;
    readonly callback?: HandlerCallback;
  }): Promise<ActionResult> {
    const target = args.target ?? "hyperliquid";
    const key = this.aliases.get(normalizeProviderKey(target));
    const provider = key ? this.providers.get(key) : undefined;
    if (!provider) {
      const text = `Unsupported perpetual market provider "${target}".`;
      await args.callback?.({
        text,
        actions: [PERPETUAL_MARKET_ACTION_NAME],
        data: {
          actionName: PERPETUAL_MARKET_ACTION_NAME,
          error: "UNSUPPORTED_PROVIDER",
          providers: this.listProviders(),
        } as any,
      });
      return {
        success: false,
        text,
        error: "UNSUPPORTED_PROVIDER",
        data: {
          actionName: PERPETUAL_MARKET_ACTION_NAME,
          providers: this.listProviders(),
        } as ProviderDataRecord,
      };
    }
    if (!provider.supportedSubactions.includes(args.op)) {
      const text = `${provider.name} does not support ${args.op}.`;
      await args.callback?.({
        text,
        actions: [PERPETUAL_MARKET_ACTION_NAME],
        data: {
          actionName: PERPETUAL_MARKET_ACTION_NAME,
          error: "UNSUPPORTED_SUBACTION",
          provider: provider.name,
        },
      });
      return {
        success: false,
        text,
        error: "UNSUPPORTED_SUBACTION",
        data: {
          actionName: PERPETUAL_MARKET_ACTION_NAME,
          provider: provider.name,
        },
      };
    }

    const result = await provider.execute(args);
    return {
      ...result,
      data: {
        ...(result.data ?? {}),
        actionName: PERPETUAL_MARKET_ACTION_NAME,
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

export const perpetualMarketAction: Action = {
  name: "PERPETUAL_MARKET",
  contexts: [...HYPERLIQUID_ACTION_CONTEXTS],
  contextGate: { anyOf: [...HYPERLIQUID_ACTION_CONTEXTS] },
  roleGate: { minRole: "USER" },
  similes: [
    ...HYPERLIQUID_READ_COMPAT_SIMILES,
    ...HYPERLIQUID_PLACE_ORDER_COMPAT_SIMILES,
  ],
  description:
    "Use registered perpetual market providers. target selects the provider; Hyperliquid is registered today. action=read reads public state with kind: status, markets, market, positions, or funding. action=place_order reports trading readiness; signed order placement is disabled in this app scaffold.",
  descriptionCompressed:
    "Perpetual market router: target hyperliquid; action read or place_order.",
  parameters: [
    {
      name: "target",
      description: "Perpetual market provider.",
      required: false,
      schema: {
        type: "string",
        enum: ["hyperliquid"],
        default: "hyperliquid",
      },
    },
    {
      name: "action",
      description: "Perpetual market operation: read or place_order.",
      required: false,
      schema: { type: "string", enum: ["read", "place_order"] },
    },
    {
      name: "subaction",
      description: "Alias for action (read | place_order | place-order).",
      required: false,
      schema: { type: "string", enum: ["read", "place_order", "place-order"] },
    },
    {
      name: "kind",
      description:
        "read only: status | markets | market | positions | funding.",
      required: false,
      schema: {
        type: "string",
        enum: ["status", "markets", "market", "positions", "funding"],
      },
    },
    {
      name: "coin",
      description: "market only: Hyperliquid coin/asset symbol (e.g. BTC).",
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
      name: "asset",
      description: "place_order only: Hyperliquid asset symbol.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "size",
      description: "place_order only: intended order size.",
      required: false,
      schema: { type: "number" },
    },
  ],
  validate: async (_runtime, message: Memory, state?: State) =>
    hasSelectedContext(state) ||
    hasKeywordIntent(message, state, HYPERLIQUID_READ_KEYWORDS) ||
    hasKeywordIntent(message, state, HYPERLIQUID_TRADE_KEYWORDS),
  handler: async (runtime, _message, _state, options, callback) => {
    const op = readOp(options);
    if (!op) {
      const text =
        "Provide action: read | place_order. For read, also provide kind: status | markets | market | positions | funding.";
      return emitFailure(callback, text, "missing_or_invalid_op", {
        actionName: PERPETUAL_MARKET_ACTION_NAME,
        availableActions: [...HYPERLIQUID_OPS],
      });
    }
    const service = runtime.getService(
      PERPETUAL_MARKET_SERVICE_TYPE,
    ) as PerpetualMarketService | null;
    if (!service || typeof service.route !== "function") {
      const text = "Perpetual market service is not available.";
      return emitFailure(callback, text, "service_unavailable", {
        actionName: PERPETUAL_MARKET_ACTION_NAME,
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

export const hyperliquidActions: Action[] = [perpetualMarketAction];
