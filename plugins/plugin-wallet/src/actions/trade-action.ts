/**
 * Native trading router for governed Steward venue execution. The action keeps
 * Eliza on the neutral contract boundary: it inspects Steward capability,
 * sessions, and accounts, then submits only normalized Hyperliquid or
 * Polymarket order intent after core confirmation has resolved.
 */
import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  ProviderDataRecord,
  ProviderValue,
  State,
} from "@elizaos/core";
import { requireTradeOrderConfirmation } from "../security/trade-confirmation.js";
import { StewardTradingService } from "../services/steward-trading-service.js";
import type {
  HyperliquidSubmitOrderRequest,
  PolymarketSubmitOrderRequest,
  SubmitOrderRequest,
  TradeEnvelope,
  Venue,
} from "../types/trade.js";

const VENUES = ["hyperliquid", "polymarket"] as const;
const OPERATIONS = [
  "inspect_account",
  "inspect_session",
  "submit_order",
] as const;
const POLYMARKET_TICK_SIZES = ["0.1", "0.01", "0.001", "0.0001"] as const;

type TradeOperation = (typeof OPERATIONS)[number];
type ParsedTradeParams =
  | { operation: "inspect_account"; venue: Venue }
  | { operation: "inspect_session"; sessionId: string }
  | { operation: "submit_order"; order: SubmitOrderRequest };
type TradeActionOutcome =
  | "policy_denied"
  | "session_required"
  | "rejected"
  | "not_attempted"
  | "unknown";

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return undefined;
}

function venueValue(value: unknown): Venue | undefined {
  const normalized = stringValue(value)?.toLowerCase();
  return (VENUES as readonly string[]).includes(normalized ?? "")
    ? (normalized as Venue)
    : undefined;
}

function operationValue(value: unknown): TradeOperation | undefined {
  const normalized = stringValue(value)
    ?.toLowerCase()
    .replace(/[.\s-]+/g, "_");
  return (OPERATIONS as readonly string[]).includes(normalized ?? "")
    ? (normalized as TradeOperation)
    : undefined;
}

function rawParams(
  message: Memory,
  state?: State,
  options?: HandlerOptions | Record<string, unknown>,
): Record<string, unknown> {
  const optionRecord = objectRecord(options);
  const optionParams = objectRecord(optionRecord?.parameters);
  if (optionParams) return optionParams;
  if (optionRecord && ("operation" in optionRecord || "venue" in optionRecord))
    return optionRecord;
  const stateRecord = objectRecord(state);
  const stateParams = objectRecord(stateRecord?.tradeRouterParams);
  if (stateParams) return stateParams;
  return objectRecord(message.content) ?? {};
}

function requireVenue(raw: Record<string, unknown>): Venue {
  const venue = venueValue(raw.venue ?? raw.marketVenue ?? raw.exchange);
  if (!venue) {
    throw new Error("venue must be hyperliquid or polymarket");
  }
  return venue;
}

function requireSide(value: unknown): "buy" | "sell" {
  const side = stringValue(value)?.toLowerCase();
  if (side === "buy" || side === "sell") return side;
  throw new Error("side must be buy or sell");
}

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = stringValue(raw[key]);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function requireNumber(raw: Record<string, unknown>, key: string): number {
  const value = numberValue(raw[key]);
  if (value === undefined) throw new Error(`${key} must be a number`);
  return value;
}

function parseOrder(raw: Record<string, unknown>): SubmitOrderRequest {
  const venue = requireVenue(raw);
  const sessionId = requireString(raw, "sessionId");
  const side = requireSide(raw.side);
  if (venue === "hyperliquid") {
    const order: HyperliquidSubmitOrderRequest = {
      venue,
      sessionId,
      coin: requireString(raw, "coin"),
      side,
      size: requireNumber(raw, "size"),
      limitPx: stringValue(raw.limitPx) ?? numberValue(raw.limitPx),
      leverage: numberValue(raw.leverage),
      reduceOnly: booleanValue(raw.reduceOnly),
      tif: stringValue(raw.tif) as HyperliquidSubmitOrderRequest["tif"],
    };
    if (order.tif && !["Alo", "Ioc", "Gtc"].includes(order.tif)) {
      throw new Error("tif must be Alo, Ioc, or Gtc");
    }
    return order;
  }
  const tickSize = stringValue(raw.tickSize);
  if (
    tickSize &&
    !(POLYMARKET_TICK_SIZES as readonly string[]).includes(tickSize)
  ) {
    throw new Error("tickSize must be 0.1, 0.01, 0.001, or 0.0001");
  }
  return {
    venue,
    sessionId,
    tokenId: requireString(raw, "tokenId"),
    side,
    amount: stringValue(raw.amount) ?? requireNumber(raw, "amount"),
    price: stringValue(raw.price) ?? requireNumber(raw, "price"),
    tickSize: tickSize as PolymarketSubmitOrderRequest["tickSize"],
    negRisk: booleanValue(raw.negRisk),
  };
}

