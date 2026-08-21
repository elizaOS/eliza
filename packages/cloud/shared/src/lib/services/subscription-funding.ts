/**
 * Allocates metered charges across expiring subscription allowance and
 * purchased credits under one organization-scoped database transaction.
 * Durable reservations pin the exact source split before external work starts.
 */
import { ElizaError } from "@elizaos/core";
import Decimal from "decimal.js";
import { and, desc, eq, gt, lte, sql } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { sqlRows } from "../../db/execute-helpers";
import { writeTransaction } from "../../db/helpers";
import {
  type BillingFundingReservation,
  billingFundingReservations,
} from "../../db/schemas/billing-funding-reservations";
import { creditTransactions } from "../../db/schemas/credit-transactions";
import { organizations } from "../../db/schemas/organizations";
import {
  type SubscriptionAllowancePeriod,
  subscriptionAllowancePeriods,
} from "../../db/schemas/subscription-allowance-periods";
import { subscriptionAllowanceTransactions } from "../../db/schemas/subscription-allowance-transactions";
import { creditsService, triggerDurableAutoTopUpForBalanceDecrease } from "./credits";
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
export const SUBSCRIPTION_FUNDING_NOT_FOUND = "SUBSCRIPTION_FUNDING_NOT_FOUND";
export const SUBSCRIPTION_FUNDING_OVERAGE_REQUIRED = "SUBSCRIPTION_FUNDING_OVERAGE_REQUIRED";
export const SUBSCRIPTION_FUNDING_RELEASE_NOT_DUE = "SUBSCRIPTION_FUNDING_RELEASE_NOT_DUE";

export interface ReserveSubscriptionFundingInput {
  organizationId: string;
  logicalOperationId: string;
  operation: SubscriptionFundingOperation;
  /** Exact positive USD amount with no more than six fractional digits. */
  amount: string;
  description: string;
  expiresAt: Date;
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface SubscriptionFundingReservationResult {
  reservation: BillingFundingReservation;
  overageReservation?: BillingFundingReservation;
  replayed: boolean;
}

export interface SettleSubscriptionFundingInput {
  organizationId: string;
  logicalOperationId: string;
  operation: SubscriptionFundingOperation;
  /** Exact non-negative USD amount actually consumed. */
  actualAmount: string;
  /** Stable provider completion timestamp; exact retries must reuse it. */
  occurredAt: Date;
  metadata?: Record<string, unknown>;
}

export interface ReleaseSubscriptionFundingInput {
  organizationId: string;
  logicalOperationId: string;
  metadata?: Record<string, unknown>;
}

interface SettlementMutationContext {
  organizationId: string;
  logicalOperationId: string;
  occurredAt: Date;
  metadata?: Record<string, unknown>;
}

function amount(value: string, field: string): Decimal {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) {
    throw new ElizaError("Subscription funding amount is not a canonical six-decimal value", {
      code: SUBSCRIPTION_FUNDING_INVALID_AMOUNT,
      context: { field, value },
      severity: "fatal",
    });
  }
  const parsed = new Decimal(value);
  if (!parsed.isFinite() || parsed.isNegative()) {
    throw new ElizaError("Subscription funding amount is invalid", {
      code: SUBSCRIPTION_FUNDING_INVALID_AMOUNT,
      context: { field },
      severity: "fatal",
    });
  }
  return parsed;
}

function fixed(value: Decimal): string {
  return value.toDecimalPlaces(6).toFixed(6);
}

