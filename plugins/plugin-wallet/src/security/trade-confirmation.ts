/**
 * Confirmation metadata bridge for governed trade submission. The helper keeps
 * the core confirmation record as the authority and binds one idempotency key
 * to a logical order before the user sees the first confirmation prompt.
 */
import {
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  requireConfirmation,
} from "@elizaos/core";
import { createTradeIdempotencyKey } from "../services/steward-trading-service.js";
import type { SubmitOrderRequest } from "../types/trade.js";

export const TRADE_CONFIRM_ACTION = "TRADE_ORDER";

const DEFAULT_CONFIRMATION_TTL_MS = 5 * 60_000;

export interface TradeConfirmationMetadata {
  readonly venue: SubmitOrderRequest["venue"];
  readonly sessionId: string;
  readonly idempotencyKey: string;
}

export type TradeConfirmationDecision =
  | { readonly status: "pending" }
  | {
      readonly status: "cancelled";
      readonly metadata?: Record<string, unknown>;
    }
  | {
      readonly status: "confirmed";
      readonly metadata: TradeConfirmationMetadata;
    };

export type TradeIdempotencyKeyFactory = () => string;

interface PendingConfirmationRecord {
  readonly createdAt?: number;
  readonly ttlMs?: number;
}

function confirmationCacheKey(
  userId: string,
  actionName: string,
  pendingKey: string,
): string {
  return `confirmation:${userId}:${actionName}:${pendingKey}`;
}

function isFreshPendingRecord(
  record: PendingConfirmationRecord | undefined,
): boolean {
  if (!record) return false;
  if (typeof record.createdAt !== "number") return false;
  const ttlMs =
    typeof record.ttlMs === "number"
      ? record.ttlMs
      : DEFAULT_CONFIRMATION_TTL_MS;
  return Date.now() - record.createdAt <= ttlMs;
}

function readMetadata(
  value: Record<string, unknown> | undefined,
): TradeConfirmationMetadata | null {
  if (!value) return null;
  const { venue, sessionId, idempotencyKey } = value;
  if (
    (venue !== "hyperliquid" && venue !== "polymarket") ||
    typeof sessionId !== "string" ||
    !sessionId.trim() ||
    typeof idempotencyKey !== "string" ||
    !idempotencyKey.trim()
  ) {
    return null;
  }
  return { venue, sessionId, idempotencyKey };
}

export function tradeOrderPendingKey(order: SubmitOrderRequest): string {
  const entries =
    order.venue === "hyperliquid"
      ? [
          ["venue", order.venue],
          ["sessionId", order.sessionId],
          ["coin", order.coin.toUpperCase()],
          ["side", order.side],
          ["size", String(order.size)],
          ["limitPx", order.limitPx === undefined ? "" : String(order.limitPx)],
          [
            "leverage",
            order.leverage === undefined ? "" : String(order.leverage),
          ],
          [
            "reduceOnly",
            order.reduceOnly === undefined ? "" : String(order.reduceOnly),
          ],
          ["tif", order.tif ?? ""],
        ]
      : [
          ["venue", order.venue],
          ["sessionId", order.sessionId],
          ["tokenId", order.tokenId],
          ["side", order.side],
          ["amount", String(order.amount)],
          ["price", String(order.price)],
          ["tickSize", order.tickSize ?? ""],
          ["negRisk", order.negRisk === undefined ? "" : String(order.negRisk)],
        ];
  return entries.map(([key, value]) => `${key}=${value}`).join("|");
}

export async function requireTradeOrderConfirmation(args: {
  readonly runtime: IAgentRuntime;
  readonly message: Memory;
  readonly order: SubmitOrderRequest;
  readonly prompt: string;
  readonly callback?: HandlerCallback;
  readonly keyFactory?: TradeIdempotencyKeyFactory;
}): Promise<TradeConfirmationDecision> {
  const pendingKey = tradeOrderPendingKey(args.order);
  const cacheKey = confirmationCacheKey(
    String(args.message.entityId),
    TRADE_CONFIRM_ACTION,
    pendingKey,
  );
  const existing =
    await args.runtime.getCache<PendingConfirmationRecord>(cacheKey);

  const metadata = isFreshPendingRecord(existing)
    ? undefined
    : {
        venue: args.order.venue,
        sessionId: args.order.sessionId,
        idempotencyKey: (args.keyFactory ?? createTradeIdempotencyKey)(),
      };

  const decision = await requireConfirmation({
    runtime: args.runtime,
    message: args.message,
    actionName: TRADE_CONFIRM_ACTION,
    pendingKey,
    prompt: args.prompt,
    callback: args.callback,
    metadata,
  });

  if (decision.status === "pending") return { status: "pending" };
  if (decision.status === "cancelled") {
    return { status: "cancelled", metadata: decision.metadata };
  }
  const confirmedMetadata = readMetadata(decision.metadata);
  if (!confirmedMetadata) {
    throw new Error(
      "Trade confirmation metadata is missing its idempotency key; refusing to regenerate.",
    );
  }
  return { status: "confirmed", metadata: confirmedMetadata };
}