function parseTradeParams(raw: Record<string, unknown>): ParsedTradeParams {
  const operation = operationValue(
    raw.operation ?? raw.action ?? raw.subaction,
  );
  if (!operation) throw new Error("operation is required");
  if (operation === "inspect_account") {
    return { operation, venue: requireVenue(raw) };
  }
  if (operation === "inspect_session") {
    return { operation, sessionId: requireString(raw, "sessionId") };
  }
  return { operation, order: parseOrder(raw) };
}

function serviceFromRuntime(
  runtime: IAgentRuntime,
): StewardTradingService | null {
  const service = runtime.getService(StewardTradingService.serviceType);
  if (
    service &&
    typeof (service as StewardTradingService).capability === "function" &&
    typeof (service as StewardTradingService).resolveAccount === "function" &&
    typeof (service as StewardTradingService).getSession === "function" &&
    typeof (service as StewardTradingService).submitOrder === "function"
  ) {
    return service as StewardTradingService;
  }
  return null;
}

function providerValue(value: unknown): ProviderValue {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => providerValue(item));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        providerValue(item),
      ]),
    );
  }
  return String(value);
}

function providerRecord(value: Record<string, unknown>): ProviderDataRecord {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, providerValue(item)]),
  );
}

function actionOutcome<T>(envelope: TradeEnvelope<T>): TradeActionOutcome {
  if (envelope.ok) return "not_attempted";
  if (envelope.error === "SESSION_REQUIRED") return "session_required";
  return envelope.outcome;
}

function failureData<T>(
  envelope: Extract<TradeEnvelope<T>, { ok: false }>,
  extra: Record<string, unknown> = {},
): ProviderDataRecord {
  const outcome = actionOutcome(envelope);
  return providerRecord({
    success: false,
    outcome,
    error: envelope.error,
    detail: envelope.detail,
    retryable: envelope.retryable,
    retrySafe: outcome === "not_attempted",
    pollRequired: outcome === "unknown",
    doNotRetry: outcome === "unknown",
    retryAfterMs: envelope.retryAfterMs,
    policy: envelope.policy,
    ...extra,
  });
}

function failureText<T>(envelope: Extract<TradeEnvelope<T>, { ok: false }>) {
  const outcome = actionOutcome(envelope);
  if (outcome === "unknown") {
    return `${envelope.detail} Poll Steward for the order status; do not resubmit this order intent.`;
  }
  if (outcome === "not_attempted") {
    return `${envelope.detail} No venue submission was attempted; it is safe to retry after correcting the cause.`;
  }
  return envelope.detail;
}

function orderPreview(order: SubmitOrderRequest): string {
  if (order.venue === "hyperliquid") {
    return `Submit Hyperliquid ${order.side} ${order.size} ${order.coin}${order.limitPx === undefined ? "" : ` at ${order.limitPx}`} under governed session ${order.sessionId}? Reply yes to submit or no to cancel.`;
  }
  return `Submit Polymarket ${order.side} ${order.amount} token ${order.tokenId} at ${order.price} under governed session ${order.sessionId}? Reply yes to submit or no to cancel.`;
}

async function inspectAccount(
  service: StewardTradingService,
  venue: Venue,
): Promise<ActionResult> {
  const result = await service.resolveAccount(venue);
  if (!result.ok) {
    return {
      success: false,
      text: failureText(result),
      data: failureData(result, { venue }),
      values: { tradeOutcome: actionOutcome(result), tradeVenue: venue },
    };
  }
  const text = `${venue} governed account is active.`;
  return {
    success: true,
    text,
    userFacingText: text,
    verifiedUserFacing: true,
    data: providerRecord({ success: true, venue, account: result.data }),
    values: { tradeOutcome: "not_attempted", tradeVenue: venue },
  };
}

