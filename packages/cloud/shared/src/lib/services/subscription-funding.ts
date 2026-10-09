/**
 * Allocates metered charges across subscription allowance and purchased
 * credits in one organization-scoped transaction, then returns refunds to the
 * exact source that funded the reservation.
 */
import { ElizaError } from "@elizaos/core";
import { and, asc, eq, isNull, like, notInArray, or, sql } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { dbWrite, writeTransaction } from "../../db/helpers";
import { readPostLockDatabaseNow } from "../../db/repositories/primary-database-clock";
import { subscriptionAllowanceRepository } from "../../db/repositories/subscription-allowance";
import { readEligibleSubscriptionAllowance } from "../../db/repositories/subscription-allowance-eligibility";
import {
  type CanonicalMoney,
  microsToMoney,
  moneyToMicros,
  subscriptionFundingReservationsRepository,
} from "../../db/repositories/subscription-funding-reservations";
import {
  type BillingFundingReservation,
  billingFundingAllocations,
  billingFundingReservations,
} from "../../db/schemas/billing-funding-reservations";
import { generations } from "../../db/schemas/generations";
import { organizations } from "../../db/schemas/organizations";
import { logger } from "../utils/logger";
import { enqueueCollectedAffiliatePayout } from "./affiliate-payout-outbox";
import { creditsService } from "./credits";
import {
  SUBSCRIPTION_FUNDING_CLASS_BY_OPERATION,
  SUBSCRIPTION_FUNDING_LOGICAL_OPERATION_KEY_PATTERN,
  type SubscriptionFundingOperation,
} from "./subscription-funding-policy";

export const SUBSCRIPTION_FUNDING_INVALID_AMOUNT = "SUBSCRIPTION_FUNDING_INVALID_AMOUNT";
export const SUBSCRIPTION_FUNDING_INSUFFICIENT = "SUBSCRIPTION_FUNDING_INSUFFICIENT";
export const SUBSCRIPTION_FUNDING_REPLAY_CONFLICT = "SUBSCRIPTION_FUNDING_REPLAY_CONFLICT";
export const SUBSCRIPTION_FUNDING_ORGANIZATION_NOT_FOUND =
  "SUBSCRIPTION_FUNDING_ORGANIZATION_NOT_FOUND";

interface ReserveSubscriptionFundingBaseInput {
  organizationId: string;
  logicalOperationId: string;
  operation: SubscriptionFundingOperation;
  amount: string;
  description: string;
  metadata?: Record<string, unknown>;
}

export type ReserveSubscriptionFundingInput = ReserveSubscriptionFundingBaseInput &
  (
    | {
        expiresAt: Date;
        reservationTtlMs?: never;
        /**
         * Declares that the reservation funds usage accruing uniformly from
         * this instant until `expiresAt`. Allowance then funds at most the
         * share of that window before its period ends; purchased credits fund
         * the remainder instead of clipping the caller's window to the period.
         */
        timeMeteredFrom?: Date;
      }
    | { expiresAt?: never; reservationTtlMs: number; timeMeteredFrom?: never }
  );

