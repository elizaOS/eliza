/**
 * Routes allowance-eligible spend for paid subscribers through allowance-first
 * subscription funding, while every other organization keeps its unchanged
 * purchased-credit lane. This module is the single reviewed debit boundary for
 * request-scoped allowance-eligible callers: they never call the credit
 * writers directly, so the subscription debit ratchet can prove coverage.
 */

import { ElizaError } from "@elizaos/core";
import Decimal from "decimal.js";
import type { DbTransaction } from "../../db/client";
import type { BillingFundingReservation } from "../../db/schemas/billing-funding-reservations";
import { logger } from "../utils/logger";
import { readAgentFundingAccount } from "./agent-funding-account";
import { billingHoldService } from "./billing-hold";
import {
  type CreditReconciliationResult,
  type CreditReservation,
  creditsService,
  type DeductCreditsParams,
  InsufficientCreditsError,
  RESERVATION_SWEEP_GRACE_MS,
  type ReserveCreditsParams,
} from "./credits";
import {
  readOrganizationQuotaPolicy,
  readOrganizationQuotaPolicyInTransaction,
} from "./organization-quota-policy";
import {
  SUBSCRIPTION_FUNDING_INSUFFICIENT,
  subscriptionFundingService,
} from "./subscription-funding";
import {
  SUBSCRIPTION_FUNDING_CLASS_BY_OPERATION,
  SUBSCRIPTION_FUNDING_LOGICAL_OPERATION_KEY_PATTERN,
  type SubscriptionFundingOperation,
} from "./subscription-funding-policy";

type AllowanceEligibleOperation = {
  [Operation in SubscriptionFundingOperation]: (typeof SUBSCRIPTION_FUNDING_CLASS_BY_OPERATION)[Operation] extends "allowance_eligible"
    ? Operation
    : never;
}[SubscriptionFundingOperation];

const OPERATION_KEY_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,30}:$/;

/**
 * Builds a retry-stable funding key from a product prefix and a caller identity
 * such as a request id. Identities that already satisfy the durable key grammar
 * are kept verbatim so existing keys replay; any other identity (unbounded
 * length or unsafe characters) is replaced by its SHA-256 digest instead of
 * failing only subscription-funded requests.
 */
