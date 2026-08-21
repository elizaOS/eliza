/**
 * Allocates metered charges across expiring subscription allowance and
 * purchased credits under one organization-scoped database transaction.
 * Durable reservations pin the exact source split before external work starts.
 */
import { ElizaError } from "@elizaos/core";
import Decimal from "decimal.js";
import { and, desc, eq, gt, lte } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { writeTransaction } from "../../db/helpers";
import {
  type BillingFundingClass,
  type BillingFundingReservation,
  billingFundingReservations,
} from "../../db/schemas/billing-funding-reservations";
import { organizations } from "../../db/schemas/organizations";
import {
  type SubscriptionAllowancePeriod,
  subscriptionAllowancePeriods,
} from "../../db/schemas/subscription-allowance-periods";
import { subscriptionAllowanceTransactions } from "../../db/schemas/subscription-allowance-transactions";
import { creditsService } from "./credits";

export const SUBSCRIPTION_FUNDING_INVALID_AMOUNT = "SUBSCRIPTION_FUNDING_INVALID_AMOUNT";
export const SUBSCRIPTION_FUNDING_INSUFFICIENT = "SUBSCRIPTION_FUNDING_INSUFFICIENT";
export const SUBSCRIPTION_FUNDING_REPLAY_CONFLICT = "SUBSCRIPTION_FUNDING_REPLAY_CONFLICT";
export const SUBSCRIPTION_FUNDING_ORGANIZATION_NOT_FOUND =
  "SUBSCRIPTION_FUNDING_ORGANIZATION_NOT_FOUND";

export interface ReserveSubscriptionFundingInput {
  organizationId: string;
  logicalOperationId: string;
  fundingClass: BillingFundingClass;
  /** Exact positive USD amount with no more than six fractional digits. */
  amount: string;
  description: string;
  expiresAt: Date;
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface SubscriptionFundingReservationResult {
  reservation: BillingFundingReservation;
  replayed: boolean;
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

function ledgerKey(logicalOperationId: string, phase: "reserve" | "settle" | "refund"): string {
  return phase === "reserve" ? logicalOperationId : `${logicalOperationId}.${phase}`;
}

function creditKey(
  organizationId: string,
  logicalOperationId: string,
  phase: "reserve" | "refund",
): string {
  return `subscription-funding:${phase}:${organizationId}:${logicalOperationId}`;
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
    row.funding_class === input.fundingClass &&
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
    idempotency_key: ledgerKey(input.logicalOperationId, "reserve"),
    metadata: input.metadata ?? {},
    occurred_at: input.occurredAt ?? new Date(),
  });
}

/**
 * Subscription funding authority. Every method that moves value owns one
 * outer transaction; lower-level credit writes receive that transaction and
 * suppress pre-commit cache effects.
 */
export class SubscriptionFundingService {
  async reserve(
    input: ReserveSubscriptionFundingInput,
  ): Promise<SubscriptionFundingReservationResult> {
    const requested = amount(input.amount, "amount");
    if (!requested.isPositive()) {
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
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input.logicalOperationId)) {
      throw new ElizaError("Subscription funding operation id is invalid", {
        code: SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
        context: { organizationId: input.organizationId },
        severity: "fatal",
      });
    }
    const occurredAt = input.occurredAt ?? new Date();
    if (input.expiresAt.getTime() <= occurredAt.getTime()) {
      throw new ElizaError("Subscription funding reservation expiry must be in the future", {
        code: SUBSCRIPTION_FUNDING_INVALID_AMOUNT,
        context: { organizationId: input.organizationId },
        severity: "fatal",
      });
    }
    const requestedAmount = fixed(requested);
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
        input.fundingClass === "allowance_eligible"
          ? await lockCurrentAllowance(tx, input.organizationId, occurredAt)
          : undefined;
      const availableAllowance = period
        ? amount(period.remaining_amount, "period.remaining_amount")
        : new Decimal(0);
      const allowance = Decimal.min(requested, availableAllowance);
      const purchased = requested.minus(allowance);

      let purchasedTransactionId: string | null = null;
      if (purchased.isPositive()) {
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
            fundingClass: input.fundingClass,
            requestedAmount,
            allowanceAmount: fixed(allowance),
          },
          stripePaymentIntentId: creditKey(
            input.organizationId,
            input.logicalOperationId,
            "reserve",
          ),
          db: tx,
          deferPostCommitEffects: true,
        });
        if (!deduction.success || !deduction.transaction) {
          throw new ElizaError("Subscription funding has insufficient purchased credits", {
            code: SUBSCRIPTION_FUNDING_INSUFFICIENT,
            context: {
              organizationId: input.organizationId,
              requiredPurchasedAmount: fixed(purchased),
              availablePurchasedAmount: deduction.newBalance,
            },
          });
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
          funding_class: input.fundingClass,
          requested_amount: requestedAmount,
          allowance_amount: fixed(allowance),
          purchased_credit_amount: fixed(purchased),
          allowance_period_id: allowance.isPositive() && period ? period.id : null,
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

      if (allowance.isPositive() && period) {
        await appendAllowanceReserve(tx, period, reservation, fixed(allowance), {
          ...input,
          occurredAt,
        });
      }
      return { reservation, replayed: false };
    });

    if (purchasedBalanceAfter != null) {
      await creditsService.invalidateCreditCaches(input.organizationId);
    }
    return result;
  }
}

export const subscriptionFundingService = new SubscriptionFundingService();