export interface CancelSubscriptionFundingInput {
  organizationId: string;
  logicalOperationId: string;
  operation: SubscriptionFundingOperation;
  /** Stable reason recorded in the cancellation digest, e.g. `provider_failed`. */
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface SubscriptionFundingCancellationResult {
  reservation: BillingFundingReservation;
  replayed: boolean;
  purchasedCreditRefunded: boolean;
}

/**
 * Only reservation owners without their own recovery lane are swept. Owners
 * with durable reconcilers (Dedicated compute windows, native storage puts,
 * pending video jobs) settle their holds from provider evidence instead.
 */
export const SWEEPABLE_SUBSCRIPTION_FUNDING_PREFIXES = [
  "inference-gate:",
  "a2a:",
  "search:",
  "voice:",
] as const;
/** Extra time after a reservation deadline before the sweep may cancel it. */
export const SUBSCRIPTION_FUNDING_SWEEP_MARGIN_MS = 10 * 60 * 1000;

export interface SubscriptionFundingSweepStats {
  scanned: number;
  canceled: number;
  skipped: number;
  failed: number;
  batches: number;
}

export interface SettleSubscriptionFundingInput {
  organizationId: string;
  logicalOperationId: string;
  operation: SubscriptionFundingOperation;
  actualAmount: string;
  occurredAt: Date;
  /**
   * Reservation metadata. A pinned `affiliatePayout` contract makes the first
   * settlement enqueue the collected affiliate markup in the same transaction.
   */
  metadata?: Record<string, unknown>;
  /**
   * Pre-cap charge that the affiliate payout is computed against, when the
   * caller already capped `actualAmount` to the funded amount. Defaults to
   * `actualAmount`.
   */
  payoutActualAmount?: string;
}

export interface SubscriptionFundingReservationResult {
  reservation: BillingFundingReservation;
  replayed: boolean;
}

export interface TransactionalFundingReservationResult
  extends SubscriptionFundingReservationResult {
  /** The transaction owner must invalidate credit caches after committing this debit. */
  purchasedCreditDebited: boolean;
}

export interface SubscriptionFundingSettlementResult extends SubscriptionFundingReservationResult {
  collectedAmount: CanonicalMoney;
  uncollectedOverageAmount: CanonicalMoney;
}

export interface FundingSourceSplit {
  allowanceAmount: CanonicalMoney;
  purchasedCreditAmount: CanonicalMoney;
}

/** Returns the exact allowance-first split used by the transactional writer. */
export function splitSubscriptionFundingSources(params: {
  requestedAmount: CanonicalMoney;
  availableAllowance: CanonicalMoney;
  fundingClass: "allowance_eligible" | "cash_only";
}): FundingSourceSplit {
  const requested = moneyToMicros(params.requestedAmount, "requestedAmount");
  const available = moneyToMicros(params.availableAllowance, "availableAllowance");
  const allowance =
    params.fundingClass === "allowance_eligible"
      ? requested < available
        ? requested
        : available
      : 0n;
  return {
    allowanceAmount: microsToMoney(allowance),
    purchasedCreditAmount: microsToMoney(requested - allowance),
  };
}

export function capSubscriptionFundingSettlement(params: {
  requestedActualAmount: CanonicalMoney;
  reservedAmount: CanonicalMoney;
}): { collectedAmount: CanonicalMoney; uncollectedOverageAmount: CanonicalMoney } {
  const requested = moneyToMicros(params.requestedActualAmount, "requestedActualAmount");
  const reserved = moneyToMicros(params.reservedAmount, "reservedAmount");
  const collected = requested < reserved ? requested : reserved;
  return {
    collectedAmount: microsToMoney(collected),
    uncollectedOverageAmount: microsToMoney(requested - collected),
  };
}

function fundingError(code: string, message: string, context: Record<string, unknown>): never {
  throw new ElizaError(message, { code, context, severity: "fatal" });
}

function canonicalMoney(value: string, field: string, allowZero: boolean): CanonicalMoney {
  const micros = moneyToMicros(value, field);
  if (!allowZero && micros === 0n) {
    fundingError(SUBSCRIPTION_FUNDING_INVALID_AMOUNT, "Funding amount must be positive", { field });
  }
  return microsToMoney(micros, field);
}

async function requestDigest(parts: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(parts.join("\u001f"));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateOperationId(value: string): void {
  if (!SUBSCRIPTION_FUNDING_LOGICAL_OPERATION_KEY_PATTERN.test(value)) {
    fundingError(
      SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
      "Subscription funding logical operation id is invalid",
      { keyLength: value.length },
    );
  }
}

async function lockOrganization(tx: DbTransaction, organizationId: string): Promise<void> {
  const [row] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1)
    .for("update");
  if (!row) {
    fundingError(
      SUBSCRIPTION_FUNDING_ORGANIZATION_NOT_FOUND,
      "Subscription funding organization does not exist",
      { organizationId },
    );
  }
}

/** Converts canonical money to the numeric credit writer only when it round-trips exactly. */
function exactCreditWriterAmount(amount: CanonicalMoney, field: string): number {
  const value = Number(amount);
  if (!Number.isFinite(value) || value.toFixed(6) !== amount) {
    fundingError(
      SUBSCRIPTION_FUNDING_INVALID_AMOUNT,
      "Funding amount cannot be represented exactly by the credit writer",
      { field },
    );
  }
  return value;
}

/**
 * Caps a time-metered window's allowance share to the part of the window that
 * falls inside the allowance period, rounding down so allowance never funds
 * usage after its period ends.
 */
export function timeMeteredAllowanceCap(params: {
  requestedAmount: CanonicalMoney;
  windowStart: Date;
  windowEnd: Date;
  allowanceExpiresAt: Date;
}): CanonicalMoney {
  const requested = moneyToMicros(params.requestedAmount, "requestedAmount");
  const start = BigInt(params.windowStart.getTime());
  const end = BigInt(params.windowEnd.getTime());
  const coveredEnd = BigInt(
    Math.min(params.allowanceExpiresAt.getTime(), params.windowEnd.getTime()),
  );
  if (end <= start || coveredEnd <= start) return microsToMoney(0n);
  return microsToMoney((requested * (coveredEnd - start)) / (end - start));
}

function reservationExpiry(input: ReserveSubscriptionFundingInput, now: Date): Date {
  if (input.expiresAt) return input.expiresAt;
  if (!Number.isFinite(input.reservationTtlMs) || input.reservationTtlMs <= 0) {
    fundingError(
      SUBSCRIPTION_FUNDING_INVALID_AMOUNT,
      "Subscription funding reservation TTL must be positive",
      {},
    );
  }
  return new Date(now.getTime() + input.reservationTtlMs);
}

async function findReservation(
  tx: DbTransaction,
  organizationId: string,
  logicalOperationId: string,
): Promise<BillingFundingReservation> {
  const [reservation] = await tx
    .select()
    .from(billingFundingReservations)
    .where(
      and(
        eq(billingFundingReservations.organization_id, organizationId),
        eq(billingFundingReservations.logical_operation_id, logicalOperationId),
      ),
    )
    .limit(1);
  if (!reservation) {
    fundingError(SUBSCRIPTION_FUNDING_REPLAY_CONFLICT, "Funding reservation was not found", {
      organizationId,
      logicalOperationId,
    });
  }
  return reservation;
}

export class SubscriptionFundingService {
  /** Records a completed inference that collected no funds, so recovery cannot debit it later. */
  async recordUnfundedInferenceInTransaction(
    tx: DbTransaction,
    input: {
      organizationId: string;
      logicalOperationId: string;
      actualAmount: string;
      reservationTtlMs: number;
    },
  ): Promise<BillingFundingReservation> {
    validateOperationId(input.logicalOperationId);
    const actualAmount = canonicalMoney(input.actualAmount, "actualAmount", true);
    if (!Number.isFinite(input.reservationTtlMs) || input.reservationTtlMs <= 0) {
      fundingError(SUBSCRIPTION_FUNDING_INVALID_AMOUNT, "Funding receipt TTL must be positive", {});
    }
    await lockOrganization(tx, input.organizationId);
    const now = await readPostLockDatabaseNow(tx);
    const digest = await requestDigest([
      "unfunded_inference",
      input.organizationId,
      input.logicalOperationId,
      actualAmount,
    ]);
    const [receipt] = await tx
      .insert(billingFundingReservations)
      .values({
        organization_id: input.organizationId,
        logical_operation_id: input.logicalOperationId,
        request_digest: digest,
        funding_class: "allowance_eligible",
        requested_amount: "0.000000",
        reserved_amount: "0.000000",
        uncollected_overage_amount: actualAmount,
        status: "finalized",
        settlement_key: `settle.${digest}`,
        settlement_digest: digest,
        created_at: now,
        updated_at: now,
        finalized_at: now,
        expires_at: new Date(now.getTime() + input.reservationTtlMs),
      })
      .returning();
    if (!receipt) {
      fundingError(
        SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
        "Unfunded inference receipt was not stored",
        {
          organizationId: input.organizationId,
          logicalOperationId: input.logicalOperationId,
        },
      );
    }
    return receipt;
  }

