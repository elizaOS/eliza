/**
 * Steward trading contract types for the wallet plugin. These shapes are the
 * Eliza-side boundary for governed venue execution: callers express sessions
 * and orders in venue-neutral terms, while Steward remains the source of truth
 * for policy, custody, signing, idempotency replay, and audit.
 */
import type { FailureCode } from "../actions/failure-codes.js";

export type Venue = "hyperliquid" | "polymarket";

export type TradeOutcomeClass =
  | "not_attempted"
  | "rejected"
  | "unknown"
  | "policy_denied";

export type PolicyDenyReason =
  | "market-not-allowed"
  | "per-order-cap-exceeded"
  | "daily-cap-exceeded"
  | "session-not-active"
  | "leverage-cap-exceeded"
  | "policy-missing";

export type TradingCapabilityKind = "steward-self" | "steward-cloud" | "none";

export interface TradingCapability {
  readonly kind: TradingCapabilityKind;
  readonly canTrade: boolean;
  readonly reason?: string;
  readonly agentId?: string;
  readonly apiUrl?: string;
}

export interface TradeTokenStatus {
  readonly agentId: string;
  readonly status: "observed" | "unknown" | string;
  readonly exp: number | null;
  readonly observedAt: string | number | null;
  readonly expiresInSeconds: number | null;
}

export interface OpenSessionRequest {
  readonly venue: Venue;
  readonly dailyCapUsd?: number;
  readonly perOrderCapUsd?: number;
  readonly leverageCap?: number;
  readonly allowedAssets?: readonly string[];
  readonly ttlSeconds?: number;
}

export interface TradeSession {
  readonly sessionId: string;
  readonly id?: string;
  readonly agentId?: string;
  readonly venue?: Venue;
  readonly walletAddress?: string;
  readonly walletId?: string;
  readonly dailyCapUsd?: number;
  readonly perOrderCapUsd?: number;
  readonly leverageCap?: number;
  readonly allowedAssets?: readonly string[];
  readonly dailySpendUsd?: number;
  readonly remainingCapUsd?: number;
  readonly createdAt?: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string | null;
  readonly status?: string;
}

export interface TradingAccount {
  readonly venue: Venue;
  readonly accountId: string;
  readonly agentId?: string;
  readonly walletAddress?: string;
  readonly walletId?: string;
  readonly status: "active" | "unavailable" | "unknown" | string;
}

export type HyperliquidSubmitOrderRequest = {
  readonly venue: "hyperliquid";
  readonly sessionId: string;
  readonly coin: string;
  readonly side: "buy" | "sell";
  readonly size: number;
  readonly limitPx?: string | number;
  readonly leverage?: number;
  readonly reduceOnly?: boolean;
  readonly tif?: "Alo" | "Ioc" | "Gtc";
  readonly idempotencyKey?: string;
};

export type PolymarketSubmitOrderRequest = {
  readonly venue: "polymarket";
  readonly sessionId: string;
  readonly tokenId: string;
  readonly side: "buy" | "sell";
  readonly amount: string | number;
  readonly price: string | number;
  readonly tickSize?: "0.1" | "0.01" | "0.001" | "0.0001";
  readonly negRisk?: boolean;
  readonly idempotencyKey?: string;
};

export type SubmitOrderRequest =
  | HyperliquidSubmitOrderRequest
  | PolymarketSubmitOrderRequest;

export interface CancelOrderRequest {
  readonly venue: Venue;
  readonly orderId: string;
  readonly coin?: string;
  readonly market?: string;
  readonly idempotencyKey?: string;
}

export interface OrderResult {
  readonly venue: Venue;
  readonly orderId: string;
  readonly status: string;
  readonly filledQty?: number;
  readonly avgPrice?: number;
  readonly txHash?: string | null;
  readonly notionalUsd?: number;
  readonly builderPerp?: boolean;
  readonly idempotencyKey: string;
}

export interface CancelResult {
  readonly venue: Venue;
  readonly orderId: string;
  readonly status: string;
  readonly idempotencyKey?: string;
}

export interface OpenOrder {
  readonly venue: Venue;
  readonly orderId: string;
  readonly status: string;
  readonly asset?: string;
  readonly side?: "buy" | "sell";
  readonly size?: number;
  readonly price?: number;
  readonly remaining?: number;
  readonly createdAt?: string;
}

export interface Position {
  readonly venue: Venue;
  readonly asset: string;
  readonly size: number;
  readonly entryPrice?: number;
  readonly markPrice?: number;
  readonly unrealizedPnl?: number;
  readonly currentValue?: number;
}

export interface TradeAudit {
  readonly sessionId?: string;
  readonly idempotencyKey?: string;
}

export type TradeFailureCode = FailureCode;

export type TradeEnvelope<T> =
  | { ok: true; data: T; audit: TradeAudit }
  | {
      ok: false;
      outcome: TradeOutcomeClass;
      error: TradeFailureCode;
      detail: string;
      retryable: boolean;
      retryAfterMs?: number;
      policy?: { reason: PolicyDenyReason };
    };
