/**
 * Owns transaction-required allowance reservation and terminal accounting.
 * It locks organization first, reads PostgreSQL wall time after that lock, and
 * never accepts caller time or escapes to a global database connection.
 */
import { ElizaError } from "@elizaos/core";
import { and, desc, eq, gt, lt, or } from "drizzle-orm";
import { resolveSubscriptionPlanDefinition } from "../../lib/services/subscription-catalog";
import type { DbTransaction } from "../client";
import {
  billingFundingAllocations,
  billingFundingReservations,
} from "../schemas/billing-funding-reservations";
import {
  type BillingSubscription,
  billingSubscriptionRevisions,
  billingSubscriptions,
} from "../schemas/billing-subscriptions";
import { organizations } from "../schemas/organizations";
import { subscriptionAllowancePeriods } from "../schemas/subscription-allowance-periods";
import { subscriptionAllowanceTransactions } from "../schemas/subscription-allowance-transactions";
import { readPostLockDatabaseNow } from "./primary-database-clock";
import {
  type CanonicalMoney,
  microsToMoney,
  moneyToMicros,
  subscriptionFundingReservationsRepository,
} from "./subscription-funding-reservations";

export const SUBSCRIPTION_ALLOWANCE_CONFLICT = "SUBSCRIPTION_ALLOWANCE_CONFLICT";
export const SUBSCRIPTION_ALLOWANCE_NOT_FOUND = "SUBSCRIPTION_ALLOWANCE_NOT_FOUND";
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** Treats the exact expiry instant as expired for both reserve and settlement decisions. */
export function isAllowanceExpired(databaseNow: Date, expiresAt: Date): boolean {
  return databaseNow.getTime() >= expiresAt.getTime();
}

function conflict(message: string, context: Record<string, unknown>): never {
  throw new ElizaError(message, {
    code: SUBSCRIPTION_ALLOWANCE_CONFLICT,
    context,
    severity: "fatal",
  });
}

function requireDigest(value: string): void {
  if (!DIGEST_PATTERN.test(value)) conflict("Request digest must be lowercase SHA-256", {});
}

async function lockOrganization(tx: DbTransaction, organizationId: string): Promise<Date> {
  const [row] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1)
    .for("update");
  if (!row) {
    throw new ElizaError("Allowance organization does not exist", {
      code: SUBSCRIPTION_ALLOWANCE_NOT_FOUND,
      context: { organizationId },
    });
  }
  return readPostLockDatabaseNow(tx);
}

async function lockPeriod(tx: DbTransaction, organizationId: string, periodId: string) {
  const [hint] = await tx
    .select({ subscriptionId: subscriptionAllowancePeriods.subscription_id })
    .from(subscriptionAllowancePeriods)
    .where(
      and(
        eq(subscriptionAllowancePeriods.organization_id, organizationId),
        eq(subscriptionAllowancePeriods.id, periodId),
      ),
    )
    .limit(1);
  if (!hint) {
    throw new ElizaError("Allowance period does not exist", {
      code: SUBSCRIPTION_ALLOWANCE_NOT_FOUND,
      context: { organizationId, periodId },
    });
  }
  await tx
    .select({ id: billingSubscriptions.id })
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.organization_id, organizationId),
        eq(billingSubscriptions.id, hint.subscriptionId),
      ),
    )
    .limit(1)
    .for("update");
  const [period] = await tx
    .select()
    .from(subscriptionAllowancePeriods)
    .where(
      and(
        eq(subscriptionAllowancePeriods.organization_id, organizationId),
        eq(subscriptionAllowancePeriods.id, periodId),
      ),
    )
    .limit(1)
    .for("update");
  if (!period) throw new Error("Allowance period disappeared while locking");
  return period;
}

async function nextSequence(tx: DbTransaction, periodId: string): Promise<number> {
  const [last] = await tx
    .select({ sequence: subscriptionAllowanceTransactions.sequence })
    .from(subscriptionAllowanceTransactions)
    .where(eq(subscriptionAllowanceTransactions.allowance_period_id, periodId))
    .orderBy(desc(subscriptionAllowanceTransactions.sequence))
    .limit(1);
  return (last?.sequence ?? 0) + 1;
}

export interface ReserveAllowanceInput {
  organizationId: string;
  periodId: string;
  logicalOperationId: string;
  requestDigest: string;
  requestedAmount: CanonicalMoney;
  allowanceAmount: CanonicalMoney;
  purchasedCreditAmount: CanonicalMoney;
  purchasedCreditReservationTransactionId: string | null;
}