  async reserve(
    input: ReserveSubscriptionFundingInput,
  ): Promise<SubscriptionFundingReservationResult> {
    const result = await writeTransaction((tx) => this.reserveInTransaction(tx, input));
    if (result.purchasedCreditDebited) {
      await creditsService.invalidateCreditCaches(input.organizationId);
    }
    return { reservation: result.reservation, replayed: result.replayed };
  }

  /**
   * Binds a reservation to its caller's durable work admission. The caller
   * owns workload locks before this method takes the organization lock, and
   * must invalidate credit caches after commit when purchasedCreditDebited is
   * true. A rejected admission rolls back its funding in the same transaction.
   */
  async reserveInTransaction(
    tx: DbTransaction,
    input: ReserveSubscriptionFundingInput,
  ): Promise<TransactionalFundingReservationResult> {
    validateOperationId(input.logicalOperationId);
    const requestedAmount = canonicalMoney(input.amount, "amount", false);
    const digest = await requestDigest([
      "reserve",
      input.organizationId,
      input.logicalOperationId,
      input.operation,
      requestedAmount,
    ]);
    let purchasedDebit = false;
    // Cash-only reservations never enter the allowance repository, so this is their sole organization lock.
    await lockOrganization(tx, input.organizationId);
    const now = await readPostLockDatabaseNow(tx);
    const fundingClass = SUBSCRIPTION_FUNDING_CLASS_BY_OPERATION[input.operation];
    // Replay is pinned to the original allocation, even after its period or source changes.
    const [existing] = await tx
      .select()
      .from(billingFundingReservations)
      .where(
        and(
          eq(billingFundingReservations.organization_id, input.organizationId),
          eq(billingFundingReservations.logical_operation_id, input.logicalOperationId),
        ),
      )
      .for("update");
    if (existing) {
      if (
        existing.request_digest !== digest ||
        existing.requested_amount !== requestedAmount ||
        existing.funding_class !== fundingClass
      )
        fundingError(
          SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
          "Reservation replay differs from its immutable request",
          { organizationId: input.organizationId },
        );
      const [allowanceAllocation] = await tx
        .select({ id: billingFundingAllocations.id })
        .from(billingFundingAllocations)
        .where(
          and(
            eq(billingFundingAllocations.reservation_id, existing.id),
            eq(billingFundingAllocations.source, "allowance"),
          ),
        );
      if (!allowanceAllocation) {
        const requestedExpiry = reservationExpiry(input, now);
        if (
          !Number.isFinite(requestedExpiry.getTime()) ||
          (input.expiresAt && existing.expires_at.getTime() !== input.expiresAt.getTime())
        )
          fundingError(
            SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
            "Reservation replay changes or invalidates its expiry",
            { organizationId: input.organizationId },
          );
      }
      return { reservation: existing, replayed: true, purchasedCreditDebited: false };
    }
    let period: Awaited<ReturnType<typeof readEligibleSubscriptionAllowance>> | undefined;
    if (fundingClass === "allowance_eligible") {
      period = await readEligibleSubscriptionAllowance(tx, input.organizationId, now, true);
    }
    const expiresAt = reservationExpiry(input, now);
    let availableAllowance = period
      ? canonicalMoney(period.available_amount, "period.availableAmount", true)
      : microsToMoney(0n);
    if (period && input.timeMeteredFrom) {
      const cap = timeMeteredAllowanceCap({
        requestedAmount,
        windowStart: input.timeMeteredFrom,
        windowEnd: expiresAt,
        allowanceExpiresAt: period.expires_at,
      });
      if (moneyToMicros(cap, "allowanceCap") < moneyToMicros(availableAllowance, "available")) {
        availableAllowance = cap;
      }
    }
    const split = splitSubscriptionFundingSources({
      requestedAmount,
      availableAllowance,
      fundingClass,
    });
    const allowance = moneyToMicros(split.allowanceAmount, "allowanceAmount");
    const purchased = moneyToMicros(split.purchasedCreditAmount, "purchasedCreditAmount");
    let purchasedTransactionId: string | null = null;
    if (purchased > 0n) {
      const debit = await creditsService.reserveAndDeductCredits({
        organizationId: input.organizationId,
        amount: exactCreditWriterAmount(microsToMoney(purchased), "purchasedCreditAmount"),
        description: `${input.description} (purchased credit reservation)`,
        metadata: input.metadata,
        stripePaymentIntentId: `subscription-funding:reserve:${digest}`,
        db: tx,
        deferPostCommitEffects: true,
      });
      if (!debit.success || !debit.transaction) {
        fundingError(
          SUBSCRIPTION_FUNDING_INSUFFICIENT,
          "Subscription allowance and purchased credits are insufficient",
          { organizationId: input.organizationId, requestedAmount },
        );
      }
      purchasedTransactionId = debit.transaction.id;
      purchasedDebit = !debit.transaction.settled_at;
    }
    const common = {
      organizationId: input.organizationId,
      logicalOperationId: input.logicalOperationId,
      requestDigest: digest,
      requestedAmount,
      allowanceAmount: microsToMoney(allowance),
      purchasedCreditAmount: microsToMoney(purchased),
      purchasedCreditReservationTransactionId: purchasedTransactionId,
    };
    // The caller's deadline is persisted on every reservation; the allowance
    // period expiry only limits new allowance spending.
    const authority =
      period && allowance > 0n
        ? await subscriptionAllowanceRepository.reserve(tx, {
            ...common,
            periodId: period.id,
            expiresAt,
          })
        : await subscriptionFundingReservationsRepository.createPrerequisite(tx, {
            ...common,
            fundingClass,
            allowancePeriodId: null,
            expiresAt,
          });
    return {
      reservation: authority.reservation,
      replayed: authority.replayed,
      purchasedCreditDebited: purchasedDebit && !authority.replayed,
    };
  }