export async function subscriptionFundingOperationKey(
  prefix: string,
  identity: string,
): Promise<string> {
  if (!OPERATION_KEY_PREFIX_PATTERN.test(prefix)) {
    throw new ElizaError("Subscription funding key prefix is invalid", {
      code: "INVALID_SUBSCRIPTION_FUNDING_OPERATION_KEY",
      context: { prefix },
      severity: "fatal",
    });
  }
  const verbatim = `${prefix}${identity}`;
  if (identity.length > 0 && SUBSCRIPTION_FUNDING_LOGICAL_OPERATION_KEY_PATTERN.test(verbatim)) {
    return verbatim;
  }
  const bytes = new TextEncoder().encode(identity);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${prefix}sha256.${hex}`;
}

/** Exact six-decimal funding amount; reservations round up so they never under-hold. */
export function canonicalFundingAmount(
  value: number | string,
  rounding: "up" | "half_up" = "half_up",
): string {
  const decimal = new Decimal(value);
  if (!decimal.isFinite() || decimal.isNegative()) {
    throw new ElizaError("Funding amount must be finite and non-negative", {
      code: "SUBSCRIPTION_FUNDING_INVALID_AMOUNT",
      context: { value: String(value) },
      severity: "fatal",
    });
  }
  return decimal
    .toDecimalPlaces(6, rounding === "up" ? Decimal.ROUND_UP : Decimal.ROUND_HALF_UP)
    .toFixed(6);
}

function isPolicyUnavailable(error: unknown): boolean {
  return error instanceof ElizaError && error.code === "ORGANIZATION_POLICY_UNAVAILABLE";
}

/**
 * Whether new allowance-eligible spend must use allowance-first funding. When
 * the subscription policy cannot be resolved (for example between a period end
 * and its renewal), the organization keeps its purchased-credit lane: that lane
 * needs no subscription authority, and refusing it would stop paid work.
 */
export async function isAllowanceFirstOrganization(organizationId: string): Promise<boolean> {
  if (organizationId === "anonymous") return false;
  try {
    return (await readOrganizationQuotaPolicy(organizationId)).subscriptionFunded;
  } catch (error) {
    if (!isPolicyUnavailable(error)) throw error;
    // error-policy:J4 unresolved subscription authority selects the cash lane.
    logger.warn("[AllowanceFirst] Subscription policy unavailable; using purchased credits", {
      organizationId,
    });
    return false;
  }
}

/** Transactional counterpart of {@link isAllowanceFirstOrganization}. */
export async function isAllowanceFirstOrganizationInTransaction(
  tx: DbTransaction,
  organizationId: string,
): Promise<boolean> {
  try {
    return (await readOrganizationQuotaPolicyInTransaction(tx, organizationId)).subscriptionFunded;
  } catch (error) {
    if (!isPolicyUnavailable(error)) throw error;
    // error-policy:J4 unresolved subscription authority selects the cash lane.
    logger.warn("[AllowanceFirst] Subscription policy unavailable; using purchased credits", {
      organizationId,
    });
    return false;
  }
}

/** A reservation held in `billing_funding_reservations` rather than the credit ledger. */
export interface SubscriptionFundedReservation extends CreditReservation {
  reservationTransactionId: string;
  funding: {
    logicalOperationId: string;
    operation: SubscriptionFundingOperation;
    /** Stable settlement instant; replays must reuse it. */
    occurredAt: Date;
  };
}

export function isSubscriptionFundedReservation(
  reservation: CreditReservation | null | undefined,
): reservation is SubscriptionFundedReservation {
  return Boolean(
    reservation &&
      "funding" in reservation &&
      typeof (reservation as SubscriptionFundedReservation).funding?.logicalOperationId ===
        "string",
  );
}

function reconciliationResult(
  reservation: BillingFundingReservation,
  actualCost: number,
  collectedAmount: string,
  uncollectedOverageAmount: string,
): CreditReconciliationResult {
  const reservedAmount = Number(reservation.requested_amount);
  const uncollected = new Decimal(uncollectedOverageAmount);
  return {
    reservedAmount,
    actualCost,
    collectedAmount: Number(collectedAmount),
    reservationTransactionId: reservation.id,
    settlementTransactionIds: [reservation.id],
    adjustmentType: uncollected.gt(0)
      ? "uncollected_overage"
      : new Decimal(collectedAmount).lt(reservation.requested_amount)
        ? "refund"
        : "none",
  };
}

/** Settles a subscription-funded reservation by its logical operation id. */
export async function settleSubscriptionFundedReservation(params: {
  organizationId: string;
  logicalOperationId: string;
  operation: SubscriptionFundingOperation;
  actualCost: number | string;
  occurredAt: Date;
  metadata?: Record<string, unknown>;
}): Promise<CreditReconciliationResult> {
  const actualAmount = canonicalFundingAmount(params.actualCost);
  const settlement = await subscriptionFundingService.settle({
    organizationId: params.organizationId,
    logicalOperationId: params.logicalOperationId,
    operation: params.operation,
    actualAmount,
    occurredAt: params.occurredAt,
    metadata: params.metadata,
  });
  return reconciliationResult(
    settlement.reservation,
    Number(actualAmount),
    settlement.collectedAmount,
    settlement.uncollectedOverageAmount,
  );
}

/**
 * Reserves allowance first, then purchased credits, for a subscriber. The
 * returned handle reconciles through funding settlement; a funding shortfall is
 * surfaced as the same InsufficientCreditsError the credit lane throws.
 */
export async function reserveSubscriptionFundedCredits(params: {
  organizationId: string;
  operation: AllowanceEligibleOperation;
  logicalOperationId: string;
  amount: number | string;
  description: string;
  metadata?: Record<string, unknown>;
  reservationTtlMs?: number;
}): Promise<SubscriptionFundedReservation> {
  const amount = canonicalFundingAmount(params.amount, "up");
  let reserved: Awaited<ReturnType<typeof subscriptionFundingService.reserve>>;
  try {
    reserved = await subscriptionFundingService.reserve({
      organizationId: params.organizationId,
      logicalOperationId: params.logicalOperationId,
      operation: params.operation,
      amount,
      description: params.description,
      reservationTtlMs: params.reservationTtlMs ?? RESERVATION_SWEEP_GRACE_MS,
      metadata: params.metadata,
    });
  } catch (error) {
    if (error instanceof ElizaError && error.code === SUBSCRIPTION_FUNDING_INSUFFICIENT) {
      // error-policy:J2 keep the credit lane's typed shortfall contract; the
      // available figure covers both purchased credit and spendable allowance.
      const account = await readAgentFundingAccount(params.organizationId);
      const available = account
        ? new Decimal(account.credit_balance).plus(account.eligible_subscription_allowance)
        : new Decimal(0);
      throw new InsufficientCreditsError(
        Number(amount),
        available.toNumber(),
        "subscription_funding_insufficient",
      );
    }
    throw error;
  }
  const occurredAt = reserved.reservation.created_at;
  return {
    reservedAmount: Number(reserved.reservation.requested_amount),
    reservationTransactionId: reserved.reservation.id,
    funding: {
      logicalOperationId: params.logicalOperationId,
      operation: params.operation,
      occurredAt,
    },
    reconcile: (actualCost) =>
      settleSubscriptionFundedReservation({
        organizationId: params.organizationId,
        logicalOperationId: params.logicalOperationId,
        operation: params.operation,
        actualCost,
        occurredAt,
        metadata: params.metadata,
      }),
  };
}

/**
 * Allowance-eligible counterpart of `creditsService.reserve` for fixed-amount
 * holds. `operationKey` is the retry-stable identity; callers without one pass
 * a fresh UUID, which matches the credit lane's per-request behavior.
 */
export async function reserveAllowanceEligibleCredits(
  operation: AllowanceEligibleOperation,
  params: ReserveCreditsParams & {
    amount: number;
    operationKey: { prefix: string; identity: string };
    reservationTtlMs?: number;
  },
): Promise<CreditReservation> {
  const { operationKey, reservationTtlMs, ...creditParams } = params;
  // A pre-spend hold is new paid admission: fail closed while held (#22930).
  await billingHoldService.assertNoHold(params.organizationId);
  if (params.amount > 0 && (await isAllowanceFirstOrganization(params.organizationId))) {
    return await reserveSubscriptionFundedCredits({
      organizationId: params.organizationId,
      operation,
      logicalOperationId: await subscriptionFundingOperationKey(
        operationKey.prefix,
        operationKey.identity,
      ),
      amount: params.amount,
      description: params.description,
      metadata: {
        ...(params.metadata ?? {}),
        ...(params.userId ? { userId: params.userId } : {}),
      },
      reservationTtlMs,
    });
  }
  return await creditsService.reserve(creditParams);
}

export type AllowanceEligibleDeductResult = Awaited<
  ReturnType<typeof creditsService.deductCredits>
> & {
  /** Funding reservation id when a subscriber was charged allowance-first. */
  fundingReservationId?: string;
};

/**
 * Allowance-eligible counterpart of `creditsService.deductCredits` for an
 * immediate, already-performed charge: subscribers reserve and settle the exact
 * amount in one funding operation.
 */
export async function deductAllowanceEligibleCredits(
  operation: AllowanceEligibleOperation,
  params: DeductCreditsParams & { operationKey: { prefix: string; identity: string } },
): Promise<AllowanceEligibleDeductResult> {
  const { operationKey, ...deductParams } = params;
  if (params.amount > 0 && (await isAllowanceFirstOrganization(params.organizationId))) {
    const logicalOperationId = await subscriptionFundingOperationKey(
      operationKey.prefix,
      operationKey.identity,
    );
    let reservation: SubscriptionFundedReservation;
    try {
      reservation = await reserveSubscriptionFundedCredits({
        organizationId: params.organizationId,
        operation,
        logicalOperationId,
        amount: params.amount,
        description: params.description,
        metadata: params.metadata,
      });
    } catch (error) {
      if (!(error instanceof InsufficientCreditsError)) throw error;
      // error-policy:J2 a funding shortfall keeps deductCredits' result contract.
      const balance = await creditsService.getOrganizationBalanceSnapshot(params.organizationId);
      return {
        success: false,
        newBalance: balance.balanceUsd,
        balanceRevision: balance.revision,
        transaction: null,
        reason: "insufficient_balance",
      };
    }
    await reservation.reconcile(params.amount);
    const balance = await creditsService.getOrganizationBalanceSnapshot(params.organizationId);
    return {
      success: true,
      newBalance: balance.balanceUsd,
      balanceRevision: balance.revision,
      transaction: null,
      fundingReservationId: reservation.reservationTransactionId,
    };
  }
  return await creditsService.deductCredits(deductParams);
}

/**
 * Funds an already-metered charge allowance-first inside the caller's work
 * transaction (reserve and settle the exact amount atomically). The caller owns
 * workload locks, and must invalidate credit caches after commit when
 * `purchasedCreditDebited` is true.
 */
export async function fundAllowanceEligibleChargeInTransaction(
  tx: DbTransaction,
  params: {
    organizationId: string;
    operation: AllowanceEligibleOperation;
    logicalOperationId: string;
    amount: string;
    description: string;
    occurredAt: Date;
    metadata?: Record<string, unknown>;
  },
): Promise<{
  reservation: BillingFundingReservation;
  purchasedCreditDebited: boolean;
  replayed: boolean;
}> {
  const amount = canonicalFundingAmount(params.amount, "up");
  const reserved = await subscriptionFundingService.reserveInTransaction(tx, {
    organizationId: params.organizationId,
    logicalOperationId: params.logicalOperationId,
    operation: params.operation,
    amount,
    description: params.description,
    reservationTtlMs: RESERVATION_SWEEP_GRACE_MS,
    metadata: params.metadata,
  });
  const settled = await subscriptionFundingService.settleInTransaction(tx, {
    organizationId: params.organizationId,
    logicalOperationId: params.logicalOperationId,
    operation: params.operation,
    actualAmount: reserved.reservation.requested_amount,
    occurredAt: params.occurredAt,
    metadata: params.metadata,
  });
  return {
    reservation: settled.reservation,
    purchasedCreditDebited: reserved.purchasedCreditDebited,
    replayed: reserved.replayed,
  };
}