async function inspectSession(
  service: StewardTradingService,
  sessionId: string,
): Promise<ActionResult> {
  const result = await service.getSession(sessionId);
  if (!result.ok) {
    return {
      success: false,
      text: failureText(result),
      data: failureData(result, { sessionId }),
      values: { tradeOutcome: actionOutcome(result) },
    };
  }
  const text = `Governed ${result.data.venue ?? "trade"} session ${result.data.sessionId} is ${result.data.status ?? "available"}.`;
  return {
    success: true,
    text,
    userFacingText: text,
    verifiedUserFacing: true,
    data: providerRecord({ success: true, session: result.data }),
    values: {
      tradeOutcome: "not_attempted",
      tradeVenue: result.data.venue,
    },
  };
}

async function submitOrder(
  runtime: IAgentRuntime,
  message: Memory,
  service: StewardTradingService,
  order: SubmitOrderRequest,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const account = await service.resolveAccount(order.venue);
  if (!account.ok) {
    return {
      success: false,
      text: failureText(account),
      data: failureData(account, { venue: order.venue }),
      values: {
        tradeOutcome: actionOutcome(account),
        tradeVenue: order.venue,
      },
    };
  }

  const decision = await requireTradeOrderConfirmation({
    runtime,
    message,
    order,
    prompt: orderPreview(order),
    callback,
  });
  if (decision.status === "pending") {
    return {
      success: true,
      text: orderPreview(order),
      userFacingText: orderPreview(order),
      verifiedUserFacing: true,
      data: providerRecord({
        requiresConfirmation: true,
        confirmationStatus: "pending",
        awaitingUserInput: true,
        venue: order.venue,
        sessionId: order.sessionId,
      }),
      values: {
        tradeActionPrepared: true,
        tradeActionSucceeded: false,
        tradeVenue: order.venue,
      },
    };
  }
  if (decision.status !== "confirmed") {
    return {
      success: true,
      text: "Trade order cancelled.",
      userFacingText: "Trade order cancelled.",
      verifiedUserFacing: true,
      data: providerRecord({
        confirmationStatus: "cancelled",
        venue: order.venue,
        sessionId: order.sessionId,
      }),
      values: {
        tradeActionPrepared: false,
        tradeActionSucceeded: false,
        tradeVenue: order.venue,
      },
    };
  }

  const { idempotencyKey } = decision.metadata;
  const result = await service.submitOrder({ ...order, idempotencyKey });
  if (!result.ok) {
    return {
      success: false,
      text: failureText(result),
      data: failureData(result, {
        venue: order.venue,
        sessionId: order.sessionId,
        idempotencyKey,
      }),
      values: {
        tradeActionSucceeded: false,
        tradeOutcome: actionOutcome(result),
        tradeVenue: order.venue,
      },
    };
  }
  const text = `Submitted ${order.venue} order ${result.data.orderId}.`;
  return {
    success: true,
    text,
    userFacingText: text,
    verifiedUserFacing: true,
    data: providerRecord({
      success: true,
      outcome: "submitted",
      venue: order.venue,
      order: result.data,
      idempotencyKey,
    }),
    values: {
      tradeActionSucceeded: true,
      tradeVenue: order.venue,
      tradeOrderId: result.data.orderId,
    },
  };
}