  async settle(
    input: SettleSubscriptionFundingInput,
  ): Promise<SubscriptionFundingSettlementResult> {
    const result = await writeTransaction((tx) => this.settleInTransaction(tx, input));
    if (result.purchasedCreditRefunded) {
      await creditsService.invalidateCreditCaches(input.organizationId);
    }
    return {
      reservation: result.reservation,
      replayed: result.replayed,
      collectedAmount: result.collectedAmount,
      uncollectedOverageAmount: result.uncollectedOverageAmount,
    };
  }

  /**
   * Settles a pinned reservation in the caller's work-completion transaction.
   * The caller takes workload locks first and invalidates credit caches only
   * after commit when purchasedCreditRefunded is true.
   */
  async settleInTransaction(
    tx: DbTransaction,
    input: SettleSubscriptionFundingInput,
  ): Promise<SubscriptionFundingSettlementResult & { purchasedCreditRefunded: boolean }> {
    validateOperationId(input.logicalOperationId);
    const actualAmount = canonicalMoney(input.actualAmount, "actualAmount", true);
    const digest = await requestDigest([
      "settle",
      input.organizationId,
      input.logicalOperationId,
      input.operation,
      actualAmount,
      input.occurredAt.toISOString(),
    ]);
    let purchasedMutation = false;
    await lockOrganization(tx, input.organizationId);
    const now = await readPostLockDatabaseNow(tx);
    const reservation = await findReservation(tx, input.organizationId, input.logicalOperationId);
    if (reservation.funding_class !== SUBSCRIPTION_FUNDING_CLASS_BY_OPERATION[input.operation]) {
      fundingError(
        SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
        "Settlement operation does not match its reservation policy",
        { logicalOperationId: input.logicalOperationId },
      );
    }
    const locked = await subscriptionFundingReservationsRepository.lockById(
      tx,
      input.organizationId,
      reservation.id,
    );
    const allowanceAllocation = locked.allocations.find((row) => row.source === "allowance");
    const purchasedAllocation = locked.allocations.find((row) => row.source === "purchased_credit");
    const allowanceReserved = allowanceAllocation
      ? moneyToMicros(allowanceAllocation.reserved_amount, "allowanceReserved")
      : 0n;
    const purchasedReserved = purchasedAllocation
      ? moneyToMicros(purchasedAllocation.reserved_amount, "purchasedReserved")
      : 0n;
    const reserved = allowanceReserved + purchasedReserved;
    const settlementCap = capSubscriptionFundingSettlement({
      requestedActualAmount: actualAmount,
      reservedAmount: microsToMoney(reserved),
    });
    const collected = moneyToMicros(settlementCap.collectedAmount, "collectedAmount");
    const uncollectedOverage = moneyToMicros(
      settlementCap.uncollectedOverageAmount,
      "uncollectedOverageAmount",
    );
    const actualAllowance = collected < allowanceReserved ? collected : allowanceReserved;
    const actualPurchased = collected - actualAllowance;
    let refundId: string | null = null;
    if (purchasedReserved > actualPurchased) {
      const refund = await creditsService.refundCredits({
        organizationId: input.organizationId,
        amount: microsToMoney(purchasedReserved - actualPurchased),
        description: "Subscription funding purchased-credit refund",
        metadata: input.metadata,
        stripePaymentIntentId: `subscription-funding:refund:${digest}`,
        db: tx,
        deferCacheInvalidation: true,
      });
      refundId = refund.transaction.id;
      purchasedMutation = true;
    }
    const terminalInput = {
      organizationId: input.organizationId,
      reservationId: reservation.id,
      idempotencyKey: `settle.${digest}`,
      requestDigest: digest,
      actualAllowanceAmount: microsToMoney(actualAllowance),
      actualPurchasedCreditAmount: microsToMoney(actualPurchased),
      uncollectedOverageAmount: microsToMoney(uncollectedOverage),
      purchasedCreditSettlementTransactionId:
        actualPurchased > 0n
          ? (purchasedAllocation?.purchased_credit_reservation_transaction_id ?? null)
          : null,
      purchasedCreditRefundTransactionId: refundId,
    };
    // The affiliate payout commits atomically with the funded debit. Replays
    // never re-enqueue: the first settlement already wrote the outbox row.
    const enqueuePayout = async (replayed: boolean): Promise<void> => {
      if (replayed || input.metadata?.affiliatePayout === undefined) return;
      await enqueueCollectedAffiliatePayout(tx, {
        reservationMetadata: input.metadata,
        actualTotalCost: Number(
          input.payoutActualAmount === undefined
            ? actualAmount
            : canonicalMoney(input.payoutActualAmount, "payoutActualAmount", true),
        ),
        collectedTotalCost: Number(microsToMoney(collected)),
      });
    };
    if (allowanceAllocation) {
      const terminal = await subscriptionAllowanceRepository.finalize(tx, terminalInput);
      await enqueuePayout(terminal.replayed);
      return {
        reservation: terminal.reservation,
        replayed: terminal.replayed,
        purchasedCreditRefunded: purchasedMutation && !terminal.replayed,
        collectedAmount: microsToMoney(collected),
        uncollectedOverageAmount: microsToMoney(uncollectedOverage),
      };
    }
    const terminal = await subscriptionFundingReservationsRepository.persistTerminal(tx, locked, {
      kind: "settlement",
      key: terminalInput.idempotencyKey,
      digest,
      actualAllowanceAmount: terminalInput.actualAllowanceAmount,
      actualPurchasedCreditAmount: terminalInput.actualPurchasedCreditAmount,
      uncollectedOverageAmount: terminalInput.uncollectedOverageAmount,
      allowanceExpired: false,
      purchasedCreditSettlementTransactionId: terminalInput.purchasedCreditSettlementTransactionId,
      purchasedCreditRefundTransactionId: refundId,
      databaseNow: now,
    });
    await enqueuePayout(terminal.replayed);
    return {
      reservation: terminal.reservation,
      replayed: terminal.replayed,
      purchasedCreditRefunded: purchasedMutation && !terminal.replayed,
      collectedAmount: microsToMoney(collected),
      uncollectedOverageAmount: microsToMoney(uncollectedOverage),
    };
  }