export interface FinalizeAllowanceInput {
  organizationId: string;
  reservationId: string;
  idempotencyKey: string;
  requestDigest: string;
  actualAllowanceAmount: CanonicalMoney;
  actualPurchasedCreditAmount: CanonicalMoney;
  uncollectedOverageAmount: CanonicalMoney;
  purchasedCreditSettlementTransactionId: string | null;
  purchasedCreditRefundTransactionId: string | null;
}

type AuthorityResult = {
  reservation: typeof billingFundingReservations.$inferSelect;
  allocations: (typeof billingFundingAllocations.$inferSelect)[];
  period: typeof subscriptionAllowancePeriods.$inferSelect;
  replayed: boolean;
  databaseNow: Date;
};

async function findAllowancePeriodId(
  tx: DbTransaction,
  organizationId: string,
  reservationId: string,
): Promise<string> {
  const [allocation] = await tx
    .select({ periodId: billingFundingAllocations.allowance_period_id })
    .from(billingFundingAllocations)
    .where(
      and(
        eq(billingFundingAllocations.organization_id, organizationId),
        eq(billingFundingAllocations.reservation_id, reservationId),
        eq(billingFundingAllocations.source, "allowance"),
      ),
    )
    .limit(1);
  if (!allocation?.periodId) conflict("Reservation has no allowance allocation", { reservationId });
  return allocation.periodId;
}

export class SubscriptionAllowanceRepository {
  /** Opens one paid renewal bucket under the caller's organization/source/receipt transaction. Mutable consumption never participates in grant replay identity. */
  async grantRenewalInTransaction(
    tx: DbTransaction,
    input: {
      source: BillingSubscription;
      invoiceId: string;
      requestDigest: string;
      databaseNow: Date;
    },
  ) {
    const { source } = input;
    requireDigest(input.requestDigest);
    if (!source.current_period_start || !source.current_period_end)
      conflict("Renewal period is missing", { subscriptionId: source.id });
    const amount = resolveSubscriptionPlanDefinition(source.plan_key, source.catalog_version)
      .allowance.amountUsd;
    const matches = await tx
      .select()
      .from(subscriptionAllowancePeriods)
      .where(
        or(
          and(
            eq(subscriptionAllowancePeriods.provider, source.provider),
            eq(subscriptionAllowancePeriods.provider_environment, source.provider_environment),
            eq(subscriptionAllowancePeriods.stripe_invoice_id, input.invoiceId),
          ),
          and(
            eq(subscriptionAllowancePeriods.subscription_id, source.id),
            eq(subscriptionAllowancePeriods.period_start, source.current_period_start),
            eq(subscriptionAllowancePeriods.period_end, source.current_period_end),
          ),
        ),
      )
      .for("update");
    if (matches.length > 1)
      conflict("Renewal invoice and period identities disagree", { subscriptionId: source.id });
    const existing = matches[0];
    if (existing) {
      const [revision] = await tx
        .select()
        .from(billingSubscriptionRevisions)
        .where(
          and(
            eq(billingSubscriptionRevisions.subscription_id, source.id),
            eq(billingSubscriptionRevisions.organization_id, source.organization_id),
            eq(billingSubscriptionRevisions.revision, existing.subscription_revision),
          ),
        );
      const [grant] = await tx
        .select()
        .from(subscriptionAllowanceTransactions)
        .where(
          and(
            eq(subscriptionAllowanceTransactions.allowance_period_id, existing.id),
            eq(subscriptionAllowanceTransactions.kind, "grant"),
          ),
        );
      if (
        !revision ||
        !grant ||
        existing.organization_id !== source.organization_id ||
        existing.subscription_id !== source.id ||
        existing.provider !== source.provider ||
        existing.provider_environment !== source.provider_environment ||
        existing.stripe_invoice_id !== input.invoiceId ||
        existing.plan_key !== source.plan_key ||
        existing.catalog_version !== source.catalog_version ||
        existing.granted_amount !== amount ||
        existing.period_start.getTime() !== source.current_period_start.getTime() ||
        existing.period_end.getTime() !== source.current_period_end.getTime() ||
        existing.expires_at.getTime() !== existing.period_end.getTime() ||
        revision.plan_key !== source.plan_key ||
        revision.catalog_version !== source.catalog_version ||
        revision.provider !== source.provider ||
        revision.provider_environment !== source.provider_environment ||
        revision.stripe_customer_id !== source.stripe_customer_id ||
        revision.stripe_subscription_id !== source.stripe_subscription_id ||
        revision.stripe_subscription_item_id !== source.stripe_subscription_item_id ||
        revision.current_period_start?.getTime() !== existing.period_start.getTime() ||
        revision.current_period_end?.getTime() !== existing.period_end.getTime() ||
        grant.organization_id !== source.organization_id ||
        grant.amount !== amount ||
        grant.request_digest !== input.requestDigest ||
        grant.sequence !== 1 ||
        grant.idempotency_key !== `renewal:${source.provider_environment}:${input.invoiceId}`
      )
        conflict("Renewal grant replay differs from immutable invoice authority", {
          subscriptionId: source.id,
        });
      return { period: existing, replayed: true };
    }
    // The funding selector is organization-scoped: another source's future bucket must not overlap either.
    const overlap = await tx
      .select({ id: subscriptionAllowancePeriods.id })
      .from(subscriptionAllowancePeriods)
      .where(
        and(
          eq(subscriptionAllowancePeriods.organization_id, source.organization_id),
          eq(subscriptionAllowancePeriods.state, "open"),
          gt(subscriptionAllowancePeriods.expires_at, input.databaseNow),
          lt(subscriptionAllowancePeriods.period_start, source.current_period_end),
          gt(subscriptionAllowancePeriods.period_end, source.current_period_start),
        ),
      )
      .limit(1)
      .for("update");
    if (overlap.length)
      conflict("An existing allowance overlaps renewal", { subscriptionId: source.id });
    const [period] = await tx
      .insert(subscriptionAllowancePeriods)
      .values({
        organization_id: source.organization_id,
        subscription_id: source.id,
        subscription_revision: source.lifecycle_revision,
        provider: source.provider,
        provider_environment: source.provider_environment,
        stripe_invoice_id: input.invoiceId,
        plan_key: source.plan_key,
        catalog_version: source.catalog_version,
        period_start: source.current_period_start,
        period_end: source.current_period_end,
        expires_at: source.current_period_end,
        granted_amount: amount,
        available_amount: amount,
      })
      .returning();
    if (!period)
      conflict("Renewal allowance insert returned no row", { subscriptionId: source.id });
    await tx.insert(subscriptionAllowanceTransactions).values({
      organization_id: source.organization_id,
      allowance_period_id: period.id,
      sequence: 1,
      kind: "grant",
      amount,
      available_before: "0.000000",
      available_after: amount,
      reserved_before: "0.000000",
      reserved_after: "0.000000",
      settled_before: "0.000000",
      settled_after: "0.000000",
      expired_before: "0.000000",
      expired_after: "0.000000",
      clawed_back_before: "0.000000",
      clawed_back_after: "0.000000",
      request_digest: input.requestDigest,
      idempotency_key: `renewal:${source.provider_environment}:${input.invoiceId}`,
      occurred_at: input.databaseNow,
    });
    return { period, replayed: false };
  }