export const tradeRouterAction: Action = {
  name: "TRADE",
  description:
    "Inspect governed Steward trading accounts/sessions and submit confirmed order intent for Hyperliquid or Polymarket. Use operation=inspect_account, inspect_session, or submit_order. Order submission requires a separate user yes confirmation and never accepts venue SDK payloads or credentials.",
  descriptionCompressed:
    "TRADE inspect_account|inspect_session|submit_order via Steward for Hyperliquid/Polymarket; submit requires confirmation",
  contexts: ["finance", "crypto", "wallet"],
  contextGate: { anyOf: ["finance", "crypto", "wallet"] },
  roleGate: { minRole: "ADMIN" },
  similes: [
    "STEWARD_TRADE",
    "HYPERLIQUID_TRADE",
    "POLYMARKET_TRADE",
    "TRADE_ORDER",
    "TRADING_ACCOUNT",
  ],
  parameters: [
    {
      name: "operation",
      description:
        "Trading operation: inspect_account, inspect_session, or submit_order.",
      required: true,
      schema: { type: "string", enum: [...OPERATIONS] },
    },
    {
      name: "venue",
      description: "Venue for account/order operations.",
      required: false,
      schema: { type: "string", enum: [...VENUES] },
    },
    {
      name: "sessionId",
      description: "Governed Steward trading session id.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "side",
      description: "Order side for submit_order.",
      required: false,
      schema: { type: "string", enum: ["buy", "sell"] },
    },
    {
      name: "coin",
      description: "Hyperliquid coin symbol.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "size",
      description: "Hyperliquid order size.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "limitPx",
      description: "Hyperliquid limit price.",
      required: false,
      schema: {
        type: "string",
        anyOf: [{ type: "number" }, { type: "string" }],
      },
    },
    {
      name: "leverage",
      description: "Hyperliquid leverage for the submitted order.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "reduceOnly",
      description: "Whether the Hyperliquid order may only reduce exposure.",
      required: false,
      schema: { type: "boolean" },
    },
    {
      name: "tif",
      description: "Hyperliquid time-in-force.",
      required: false,
      schema: { type: "string", enum: ["Alo", "Ioc", "Gtc"] },
    },
    {
      name: "tokenId",
      description: "Polymarket outcome token id.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "amount",
      description: "Polymarket order amount.",
      required: false,
      schema: {
        type: "string",
        anyOf: [{ type: "number" }, { type: "string" }],
      },
    },
    {
      name: "price",
      description: "Polymarket order price.",
      required: false,
      schema: {
        type: "string",
        anyOf: [{ type: "number" }, { type: "string" }],
      },
    },
    {
      name: "tickSize",
      description: "Optional Polymarket tick-size hint.",
      required: false,
      schema: {
        type: "string",
        enum: [...POLYMARKET_TICK_SIZES],
      },
    },
    {
      name: "negRisk",
      description: "Optional Polymarket negative-risk hint.",
      required: false,
      schema: { type: "boolean" },
    },
  ],
  validate: async (runtime, message, state, options) => {
    const service = serviceFromRuntime(runtime);
    if (!service?.capability().canTrade) return false;
    const raw = rawParams(message, state, options);
    return (
      operationValue(raw.operation ?? raw.action ?? raw.subaction) !== undefined
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions | Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = serviceFromRuntime(runtime);
    if (!service) {
      const text = "Steward trading service is not available.";
      await callback?.({ text, content: { error: "PROVIDER_UNAVAILABLE" } });
      return {
        success: false,
        text,
        data: providerRecord({
          outcome: "not_attempted",
          error: "PROVIDER_UNAVAILABLE",
          retrySafe: true,
        }),
      };
    }

    let parsed: ParsedTradeParams;
    try {
      parsed = parseTradeParams(rawParams(message, state, options));
    } catch (error) {
      const text = `Invalid trade parameters: ${
        error instanceof Error ? error.message : String(error)
      }`;
      await callback?.({ text, content: { error: "INVALID_PARAMS" } });
      return {
        success: false,
        text,
        data: providerRecord({
          outcome: "rejected",
          error: "INVALID_PARAMS",
          detail: text,
          retrySafe: false,
        }),
        values: { tradeOutcome: "rejected" },
      };
    }

    if (parsed.operation === "inspect_account") {
      return inspectAccount(service, parsed.venue);
    }
    if (parsed.operation === "inspect_session") {
      return inspectSession(service, parsed.sessionId);
    }
    return submitOrder(runtime, message, service, parsed.order, callback);
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Check whether Hyperliquid trading is ready." },
      },
      {
        name: "{{agent}}",
        content: { text: "Inspecting the governed account.", action: "TRADE" },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Buy 5 Polymarket outcome tokens at 42 cents." },
      },
      {
        name: "{{agent}}",
        content: { text: "Preparing a governed trade order.", action: "TRADE" },
      },
    ],
  ],
};

export default tradeRouterAction;