  /** Releases an unsettled reservation to its exact sources after its work was not performed. */
  async cancel(
    input: CancelSubscriptionFundingInput,
  ): Promise<SubscriptionFundingCancellationResult> {
    const result = await writeTransaction((tx) => this.cancelInTransaction(tx, input));
    if (result.purchasedCreditRefunded) {
      await creditsService.invalidateCreditCaches(input.organizationId);
    }
    return result;
  }

  /**
   * Cancels in the caller's transaction: purchased credit is refunded under a
   * keyed idempotency id and allowance is released (or forfeited when its
   * period has ended). The caller invalidates credit caches after commit when
   * purchasedCreditRefunded is true.
   */
  async cancelInTransaction(
    tx: DbTransaction,
    input: CancelSubscriptionFundingInput,
  ): Promise<SubscriptionFundingCancellationResult> {
    validateOperationId(input.logicalOperationId);
    if (!SUBSCRIPTION_FUNDING_LOGICAL_OPERATION_KEY_PATTERN.test(`cancel.${input.reason}`)) {
      fundingError(SUBSCRIPTION_FUNDING_REPLAY_CONFLICT, "Cancellation reason is invalid", {
        logicalOperationId: input.logicalOperationId,
      });
    }
    const digest = await requestDigest([
      "cancel",
      input.organizationId,
      input.logicalOperationId,
      input.operation,
      input.reason,
    ]);
    const key = `cancel.${digest}`;
    await lockOrganization(tx, input.organizationId);
    const now = await readPostLockDatabaseNow(tx);
    const reservation = await findReservation(tx, input.organizationId, input.logicalOperationId);
    if (reservation.funding_class !== SUBSCRIPTION_FUNDING_CLASS_BY_OPERATION[input.operation]) {
      fundingError(
        SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
        "Cancellation operation does not match its reservation policy",
        { logicalOperationId: input.logicalOperationId },
      );
    }
    const locked = await subscriptionFundingReservationsRepository.lockById(
      tx,
      input.organizationId,
      reservation.id,
    );
    if (locked.reservation.status !== "reserved") {
      if (
        locked.reservation.status === "canceled" &&
        locked.reservation.cancellation_key === key &&
        locked.reservation.cancellation_digest === digest
      ) {
        return { reservation: locked.reservation, replayed: true, purchasedCreditRefunded: false };
      }
      fundingError(
        SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
        "Reservation already has a different terminal result",
        { logicalOperationId: input.logicalOperationId, status: locked.reservation.status },
      );
    }
    const allowanceAllocation = locked.allocations.find((row) => row.source === "allowance");
    const purchasedAllocation = locked.allocations.find((row) => row.source === "purchased_credit");
    let refundId: string | null = null;
    if (purchasedAllocation) {
      const refund = await creditsService.refundCredits({
        organizationId: input.organizationId,
        amount: canonicalMoney(purchasedAllocation.reserved_amount, "purchasedReserved", false),
        description: "Subscription funding purchased-credit release",
        metadata: { ...(input.metadata ?? {}), cancellation_reason: input.reason },
        stripePaymentIntentId: `subscription-funding:cancel:${digest}`,
        db: tx,
        deferCacheInvalidation: true,
      });
      refundId = refund.transaction.id;
    }
    if (allowanceAllocation) {
      const terminal = await subscriptionAllowanceRepository.cancel(tx, {
        organizationId: input.organizationId,
        reservationId: reservation.id,
        idempotencyKey: key,
        requestDigest: digest,
        purchasedCreditSettlementTransactionId: null,
        purchasedCreditRefundTransactionId: refundId,
      });
      return {
        reservation: terminal.reservation,
        replayed: terminal.replayed,
        purchasedCreditRefunded: refundId !== null && !terminal.replayed,
      };
    }
    const terminal = await subscriptionFundingReservationsRepository.persistTerminal(tx, locked, {
      kind: "cancellation",
      key,
      digest,
      actualAllowanceAmount: microsToMoney(0n),
      actualPurchasedCreditAmount: microsToMoney(0n),
      uncollectedOverageAmount: microsToMoney(0n),
      allowanceExpired: false,
      purchasedCreditSettlementTransactionId: null,
      purchasedCreditRefundTransactionId: refundId,
      databaseNow: now,
    });
    return {
      reservation: terminal.reservation,
      replayed: terminal.replayed,
      purchasedCreditRefunded: refundId !== null && !terminal.replayed,
    };
  }