  async reserve(tx: DbTransaction, input: ReserveAllowanceInput): Promise<AuthorityResult> {
    requireDigest(input.requestDigest);
    const databaseNow = await lockOrganization(tx, input.organizationId);
    const [existing] = await tx
      .select({ id: billingFundingReservations.id })
      .from(billingFundingReservations)
      .where(
        and(
          eq(billingFundingReservations.organization_id, input.organizationId),
          eq(billingFundingReservations.logical_operation_id, input.logicalOperationId),
        ),
      )
      .limit(1);
    if (existing) {
      const periodId = await findAllowancePeriodId(tx, input.organizationId, existing.id);
      const period = await lockPeriod(tx, input.organizationId, periodId);
      const replay = await subscriptionFundingReservationsRepository.createPrerequisite(tx, {
        organizationId: input.organizationId,
        logicalOperationId: input.logicalOperationId,
        requestDigest: input.requestDigest,
        fundingClass: "allowance_eligible",
        requestedAmount: input.requestedAmount,
        allowancePeriodId: input.periodId,
        allowanceAmount: input.allowanceAmount,
        purchasedCreditAmount: input.purchasedCreditAmount,
        purchasedCreditReservationTransactionId: input.purchasedCreditReservationTransactionId,
        expiresAt: period.expires_at,
      });
      return { ...replay, period, replayed: true, databaseNow };
    }
    const period = await lockPeriod(tx, input.organizationId, input.periodId);
    if (period.state !== "open" || isAllowanceExpired(databaseNow, period.expires_at)) {
      conflict("Allowance is expired at post-lock database time", { periodId: period.id });
    }
    const available = moneyToMicros(period.available_amount, "period.availableAmount");
    const reservedBefore = moneyToMicros(period.reserved_amount, "period.reservedAmount");
    const allowance = moneyToMicros(input.allowanceAmount, "allowanceAmount");
    if (allowance <= 0n || allowance > available) {
      conflict("Allowance period has insufficient available funds", { periodId: period.id });
    }
    const funding = await subscriptionFundingReservationsRepository.createPrerequisite(tx, {
      organizationId: input.organizationId,
      logicalOperationId: input.logicalOperationId,
      requestDigest: input.requestDigest,
      fundingClass: "allowance_eligible",
      requestedAmount: input.requestedAmount,
      allowancePeriodId: input.periodId,
      allowanceAmount: input.allowanceAmount,
      purchasedCreditAmount: input.purchasedCreditAmount,
      purchasedCreditReservationTransactionId: input.purchasedCreditReservationTransactionId,
      expiresAt: period.expires_at,
    });
    const allowanceAllocation = funding.allocations.find((row) => row.source === "allowance");
    if (!allowanceAllocation) throw new Error("Allowance allocation was not persisted");
    const availableAfter = microsToMoney(available - allowance);
    const reservedAfter = microsToMoney(reservedBefore + allowance);
    const [updatedPeriod] = await tx
      .update(subscriptionAllowancePeriods)
      .set({
        available_amount: availableAfter,
        reserved_amount: reservedAfter,
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(subscriptionAllowancePeriods.id, period.id),
          eq(subscriptionAllowancePeriods.available_amount, period.available_amount),
          eq(subscriptionAllowancePeriods.reserved_amount, period.reserved_amount),
        ),
      )
      .returning();
    if (!updatedPeriod)
      conflict("Allowance reserve compare-and-swap lost", { periodId: period.id });
    await tx.insert(subscriptionAllowanceTransactions).values({
      organization_id: input.organizationId,
      allowance_period_id: period.id,
      funding_allocation_id: allowanceAllocation.id,
      sequence: await nextSequence(tx, period.id),
      kind: "reserve",
      amount: input.allowanceAmount,
      available_before: period.available_amount,
      available_after: availableAfter,
      reserved_before: period.reserved_amount,
      reserved_after: reservedAfter,
      settled_before: period.settled_amount,
      settled_after: period.settled_amount,
      expired_before: period.expired_amount,
      expired_after: period.expired_amount,
      clawed_back_before: period.clawed_back_amount,
      clawed_back_after: period.clawed_back_amount,
      idempotency_key: input.logicalOperationId,
      request_digest: input.requestDigest,
      occurred_at: databaseNow,
    });
    return { ...funding, period: updatedPeriod, replayed: false, databaseNow };
  }