async function operationDigest(
  organizationId: string,
  logicalOperationId: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(`${organizationId}:${logicalOperationId}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function databaseNow(tx: DbTransaction): Promise<Date> {
  const [clock] = await sqlRows<{ now: Date | string }>(tx, sql`SELECT CURRENT_TIMESTAMP AS now`);
  const now = clock?.now instanceof Date ? clock.now : new Date(String(clock?.now));
  if (!Number.isFinite(now.getTime())) {
    throw new ElizaError("Subscription funding could not read the database clock", {
      code: SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
      severity: "fatal",
    });
  }
  return now;
}

function ledgerKey(digest: string, phase: "reserve" | "settle" | "refund"): string {
  return `funding.${digest}.${phase}`;
}

function creditKey(digest: string, phase: "reserve" | "refund"): string {
  return `subscription-funding:${phase}:${digest}`;
}

function exactReservationReplay(
  row: BillingFundingReservation,
  input: ReserveSubscriptionFundingInput,
  requestedAmount: string,
): boolean {
  return (
    row.reservation_phase === "initial" &&
    row.phase_sequence === 0 &&
    row.parent_reservation_id === null &&
    row.root_reservation_id === null &&
    row.funding_class === SUBSCRIPTION_FUNDING_CLASS_BY_OPERATION[input.operation] &&
    row.requested_amount === requestedAmount &&
    row.expires_at.getTime() === input.expiresAt.getTime()
  );
}

async function lockCurrentAllowance(
  tx: DbTransaction,
  organizationId: string,
  occurredAt: Date,
): Promise<SubscriptionAllowancePeriod | undefined> {
  const [period] = await tx
    .select()
    .from(subscriptionAllowancePeriods)
    .where(
      and(
        eq(subscriptionAllowancePeriods.organization_id, organizationId),
        eq(subscriptionAllowancePeriods.state, "open"),
        lte(subscriptionAllowancePeriods.period_start, occurredAt),
        gt(subscriptionAllowancePeriods.expires_at, occurredAt),
      ),
    )
    .orderBy(desc(subscriptionAllowancePeriods.expires_at))
    .limit(1)
    .for("update");
  return period;
}

async function appendAllowanceReserve(
  tx: DbTransaction,
  period: SubscriptionAllowancePeriod,
  reservation: BillingFundingReservation,
  reserveAmount: string,
  digest: string,
  input: ReserveSubscriptionFundingInput,
): Promise<void> {
  const [last] = await tx
    .select({ sequence: subscriptionAllowanceTransactions.sequence })
    .from(subscriptionAllowanceTransactions)
    .where(eq(subscriptionAllowanceTransactions.allowance_period_id, period.id))
    .orderBy(desc(subscriptionAllowanceTransactions.sequence))
    .limit(1);
  const remainingAfter = fixed(
    amount(period.remaining_amount, "period.remaining_amount").minus(reserveAmount),
  );
  const [updated] = await tx
    .update(subscriptionAllowancePeriods)
    .set({ remaining_amount: remainingAfter, updated_at: new Date() })
    .where(
      and(
        eq(subscriptionAllowancePeriods.id, period.id),
        eq(subscriptionAllowancePeriods.organization_id, input.organizationId),
        eq(subscriptionAllowancePeriods.state, "open"),
        eq(subscriptionAllowancePeriods.remaining_amount, period.remaining_amount),
      ),
    )
    .returning({ id: subscriptionAllowancePeriods.id });
  if (!updated) {
    throw new ElizaError("Subscription allowance changed during funding reservation", {
      code: SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
      context: { organizationId: input.organizationId, allowancePeriodId: period.id },
      severity: "fatal",
    });
  }
  await tx.insert(subscriptionAllowanceTransactions).values({
    organization_id: input.organizationId,
    allowance_period_id: period.id,
    funding_reservation_id: reservation.id,
    source_subscription_id: null,
    source_subscription_revision: null,
    source_invoice_id: null,
    source_plan_key: null,
    source_catalog_version: null,
    sequence: (last?.sequence ?? 0) + 1,
    kind: "reserve",
    amount: reserveAmount,
    remaining_before: period.remaining_amount,
    remaining_after: remainingAfter,
    expired_before: period.expired_amount,
    expired_after: period.expired_amount,
    clawed_back_before: period.clawed_back_amount,
    clawed_back_after: period.clawed_back_amount,
    idempotency_key: ledgerKey(digest, "reserve"),
    metadata: input.metadata ?? {},
    occurred_at: input.occurredAt ?? new Date(),
  });
}

async function appendAllowanceSettlement(
  tx: DbTransaction,
  period: SubscriptionAllowancePeriod,
  reservation: BillingFundingReservation,
  input: SettlementMutationContext,
  digest: string,
  refundedAllowance: string,
): Promise<void> {
  const [last] = await tx
    .select({ sequence: subscriptionAllowanceTransactions.sequence })
    .from(subscriptionAllowanceTransactions)
    .where(eq(subscriptionAllowanceTransactions.allowance_period_id, period.id))
    .orderBy(desc(subscriptionAllowanceTransactions.sequence))
    .limit(1);
  const settleSequence = (last?.sequence ?? 0) + 1;
  await tx.insert(subscriptionAllowanceTransactions).values({
    organization_id: input.organizationId,
    allowance_period_id: period.id,
    funding_reservation_id: reservation.id,
    sequence: settleSequence,
    kind: "settle",
    amount: reservation.allowance_amount,
    remaining_before: period.remaining_amount,
    remaining_after: period.remaining_amount,
    expired_before: period.expired_amount,
    expired_after: period.expired_amount,
    clawed_back_before: period.clawed_back_amount,
    clawed_back_after: period.clawed_back_amount,
    idempotency_key: ledgerKey(digest, "settle"),
    metadata: input.metadata ?? {},
    occurred_at: input.occurredAt,
  });
  if (refundedAllowance === "0.000000") return;

  const [clock] = await sqlRows<{ now: Date | string }>(tx, sql`SELECT CURRENT_TIMESTAMP AS now`);
  const processingTime = clock?.now instanceof Date ? clock.now : new Date(String(clock?.now));
  if (!Number.isFinite(processingTime.getTime())) {
    throw new ElizaError("Subscription funding could not read the settlement clock", {
      code: SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
      context: { organizationId: input.organizationId, allowancePeriodId: period.id },
      severity: "fatal",
    });
  }
  const returnsSpendable =
    period.state === "open" && processingTime.getTime() < period.expires_at.getTime();
  const remainingAfter = returnsSpendable
    ? fixed(amount(period.remaining_amount, "period.remaining_amount").plus(refundedAllowance))
    : period.remaining_amount;
  const expiredAfter = returnsSpendable
    ? period.expired_amount
    : fixed(amount(period.expired_amount, "period.expired_amount").plus(refundedAllowance));
  const [updated] = await tx
    .update(subscriptionAllowancePeriods)
    .set({
      remaining_amount: remainingAfter,
      expired_amount: expiredAfter,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(subscriptionAllowancePeriods.id, period.id),
        eq(subscriptionAllowancePeriods.organization_id, input.organizationId),
        eq(subscriptionAllowancePeriods.remaining_amount, period.remaining_amount),
        eq(subscriptionAllowancePeriods.expired_amount, period.expired_amount),
        eq(subscriptionAllowancePeriods.clawed_back_amount, period.clawed_back_amount),
      ),
    )
    .returning({ id: subscriptionAllowancePeriods.id });
  if (!updated) {
    throw new ElizaError("Subscription allowance changed during funding settlement", {
      code: SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
      context: { organizationId: input.organizationId, allowancePeriodId: period.id },
      severity: "fatal",
    });
  }
  await tx.insert(subscriptionAllowanceTransactions).values({
    organization_id: input.organizationId,
    allowance_period_id: period.id,
    funding_reservation_id: reservation.id,
    sequence: settleSequence + 1,
    kind: "refund",
    amount: refundedAllowance,
    remaining_before: period.remaining_amount,
    remaining_after: remainingAfter,
    expired_before: period.expired_amount,
    expired_after: expiredAfter,
    clawed_back_before: period.clawed_back_amount,
    clawed_back_after: period.clawed_back_amount,
    idempotency_key: ledgerKey(digest, "refund"),
    metadata: input.metadata ?? {},
    occurred_at: input.occurredAt,
  });
}

async function settleReservedLeg(
  tx: DbTransaction,
  reservation: BillingFundingReservation,
  actual: Decimal,
  input: SettlementMutationContext,
  digest: string,
): Promise<{ reservation: BillingFundingReservation; purchasedBalanceChanged: boolean }> {
  let period: SubscriptionAllowancePeriod | undefined;
  if (reservation.allowance_period_id) {
    [period] = await tx
      .select()
      .from(subscriptionAllowancePeriods)
      .where(
        and(
          eq(subscriptionAllowancePeriods.organization_id, input.organizationId),
          eq(subscriptionAllowancePeriods.id, reservation.allowance_period_id),
        ),
      )
      .limit(1)
      .for("update");
    if (!period) {
      throw new ElizaError("Subscription funding allowance period does not exist", {
        code: SUBSCRIPTION_FUNDING_NOT_FOUND,
        context: { organizationId: input.organizationId, reservationId: reservation.id },
        severity: "fatal",
      });
    }
  }

  const requested = amount(reservation.requested_amount, "reservation.requested_amount");
  const allowanceHeld = amount(reservation.allowance_amount, "reservation.allowance_amount");
  const purchasedHeld = amount(
    reservation.purchased_credit_amount,
    "reservation.purchased_credit_amount",
  );
  const unused = requested.minus(actual);
  const purchasedRefund = Decimal.min(unused, purchasedHeld);
  const allowanceRefund = unused.minus(purchasedRefund);

  if (allowanceHeld.gt(0) && period) {
    await appendAllowanceSettlement(tx, period, reservation, input, digest, fixed(allowanceRefund));
  }

  const purchasedSettlementTransactionId = reservation.purchased_credit_reservation_transaction_id;
  if (purchasedHeld.gt(0)) {
    const [settledCredit] = await tx
      .update(creditTransactions)
      .set({ settled_at: input.occurredAt })
      .where(
        and(
          eq(creditTransactions.organization_id, input.organizationId),
          eq(creditTransactions.id, purchasedSettlementTransactionId ?? ""),
        ),
      )
      .returning({ id: creditTransactions.id });
    if (!settledCredit) {
      throw new ElizaError("Subscription funding purchased-credit hold does not exist", {
        code: SUBSCRIPTION_FUNDING_NOT_FOUND,
        context: { organizationId: input.organizationId, reservationId: reservation.id },
        severity: "fatal",
      });
    }
  }

  let purchasedRefundTransactionId: string | null = null;
  if (purchasedRefund.gt(0)) {
    const refund = await creditsService.refundCredits({
      organizationId: input.organizationId,
      amount: fixed(purchasedRefund),
      description: `Unused hold refund: ${input.logicalOperationId}`,
      metadata: {
        ...input.metadata,
        type: "subscription_funding_refund",
        logicalOperationId: input.logicalOperationId,
        reservationId: reservation.id,
      },
      stripePaymentIntentId: creditKey(digest, "refund"),
      db: tx,
      deferCacheInvalidation: true,
    });
    purchasedRefundTransactionId = refund.transaction.id;
  }

  const fullyRefunded = actual.isZero();
  const partiallyRefunded = !unused.isZero() && !fullyRefunded;
  const [updated] = await tx
    .update(billingFundingReservations)
    .set({
      status: fullyRefunded ? "refunded" : partiallyRefunded ? "partially_refunded" : "settled",
      settled_allowance_amount: reservation.allowance_amount,
      settled_purchased_credit_amount: reservation.purchased_credit_amount,
      refunded_allowance_amount: fixed(allowanceRefund),
      refunded_purchased_credit_amount: fixed(purchasedRefund),
      purchased_credit_settlement_transaction_id: purchasedSettlementTransactionId,
      purchased_credit_refund_transaction_id: purchasedRefundTransactionId,
      settled_at: input.occurredAt,
      closed_at: fullyRefunded ? input.occurredAt : null,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(billingFundingReservations.organization_id, input.organizationId),
        eq(billingFundingReservations.id, reservation.id),
        eq(billingFundingReservations.status, "reserved"),
      ),
    )
    .returning();
  if (!updated) {
    throw new ElizaError("Subscription funding reservation changed during settlement", {
      code: SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
      context: { organizationId: input.organizationId, reservationId: reservation.id },
      severity: "fatal",
    });
  }
  return {
    reservation: updated,
    purchasedBalanceChanged: purchasedRefund.gt(0),
  };
}

async function reserveOverageLeg(
  tx: DbTransaction,
  root: BillingFundingReservation,
  overage: Decimal,
  input: SettleSubscriptionFundingInput,
  rootDigest: string,
  now: Date,
): Promise<
  | { reservation: BillingFundingReservation; digest: string; purchasedBalanceAfter?: number }
  | { insufficient: { requiredPurchasedAmount: string; availablePurchasedAmount: number } }
> {
  const fundingClass = SUBSCRIPTION_FUNDING_CLASS_BY_OPERATION[input.operation];
  const logicalOperationId = `overage.${rootDigest}.1`;
  const digest = await operationDigest(input.organizationId, logicalOperationId);
  const period =
    fundingClass === "allowance_eligible"
      ? await lockCurrentAllowance(tx, input.organizationId, now)
      : undefined;
  const availableAllowance = period
    ? amount(period.remaining_amount, "period.remaining_amount")
    : new Decimal(0);
  const allowance = Decimal.min(overage, availableAllowance);
  const purchased = overage.minus(allowance);
  let purchasedTransactionId: string | null = null;
  let purchasedBalanceAfter: number | undefined;
  if (purchased.gt(0)) {
    const purchasedNumber = purchased.toNumber();
    if (
      !Number.isFinite(purchasedNumber) ||
      !new Decimal(purchasedNumber).toDecimalPlaces(6).equals(purchased)
    ) {
      throw new ElizaError("Purchased-credit overage amount cannot be represented exactly", {
        code: SUBSCRIPTION_FUNDING_INVALID_AMOUNT,
        context: { organizationId: input.organizationId, reservationId: root.id },
        severity: "fatal",
      });
    }
    const deduction = await creditsService.reserveAndDeductCredits({
      organizationId: input.organizationId,
      amount: purchasedNumber,
      description: `Usage overage: ${input.logicalOperationId}`,
      metadata: {
        ...input.metadata,
        type: "subscription_funding_overage",
        operation: input.operation,
        logicalOperationId: input.logicalOperationId,
        rootReservationId: root.id,
        allowanceAmount: fixed(allowance),
      },
      stripePaymentIntentId: creditKey(digest, "reserve"),
      db: tx,
      deferPostCommitEffects: true,
    });
    if (!deduction.success || !deduction.transaction) {
      return {
        insufficient: {
          requiredPurchasedAmount: fixed(purchased),
          availablePurchasedAmount: deduction.newBalance,
        },
      };
    }
    purchasedTransactionId = deduction.transaction.id;
    purchasedBalanceAfter = deduction.newBalance;
  }
  const expiresAt = new Date(now.getTime() + 60_000);
  const [reservation] = await tx
    .insert(billingFundingReservations)
    .values({
      organization_id: input.organizationId,
      logical_operation_id: logicalOperationId,
      reservation_phase: "overage",
      phase_sequence: 1,
      parent_reservation_id: root.id,
      root_reservation_id: root.id,
      funding_class: fundingClass,
      requested_amount: fixed(overage),
      allowance_amount: fixed(allowance),
      purchased_credit_amount: fixed(purchased),
      allowance_period_id: allowance.gt(0) && period ? period.id : null,
      purchased_credit_reservation_transaction_id: purchasedTransactionId,
      expires_at: expiresAt,
    })
    .returning();
  if (!reservation) {
    throw new ElizaError("Subscription funding overage insert returned no row", {
      code: SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
      context: { organizationId: input.organizationId, reservationId: root.id },
      severity: "fatal",
    });
  }
  if (allowance.gt(0) && period) {
    await appendAllowanceReserve(tx, period, reservation, fixed(allowance), digest, {
      organizationId: input.organizationId,
      logicalOperationId,
      operation: input.operation,
      amount: fixed(overage),
      description: `Usage overage: ${input.logicalOperationId}`,
      expiresAt,
      occurredAt: now,
      metadata: input.metadata,
    });
  }
  return { reservation, digest, purchasedBalanceAfter };
}

/**
 * Subscription funding authority. Every method that moves value owns one
 * outer transaction; lower-level credit writes receive that transaction and
 * suppress pre-commit cache effects.
 */
export class SubscriptionFundingService {
  constructor(
    private readonly triggerAutoTopUp: (
      organizationId: string,
    ) => Promise<void> = triggerDurableAutoTopUpForBalanceDecrease,
  ) {}

  async reserve(
    input: ReserveSubscriptionFundingInput,
  ): Promise<SubscriptionFundingReservationResult> {
    const requested = amount(input.amount, "amount");
    if (!requested.gt(0)) {
      throw new ElizaError("Subscription funding reservation amount must be positive", {
        code: SUBSCRIPTION_FUNDING_INVALID_AMOUNT,
        context: { organizationId: input.organizationId },
        severity: "fatal",
      });
    }
    if (!(input.expiresAt instanceof Date) || !Number.isFinite(input.expiresAt.getTime())) {
      throw new ElizaError("Subscription funding reservation expiry is invalid", {
        code: SUBSCRIPTION_FUNDING_INVALID_AMOUNT,
        context: { organizationId: input.organizationId },
        severity: "fatal",
      });
    }
    if (!SUBSCRIPTION_FUNDING_LOGICAL_OPERATION_KEY_PATTERN.test(input.logicalOperationId)) {
      throw new ElizaError("Subscription funding operation id is invalid", {
        code: SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
        context: { organizationId: input.organizationId },
        severity: "fatal",
      });
    }
    const fundingClass = SUBSCRIPTION_FUNDING_CLASS_BY_OPERATION[input.operation];
    const occurredAt = input.occurredAt ?? new Date();
    if (input.expiresAt.getTime() <= occurredAt.getTime()) {
      throw new ElizaError("Subscription funding reservation expiry must be in the future", {
        code: SUBSCRIPTION_FUNDING_INVALID_AMOUNT,
        context: { organizationId: input.organizationId },
        severity: "fatal",
      });
    }
    const requestedAmount = fixed(requested);
    const digest = await operationDigest(input.organizationId, input.logicalOperationId);
    let purchasedBalanceAfter: number | undefined;
    const result = await writeTransaction(async (tx) => {
      const [organization] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, input.organizationId))
        .limit(1)
        .for("update");
      if (!organization) {
        throw new ElizaError("Subscription funding organization does not exist", {
          code: SUBSCRIPTION_FUNDING_ORGANIZATION_NOT_FOUND,
          context: { organizationId: input.organizationId },
        });
      }

      const [replay] = await tx
        .select()
        .from(billingFundingReservations)
        .where(
          and(
            eq(billingFundingReservations.organization_id, input.organizationId),
            eq(billingFundingReservations.logical_operation_id, input.logicalOperationId),
          ),
        )
        .limit(1)
        .for("update");
      if (replay) {
        if (!exactReservationReplay(replay, input, requestedAmount)) {
          throw new ElizaError("Subscription funding operation conflicts with its reservation", {
            code: SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
            context: {
              organizationId: input.organizationId,
              logicalOperationId: input.logicalOperationId,
            },
            severity: "fatal",
          });
        }
        return { reservation: replay, replayed: true };
      }

      const period =
        fundingClass === "allowance_eligible"
          ? await lockCurrentAllowance(tx, input.organizationId, occurredAt)
          : undefined;
      const availableAllowance = period
        ? amount(period.remaining_amount, "period.remaining_amount")
        : new Decimal(0);
      const allowance = Decimal.min(requested, availableAllowance);
      const purchased = requested.minus(allowance);

      let purchasedTransactionId: string | null = null;
      if (purchased.gt(0)) {
        const purchasedNumber = purchased.toNumber();
        if (
          !Number.isFinite(purchasedNumber) ||
          !new Decimal(purchasedNumber).toDecimalPlaces(6).equals(purchased)
        ) {
          throw new ElizaError("Purchased-credit funding amount cannot be represented exactly", {
            code: SUBSCRIPTION_FUNDING_INVALID_AMOUNT,
            context: { organizationId: input.organizationId },
            severity: "fatal",
          });
        }
        const deduction = await creditsService.reserveAndDeductCredits({
          organizationId: input.organizationId,
          amount: purchasedNumber,
          description: input.description,
          metadata: {
            ...input.metadata,
            type: "subscription_funding_reservation",
            logicalOperationId: input.logicalOperationId,
            fundingClass,
            operation: input.operation,
            requestedAmount,
            allowanceAmount: fixed(allowance),
          },
          stripePaymentIntentId: creditKey(digest, "reserve"),
          db: tx,
          deferPostCommitEffects: true,
        });
        if (!deduction.success || !deduction.transaction) {
          return {
            insufficient: {
              requiredPurchasedAmount: fixed(purchased),
              availablePurchasedAmount: deduction.newBalance,
            },
          };
        }
        purchasedTransactionId = deduction.transaction.id;
        purchasedBalanceAfter = deduction.newBalance;
      }

      const [reservation] = await tx
        .insert(billingFundingReservations)
        .values({
          organization_id: input.organizationId,
          logical_operation_id: input.logicalOperationId,
          reservation_phase: "initial",
          phase_sequence: 0,
          parent_reservation_id: null,
          root_reservation_id: null,
          funding_class: fundingClass,
          requested_amount: requestedAmount,
          allowance_amount: fixed(allowance),
          purchased_credit_amount: fixed(purchased),
          allowance_period_id: allowance.gt(0) && period ? period.id : null,
          purchased_credit_reservation_transaction_id: purchasedTransactionId,
          expires_at: input.expiresAt,
        })
        .returning();
      if (!reservation) {
        throw new ElizaError("Subscription funding reservation insert returned no row", {
          code: SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
          context: {
            organizationId: input.organizationId,
            logicalOperationId: input.logicalOperationId,
          },
          severity: "fatal",
        });
      }

      if (allowance.gt(0) && period) {
        await appendAllowanceReserve(tx, period, reservation, fixed(allowance), digest, {
          ...input,
          occurredAt,
        });
      }
      return { reservation, replayed: false };
    });

    if ("insufficient" in result) {
      await this.triggerAutoTopUp(input.organizationId);
      throw new ElizaError("Subscription funding has insufficient purchased credits", {
        code: SUBSCRIPTION_FUNDING_INSUFFICIENT,
        context: {
          organizationId: input.organizationId,
          ...result.insufficient,
        },
      });
    }
    if (purchasedBalanceAfter != null) {
      await creditsService.invalidateCreditCaches(input.organizationId);
    }
    return result;
  }

  async settle(
    input: SettleSubscriptionFundingInput,
  ): Promise<SubscriptionFundingReservationResult> {
    const actual = amount(input.actualAmount, "actualAmount");
    if (!(input.occurredAt instanceof Date) || !Number.isFinite(input.occurredAt.getTime())) {
      throw new ElizaError("Subscription funding settlement timestamp is invalid", {
        code: SUBSCRIPTION_FUNDING_INVALID_AMOUNT,
        context: { organizationId: input.organizationId },
        severity: "fatal",
      });
    }
    if (!SUBSCRIPTION_FUNDING_LOGICAL_OPERATION_KEY_PATTERN.test(input.logicalOperationId)) {
      throw new ElizaError("Subscription funding operation id is invalid", {
        code: SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
        context: { organizationId: input.organizationId },
        severity: "fatal",
      });
    }
    const digest = await operationDigest(input.organizationId, input.logicalOperationId);
    let purchasedBalanceChanged = false;
    const result = await writeTransaction(async (tx) => {
      const [organization] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, input.organizationId))
        .limit(1)
        .for("update");
      if (!organization) {
        throw new ElizaError("Subscription funding organization does not exist", {
          code: SUBSCRIPTION_FUNDING_ORGANIZATION_NOT_FOUND,
          context: { organizationId: input.organizationId },
        });
      }
      const [reservation] = await tx
        .select()
        .from(billingFundingReservations)
        .where(
          and(
            eq(billingFundingReservations.organization_id, input.organizationId),
            eq(billingFundingReservations.logical_operation_id, input.logicalOperationId),
          ),
        )
        .limit(1)
        .for("update");
      if (!reservation) {
        throw new ElizaError("Subscription funding reservation does not exist", {
          code: SUBSCRIPTION_FUNDING_NOT_FOUND,
          context: {
            organizationId: input.organizationId,
            logicalOperationId: input.logicalOperationId,
          },
        });
      }
      const fundingClass = SUBSCRIPTION_FUNDING_CLASS_BY_OPERATION[input.operation];
      if (reservation.funding_class !== fundingClass) {
        throw new ElizaError("Subscription funding operation conflicts with reserved policy", {
          code: SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
          context: { organizationId: input.organizationId, reservationId: reservation.id },
          severity: "fatal",
        });
      }
      const requested = amount(reservation.requested_amount, "reservation.requested_amount");
      if (reservation.status !== "reserved") {
        const children = await tx
          .select()
          .from(billingFundingReservations)
          .where(
            and(
              eq(billingFundingReservations.organization_id, input.organizationId),
              eq(billingFundingReservations.root_reservation_id, reservation.id),
            ),
          )
          .orderBy(billingFundingReservations.phase_sequence);
        const legs = [reservation, ...children];
        const net = legs.reduce(
          (total, leg) =>
            total
              .plus(leg.settled_allowance_amount)
              .plus(leg.settled_purchased_credit_amount)
              .minus(leg.refunded_allowance_amount)
              .minus(leg.refunded_purchased_credit_amount),
          new Decimal(0),
        );
        if (
          net.equals(actual) &&
          legs.every(
            (leg) =>
              leg.funding_class === fundingClass &&
              leg.settled_at?.getTime() === input.occurredAt.getTime(),
          )
        ) {
          return {
            reservation,
            ...(children[0] ? { overageReservation: children[0] } : {}),
            replayed: true,
          };
        }
        throw new ElizaError("Subscription funding settlement replay conflicts", {
          code: SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
          context: { organizationId: input.organizationId, reservationId: reservation.id },
          severity: "fatal",
        });
      }
      const rootActual = Decimal.min(actual, requested);
      let overageReservation: BillingFundingReservation | undefined;
      let overageDigest: string | undefined;
      if (actual.greaterThan(requested)) {
        const overageResult = await reserveOverageLeg(
          tx,
          reservation,
          actual.minus(requested),
          input,
          digest,
          await databaseNow(tx),
        );
        if ("insufficient" in overageResult) return overageResult;
        overageReservation = overageResult.reservation;
        overageDigest = overageResult.digest;
        if (overageResult.purchasedBalanceAfter != null) {
          purchasedBalanceChanged = true;
        }
      }
      const settledRoot = await settleReservedLeg(tx, reservation, rootActual, input, digest);
      purchasedBalanceChanged ||= settledRoot.purchasedBalanceChanged;
      if (overageReservation && overageDigest) {
        const settledOverage = await settleReservedLeg(
          tx,
          overageReservation,
          amount(overageReservation.requested_amount, "overage.requested_amount"),
          input,
          overageDigest,
        );
        purchasedBalanceChanged ||= settledOverage.purchasedBalanceChanged;
        overageReservation = settledOverage.reservation;
      }
      return {
        reservation: settledRoot.reservation,
        ...(overageReservation ? { overageReservation } : {}),
        replayed: false,
      };
    });
    if ("insufficient" in result) {
      await this.triggerAutoTopUp(input.organizationId);
      throw new ElizaError("Subscription funding overage has insufficient purchased credits", {
        code: SUBSCRIPTION_FUNDING_INSUFFICIENT,
        context: { organizationId: input.organizationId, ...result.insufficient },
      });
    }
    if (purchasedBalanceChanged) {
      await creditsService.invalidateCreditCaches(input.organizationId);
    }
    return result;
  }

  async releaseExpired(
    input: ReleaseSubscriptionFundingInput,
  ): Promise<SubscriptionFundingReservationResult> {
    return this.release(input, "expired");
  }

  async releaseCanceled(
    input: ReleaseSubscriptionFundingInput,
  ): Promise<SubscriptionFundingReservationResult> {
    return this.release(input, "canceled");
  }

  private async release(
    input: ReleaseSubscriptionFundingInput,
    reason: "expired" | "canceled",
  ): Promise<SubscriptionFundingReservationResult> {
    if (!SUBSCRIPTION_FUNDING_LOGICAL_OPERATION_KEY_PATTERN.test(input.logicalOperationId)) {
      throw new ElizaError("Subscription funding operation id is invalid", {
        code: SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
        context: { organizationId: input.organizationId },
        severity: "fatal",
      });
    }
    let purchasedBalanceChanged = false;
    const result = await writeTransaction(async (tx) => {
      const [organization] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, input.organizationId))
        .limit(1)
        .for("update");
      if (!organization) {
        throw new ElizaError("Subscription funding organization does not exist", {
          code: SUBSCRIPTION_FUNDING_ORGANIZATION_NOT_FOUND,
          context: { organizationId: input.organizationId },
        });
      }
      const [root] = await tx
        .select()
        .from(billingFundingReservations)
        .where(
          and(
            eq(billingFundingReservations.organization_id, input.organizationId),
            eq(billingFundingReservations.logical_operation_id, input.logicalOperationId),
            eq(billingFundingReservations.reservation_phase, "initial"),
          ),
        )
        .limit(1)
        .for("update");
      if (!root) {
        throw new ElizaError("Subscription funding reservation does not exist", {
          code: SUBSCRIPTION_FUNDING_NOT_FOUND,
          context: {
            organizationId: input.organizationId,
            logicalOperationId: input.logicalOperationId,
          },
        });
      }
      const children = await tx
        .select()
        .from(billingFundingReservations)
        .where(
          and(
            eq(billingFundingReservations.organization_id, input.organizationId),
            eq(billingFundingReservations.root_reservation_id, root.id),
          ),
        )
        .orderBy(billingFundingReservations.phase_sequence)
        .for("update");
      const now = await databaseNow(tx);
      if (reason === "expired" && root.expires_at.getTime() > now.getTime()) {
        throw new ElizaError("Subscription funding reservation is not expired", {
          code: SUBSCRIPTION_FUNDING_RELEASE_NOT_DUE,
          context: {
            organizationId: input.organizationId,
            reservationId: root.id,
            expiresAt: root.expires_at.toISOString(),
          },
        });
      }
      const legs = [root, ...children];
      if (legs.every((leg) => leg.status === "refunded")) {
        const exactTerminalReplay = legs.every(
          (leg) =>
            amount(leg.settled_allowance_amount, "leg.settled_allowance_amount").equals(
              leg.refunded_allowance_amount,
            ) &&
            amount(
              leg.settled_purchased_credit_amount,
              "leg.settled_purchased_credit_amount",
            ).equals(leg.refunded_purchased_credit_amount),
        );
        if (!exactTerminalReplay) {
          throw new ElizaError("Subscription funding release replay conflicts", {
            code: SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
            context: { organizationId: input.organizationId, reservationId: root.id },
            severity: "fatal",
          });
        }
        return {
          reservation: root,
          ...(children[0] ? { overageReservation: children[0] } : {}),
          replayed: true,
        };
      }
      if (legs.some((leg) => leg.status !== "reserved")) {
        throw new ElizaError("Only reserved funding can be released", {
          code: SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
          context: { organizationId: input.organizationId, reservationId: root.id },
          severity: "fatal",
        });
      }

      const released: BillingFundingReservation[] = [];
      for (const leg of legs) {
        const releasedLeg = await settleReservedLeg(
          tx,
          leg,
          new Decimal(0),
          {
            organizationId: input.organizationId,
            logicalOperationId: leg.logical_operation_id,
            occurredAt: now,
            metadata: { ...input.metadata, releaseReason: reason, rootReservationId: root.id },
          },
          await operationDigest(input.organizationId, leg.logical_operation_id),
        );
        purchasedBalanceChanged ||= releasedLeg.purchasedBalanceChanged;
        released.push(releasedLeg.reservation);
      }
      const releasedRoot = released[0];
      if (!releasedRoot) {
        throw new ElizaError("Subscription funding release produced no reservation", {
          code: SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
          context: { organizationId: input.organizationId, reservationId: root.id },
          severity: "fatal",
        });
      }
      return {
        reservation: releasedRoot,
        ...(released[1] ? { overageReservation: released[1] } : {}),
        replayed: false,
      };
    });
    if (purchasedBalanceChanged) {
      await creditsService.invalidateCreditCaches(input.organizationId);
    }
    return result;
  }
}

export const subscriptionFundingService = new SubscriptionFundingService();