  /**
   * Backstop for reservations whose owner never settled them (for example a
   * Worker that died between reserve and settle). Only owners listed in
   * SWEEPABLE_SUBSCRIPTION_FUNDING_PREFIXES are swept, and only after their
   * persisted caller deadline plus a margin. Stranded work is released to its
   * exact sources rather than charged, because no usage evidence exists.
   */
  async sweepStaleReservations(
    options: { marginMs?: number; batchSize?: number; maxBatches?: number } = {},
  ): Promise<SubscriptionFundingSweepStats> {
    const marginMs = options.marginMs ?? SUBSCRIPTION_FUNDING_SWEEP_MARGIN_MS;
    const batchSize = options.batchSize ?? 200;
    const maxBatches = options.maxBatches ?? 20;
    if (!Number.isSafeInteger(marginMs) || marginMs < 0) {
      fundingError(SUBSCRIPTION_FUNDING_INVALID_AMOUNT, "Sweep margin must be non-negative", {});
    }
    const stats: SubscriptionFundingSweepStats = {
      scanned: 0,
      canceled: 0,
      skipped: 0,
      failed: 0,
      batches: 0,
    };
    const failed: string[] = [];
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const rows = await dbWrite
        .select({
          id: billingFundingReservations.id,
          organizationId: billingFundingReservations.organization_id,
          logicalOperationId: billingFundingReservations.logical_operation_id,
        })
        .from(billingFundingReservations)
        .where(
          and(
            eq(billingFundingReservations.status, "reserved"),
            isNull(billingFundingReservations.billing_scope_id),
            sql`${billingFundingReservations.expires_at} < clock_timestamp() - (${String(marginMs)} || ' milliseconds')::interval`,
            or(
              ...SWEEPABLE_SUBSCRIPTION_FUNDING_PREFIXES.map((prefix) =>
                like(billingFundingReservations.logical_operation_id, `${prefix}%`),
              ),
            ),
            // A pending video job's admission hold is settled by the video
            // reconcile sweep from the upstream terminal state.
            sql`NOT EXISTS (
              SELECT 1 FROM ${generations}
              WHERE ${generations.organization_id} = ${billingFundingReservations.organization_id}
                AND ${generations.status} = 'pending'
                AND ${generations.metadata}->>'funding_logical_operation_id' = ${billingFundingReservations.logical_operation_id}
            )`,
            failed.length ? notInArray(billingFundingReservations.id, failed) : undefined,
          ),
        )
        .orderBy(asc(billingFundingReservations.expires_at), asc(billingFundingReservations.id))
        .limit(batchSize);
      if (rows.length === 0) break;
      stats.batches += 1;
      for (const row of rows) {
        stats.scanned += 1;
        const operation = sweepOperationFor(row.logicalOperationId);
        if (!operation) {
          stats.skipped += 1;
          failed.push(row.id);
          continue;
        }
        try {
          const result = await this.cancel({
            organizationId: row.organizationId,
            logicalOperationId: row.logicalOperationId,
            operation,
            reason: "stale_reservation_sweep",
            metadata: { settlement_source: "stale_funding_reservation_sweep" },
          });
          if (result.replayed) stats.skipped += 1;
          else stats.canceled += 1;
        } catch (error) {
          // error-policy:J7 one reservation's conflict (for example a settle
          // that won the race) is reported; the rest of the batch continues.
          failed.push(row.id);
          stats.failed += 1;
          logger.error("[SubscriptionFunding] Stale reservation sweep failed", {
            organizationId: row.organizationId,
            reservationId: row.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (rows.length < batchSize) break;
    }
    return stats;
  }
}

const SWEEP_OPERATION_BY_PREFIX: Readonly<
  Record<(typeof SWEEPABLE_SUBSCRIPTION_FUNDING_PREFIXES)[number], SubscriptionFundingOperation>
> = {
  "inference-gate:": "ai_inference",
  "a2a:": "ai_inference",
  "search:": "search",
  "voice:": "voice",
};

function sweepOperationFor(logicalOperationId: string): SubscriptionFundingOperation | null {
  for (const prefix of SWEEPABLE_SUBSCRIPTION_FUNDING_PREFIXES) {
    if (logicalOperationId.startsWith(prefix)) return SWEEP_OPERATION_BY_PREFIX[prefix];
  }
  return null;
}

export const subscriptionFundingService = new SubscriptionFundingService();