  async finalize(tx: DbTransaction, input: FinalizeAllowanceInput): Promise<AuthorityResult> {
    return this.finish(tx, input, "settlement");
  }

  async cancel(
    tx: DbTransaction,
    input: Omit<
      FinalizeAllowanceInput,
      "actualAllowanceAmount" | "actualPurchasedCreditAmount" | "uncollectedOverageAmount"
    >,
  ): Promise<AuthorityResult> {
    return this.finish(
      tx,
      {
        ...input,
        actualAllowanceAmount: microsToMoney(0n),
        actualPurchasedCreditAmount: microsToMoney(0n),
        uncollectedOverageAmount: microsToMoney(0n),
      },
      "cancellation",
    );
  }

  private async finish(
    tx: DbTransaction,
    input: FinalizeAllowanceInput,
    kind: "settlement" | "cancellation",
  ): Promise<AuthorityResult> {
    requireDigest(input.requestDigest);
    const databaseNow = await lockOrganization(tx, input.organizationId);
    const periodId = await findAllowancePeriodId(tx, input.organizationId, input.reservationId);
    const period = await lockPeriod(tx, input.organizationId, periodId);
    const locked = await subscriptionFundingReservationsRepository.lockById(
      tx,
      input.organizationId,
      input.reservationId,
    );
    const allowanceAllocation = locked.allocations.find((row) => row.source === "allowance");
    if (!allowanceAllocation) throw new Error("Allowance allocation disappeared");
    if (locked.reservation.status !== "reserved") {
      const exactReplay =
        (kind === "settlement" &&
          locked.reservation.status === "finalized" &&
          locked.reservation.settlement_key === input.idempotencyKey &&
          locked.reservation.settlement_digest === input.requestDigest) ||
        (kind === "cancellation" &&
          locked.reservation.status === "canceled" &&
          locked.reservation.cancellation_key === input.idempotencyKey &&
          locked.reservation.cancellation_digest === input.requestDigest);
      if (!exactReplay)
        conflict("Reservation has a different terminal result", {
          reservationId: locked.reservation.id,
        });
      return { ...locked, period, replayed: true, databaseNow };
    }
    const reserved = moneyToMicros(
      allowanceAllocation.reserved_amount,
      "allocation.reservedAmount",
    );
    const actual = moneyToMicros(input.actualAllowanceAmount, "actualAllowanceAmount");
    if (actual > reserved)
      conflict("Allowance finalization exceeds reservation", {
        reservationId: locked.reservation.id,
      });
    const released = reserved - actual;
    const expiredRelease = isAllowanceExpired(databaseNow, period.expires_at);
    const availableBefore = moneyToMicros(period.available_amount, "period.availableAmount");
    const reservedBefore = moneyToMicros(period.reserved_amount, "period.reservedAmount");
    const settledBefore = moneyToMicros(period.settled_amount, "period.settledAmount");
    const expiredBefore = moneyToMicros(period.expired_amount, "period.expiredAmount");
    if (reserved > reservedBefore)
      conflict("Period reserved snapshot is below its allocation", { periodId });
    let sequence = await nextSequence(tx, period.id);
    if (actual > 0n) {
      await tx.insert(subscriptionAllowanceTransactions).values({
        organization_id: input.organizationId,
        allowance_period_id: period.id,
        funding_allocation_id: allowanceAllocation.id,
        sequence,
        kind: "finalize",
        amount: microsToMoney(actual),
        available_before: period.available_amount,
        available_after: period.available_amount,
        reserved_before: period.reserved_amount,
        reserved_after: microsToMoney(reservedBefore - actual),
        settled_before: period.settled_amount,
        settled_after: microsToMoney(settledBefore + actual),
        expired_before: period.expired_amount,
        expired_after: period.expired_amount,
        clawed_back_before: period.clawed_back_amount,
        clawed_back_after: period.clawed_back_amount,
        idempotency_key: input.idempotencyKey,
        request_digest: input.requestDigest,
        occurred_at: databaseNow,
      });
      sequence += 1;
    }
    if (released > 0n) {
      const isBaseKey = actual === 0n;
      await tx.insert(subscriptionAllowanceTransactions).values({
        organization_id: input.organizationId,
        allowance_period_id: period.id,
        funding_allocation_id: allowanceAllocation.id,
        sequence,
        kind: expiredRelease ? "expired_refund" : "release",
        amount: microsToMoney(released),
        available_before: period.available_amount,
        available_after: microsToMoney(availableBefore + (expiredRelease ? 0n : released)),
        reserved_before: microsToMoney(reservedBefore - actual),
        reserved_after: microsToMoney(reservedBefore - reserved),
        settled_before: microsToMoney(settledBefore + actual),
        settled_after: microsToMoney(settledBefore + actual),
        expired_before: period.expired_amount,
        expired_after: microsToMoney(expiredBefore + (expiredRelease ? released : 0n)),
        clawed_back_before: period.clawed_back_amount,
        clawed_back_after: period.clawed_back_amount,
        idempotency_key: isBaseKey
          ? input.idempotencyKey
          : `${allowanceAllocation.id}.release.${input.requestDigest.slice(0, 16)}`,
        request_digest: input.requestDigest,
        occurred_at: databaseNow,
      });
    }
    const [updatedPeriod] = await tx
      .update(subscriptionAllowancePeriods)
      .set({
        available_amount: microsToMoney(availableBefore + (expiredRelease ? 0n : released)),
        reserved_amount: microsToMoney(reservedBefore - reserved),
        settled_amount: microsToMoney(settledBefore + actual),
        expired_amount: microsToMoney(expiredBefore + (expiredRelease ? released : 0n)),
        updated_at: databaseNow,
      })
      .where(
        and(
          eq(subscriptionAllowancePeriods.id, period.id),
          eq(subscriptionAllowancePeriods.reserved_amount, period.reserved_amount),
        ),
      )
      .returning();
    if (!updatedPeriod) conflict("Allowance terminal compare-and-swap lost", { periodId });
    const terminal = await subscriptionFundingReservationsRepository.persistTerminal(tx, locked, {
      kind,
      key: input.idempotencyKey,
      digest: input.requestDigest,
      actualAllowanceAmount: input.actualAllowanceAmount,
      actualPurchasedCreditAmount: input.actualPurchasedCreditAmount,
      uncollectedOverageAmount: input.uncollectedOverageAmount,
      allowanceExpired: expiredRelease,
      purchasedCreditSettlementTransactionId: input.purchasedCreditSettlementTransactionId,
      purchasedCreditRefundTransactionId: input.purchasedCreditRefundTransactionId,
      databaseNow,
    });
    return { ...terminal, period: updatedPeriod, databaseNow };
  }
}

export const subscriptionAllowanceRepository = new SubscriptionAllowanceRepository();
