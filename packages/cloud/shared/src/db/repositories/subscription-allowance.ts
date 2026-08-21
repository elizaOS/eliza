/**
 * Owns subscription allowance periods and their append-only snapshot ledger.
 * Mutations serialize under the period row after locking organization and
 * subscription authority, and exact idempotent replays never append twice.
 */
import { ElizaError } from "@elizaos/core";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { dbWrite, writeTransaction } from "../helpers";
import { billingFundingReservations } from "../schemas/billing-funding-reservations";
import {
  billingSubscriptionRevisions,
  billingSubscriptions,
} from "../schemas/billing-subscriptions";
import { organizations } from "../schemas/organizations";
import {
  type NewSubscriptionAllowancePeriod,
  type SubscriptionAllowancePeriod,
  subscriptionAllowancePeriods,
} from "../schemas/subscription-allowance-periods";
import {
  type NewSubscriptionAllowanceTransaction,
  type SubscriptionAllowanceTransaction,
  subscriptionAllowanceTransactions,
} from "../schemas/subscription-allowance-transactions";

export const SUBSCRIPTION_ALLOWANCE_CONFLICT = "SUBSCRIPTION_ALLOWANCE_CONFLICT";
export const SUBSCRIPTION_ALLOWANCE_NOT_FOUND = "SUBSCRIPTION_ALLOWANCE_NOT_FOUND";

type CreatePeriodValues = Required<
  Omit<NewSubscriptionAllowancePeriod, "id" | "created_at" | "updated_at">
> & { id?: string };

type AppendTransactionValues = Required<
  Omit<
    NewSubscriptionAllowanceTransaction,
    "id" | "organization_id" | "allowance_period_id" | "sequence" | "created_at"
  >
> & { id?: string };

export interface AllowanceMutationResult {
  period: SubscriptionAllowancePeriod;
  transaction: SubscriptionAllowanceTransaction;
  replayed: boolean;
}

function allowanceConflict(message: string, context: Record<string, unknown>): never {
  throw new ElizaError(message, {
    code: SUBSCRIPTION_ALLOWANCE_CONFLICT,
    context,
    severity: "fatal",
  });
}

function allowanceMicros(value: string, field: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) {
    allowanceConflict("Allowance snapshot is not a non-negative six-decimal amount", {
      field,
    });
  }
  return BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}

function exactTransactionReplay(
  row: SubscriptionAllowanceTransaction,
  input: AppendTransactionValues,
): boolean {
  const { id: requestedId, ...requestedValues } = input;
  return (
    (requestedId == null || row.id === requestedId) &&
    Object.entries(requestedValues).every(([key, requested]) =>
      samePeriodValue(row[key as keyof SubscriptionAllowanceTransaction], requested),
    )
  );
}

function samePeriodValue(stored: unknown, requested: unknown): boolean {
  if (stored instanceof Date && requested instanceof Date) {
    return stored.getTime() === requested.getTime();
  }
  return stored === (requested ?? null);
}

function exactPeriodReplay(
  period: SubscriptionAllowancePeriod,
  values: CreatePeriodValues,
): boolean {
  return (
    (values.id == null || period.id === values.id) &&
    period.organization_id === values.organization_id &&
    period.subscription_id === values.subscription_id &&
    period.subscription_revision === values.subscription_revision &&
    period.stripe_invoice_id === values.stripe_invoice_id &&
    period.plan_key === values.plan_key &&
    period.catalog_version === values.catalog_version &&
    period.period_start.getTime() === values.period_start.getTime() &&
    period.period_end.getTime() === values.period_end.getTime() &&
    period.expires_at.getTime() === values.expires_at.getTime() &&
    period.granted_amount === values.granted_amount
  );
}

export class SubscriptionAllowanceRepository {
  async findPeriod(
    organizationId: string,
    periodId: string,
  ): Promise<SubscriptionAllowancePeriod | undefined> {
    const [row] = await dbWrite
      .select()
      .from(subscriptionAllowancePeriods)
      .where(
        and(
          eq(subscriptionAllowancePeriods.organization_id, organizationId),
          eq(subscriptionAllowancePeriods.id, periodId),
        ),
      )
      .limit(1);
    return row;
  }

  async listTransactions(
    organizationId: string,
    periodId: string,
  ): Promise<SubscriptionAllowanceTransaction[]> {
    return dbWrite
      .select()
      .from(subscriptionAllowanceTransactions)
      .where(
        and(
          eq(subscriptionAllowanceTransactions.organization_id, organizationId),
          eq(subscriptionAllowanceTransactions.allowance_period_id, periodId),
        ),
      )
      .orderBy(asc(subscriptionAllowanceTransactions.sequence));
  }

  async createPeriod(
    values: CreatePeriodValues,
    idempotencyKey: string,
    metadata: Record<string, unknown> = {},
  ): Promise<AllowanceMutationResult> {
    return writeTransaction(async (tx) => {
      const [organization] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, values.organization_id))
        .limit(1)
        .for("update");
      if (!organization) {
        throw new ElizaError("Allowance organization does not exist", {
          code: SUBSCRIPTION_ALLOWANCE_NOT_FOUND,
          context: { organizationId: values.organization_id },
        });
      }
      const [subscription] = await tx
        .select({ id: billingSubscriptions.id })
        .from(billingSubscriptions)
        .where(
          and(
            eq(billingSubscriptions.organization_id, values.organization_id),
            eq(billingSubscriptions.id, values.subscription_id),
          ),
        )
        .limit(1)
        .for("update");
      if (!subscription) {
        throw new ElizaError("Allowance subscription does not exist", {
          code: SUBSCRIPTION_ALLOWANCE_NOT_FOUND,
          context: { subscriptionId: values.subscription_id },
        });
      }
      const [sourceRevision] = await tx
        .select()
        .from(billingSubscriptionRevisions)
        .where(
          and(
            eq(billingSubscriptionRevisions.organization_id, values.organization_id),
            eq(billingSubscriptionRevisions.subscription_id, values.subscription_id),
            eq(billingSubscriptionRevisions.revision, values.subscription_revision),
          ),
        )
        .limit(1);
      if (
        !sourceRevision ||
        sourceRevision.status !== "active" ||
        sourceRevision.plan_key !== values.plan_key ||
        sourceRevision.catalog_version !== values.catalog_version ||
        sourceRevision.current_period_start.getTime() !== values.period_start.getTime() ||
        sourceRevision.current_period_end.getTime() !== values.period_end.getTime()
      ) {
        allowanceConflict("Allowance grant does not match its immutable subscription revision", {
          organizationId: values.organization_id,
          subscriptionId: values.subscription_id,
          subscriptionRevision: values.subscription_revision,
        });
      }
      const inserted = await tx
        .insert(subscriptionAllowancePeriods)
        .values(values)
        .onConflictDoNothing({ target: subscriptionAllowancePeriods.stripe_invoice_id })
        .returning();
      let period = inserted.at(0);
      if (!period) {
        [period] = await tx
          .select()
          .from(subscriptionAllowancePeriods)
          .where(eq(subscriptionAllowancePeriods.stripe_invoice_id, values.stripe_invoice_id))
          .limit(1)
          .for("update");
        if (!period || !exactPeriodReplay(period, values)) {
          allowanceConflict("Allowance invoice conflicts with different grant state", {
            stripeInvoiceId: values.stripe_invoice_id,
          });
        }
        const [transaction] = await tx
          .select()
          .from(subscriptionAllowanceTransactions)
          .where(
            and(
              eq(subscriptionAllowanceTransactions.organization_id, values.organization_id),
              eq(subscriptionAllowanceTransactions.idempotency_key, idempotencyKey),
            ),
          )
          .limit(1);
        if (
          !transaction ||
          transaction.allowance_period_id !== period.id ||
          transaction.kind !== "grant" ||
          transaction.amount !== values.granted_amount ||
          transaction.remaining_before !== "0.000000" ||
          transaction.remaining_after !== values.remaining_amount ||
          transaction.expired_before !== "0.000000" ||
          transaction.expired_after !== values.expired_amount ||
          transaction.clawed_back_before !== "0.000000" ||
          transaction.clawed_back_after !== values.clawed_back_amount
        ) {
          allowanceConflict("Allowance grant replay does not match its immutable ledger", {
            periodId: period.id,
            idempotencyKey,
          });
        }
        return { period, transaction, replayed: true };
      }

      const [transaction] = await tx
        .insert(subscriptionAllowanceTransactions)
        .values({
          organization_id: period.organization_id,
          allowance_period_id: period.id,
          funding_reservation_id: null,
          sequence: 1,
          kind: "grant",
          amount: period.granted_amount,
          remaining_before: "0.000000",
          remaining_after: period.remaining_amount,
          expired_before: "0.000000",
          expired_after: period.expired_amount,
          clawed_back_before: "0.000000",
          clawed_back_after: period.clawed_back_amount,
          idempotency_key: idempotencyKey,
          metadata,
        })
        .returning();
      if (!transaction) {
        allowanceConflict("Allowance grant ledger insert returned no row", { periodId: period.id });
      }
      return { period, transaction, replayed: false };
    });
  }

  async appendMutation(
    organizationId: string,
    periodId: string,
    input: AppendTransactionValues,
    nextPeriodState?: SubscriptionAllowancePeriod["state"],
  ): Promise<AllowanceMutationResult> {
    return writeTransaction(async (tx) => {
      const [organization] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1)
        .for("update");
      if (!organization) {
        throw new ElizaError("Allowance organization does not exist", {
          code: SUBSCRIPTION_ALLOWANCE_NOT_FOUND,
          context: { organizationId },
        });
      }
      const [periodHint] = await tx
        .select({ subscriptionId: subscriptionAllowancePeriods.subscription_id })
        .from(subscriptionAllowancePeriods)
        .where(
          and(
            eq(subscriptionAllowancePeriods.organization_id, organizationId),
            eq(subscriptionAllowancePeriods.id, periodId),
          ),
        )
        .limit(1);
      if (!periodHint) {
        throw new ElizaError("Allowance period does not exist", {
          code: SUBSCRIPTION_ALLOWANCE_NOT_FOUND,
          context: { organizationId, periodId },
        });
      }
      await tx
        .select({ id: billingSubscriptions.id })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.id, periodHint.subscriptionId))
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
      if (!period) {
        throw new ElizaError("Allowance period disappeared during mutation", {
          code: SUBSCRIPTION_ALLOWANCE_NOT_FOUND,
          context: { organizationId, periodId },
        });
      }

      if (input.funding_reservation_id != null) {
        const [reservation] = await tx
          .select({
            id: billingFundingReservations.id,
            allowancePeriodId: billingFundingReservations.allowance_period_id,
            fundingClass: billingFundingReservations.funding_class,
            allowanceAmount: billingFundingReservations.allowance_amount,
          })
          .from(billingFundingReservations)
          .where(
            and(
              eq(billingFundingReservations.organization_id, organizationId),
              eq(billingFundingReservations.id, input.funding_reservation_id),
            ),
          )
          .limit(1)
          .for("update");
        if (
          !reservation ||
          reservation.allowancePeriodId !== periodId ||
          reservation.fundingClass !== "allowance_eligible" ||
          reservation.allowanceAmount === "0.000000"
        ) {
          throw new ElizaError("Allowance funding reservation does not exist", {
            code: SUBSCRIPTION_ALLOWANCE_NOT_FOUND,
            context: { reservationId: input.funding_reservation_id },
          });
        }
      }

      const [replay] = await tx
        .select()
        .from(subscriptionAllowanceTransactions)
        .where(
          and(
            eq(subscriptionAllowanceTransactions.organization_id, organizationId),
            eq(subscriptionAllowanceTransactions.idempotency_key, input.idempotency_key),
          ),
        )
        .limit(1);
      if (replay) {
        if (replay.allowance_period_id !== periodId || !exactTransactionReplay(replay, input)) {
          allowanceConflict("Allowance idempotency key conflicts with a different mutation", {
            organizationId,
            periodId,
            idempotencyKey: input.idempotency_key,
          });
        }
        return { period, transaction: replay, replayed: true };
      }

      if (
        period.remaining_amount !== input.remaining_before ||
        period.expired_amount !== input.expired_before ||
        period.clawed_back_amount !== input.clawed_back_before
      ) {
        allowanceConflict("Allowance snapshot compare-and-swap failed", {
          periodId,
          remainingExpected: input.remaining_before,
          remainingActual: period.remaining_amount,
        });
      }
      const occurredAt = input.occurred_at ?? new Date();
      const beforeExpiry = occurredAt.getTime() < period.expires_at.getTime();
      if (input.kind === "reserve" && (period.state !== "open" || !beforeExpiry)) {
        allowanceConflict("Allowance can only be reserved from an unexpired open period", {
          periodId,
          periodState: period.state,
          expiresAt: period.expires_at.toISOString(),
        });
      }
      if (input.kind === "grant_adjustment") {
        if (period.state !== "open" || !beforeExpiry) {
          allowanceConflict("Allowance can only be adjusted during its open billing period", {
            periodId,
            periodState: period.state,
            expiresAt: period.expires_at.toISOString(),
          });
        }
        const [sourceRevision] = await tx
          .select()
          .from(billingSubscriptionRevisions)
          .where(
            and(
              eq(billingSubscriptionRevisions.organization_id, organizationId),
              eq(billingSubscriptionRevisions.subscription_id, period.subscription_id),
              eq(billingSubscriptionRevisions.revision, input.source_subscription_revision ?? -1),
            ),
          )
          .limit(1);
        if (
          !sourceRevision ||
          input.source_subscription_id !== period.subscription_id ||
          sourceRevision.status !== "active" ||
          sourceRevision.plan_key !== input.source_plan_key ||
          sourceRevision.catalog_version !== input.source_catalog_version ||
          sourceRevision.current_period_start.getTime() !== period.period_start.getTime() ||
          sourceRevision.current_period_end.getTime() !== period.period_end.getTime() ||
          sourceRevision.revision <= period.subscription_revision ||
          period.plan_key !== "plus_monthly" ||
          sourceRevision.plan_key !== "pro_monthly"
        ) {
          allowanceConflict(
            "Allowance adjustment does not match a paid in-period upgrade revision",
            {
              organizationId,
              periodId,
              sourceSubscriptionRevision: input.source_subscription_revision,
            },
          );
        }
      }
      if (input.kind === "expire" && (period.state !== "open" || beforeExpiry)) {
        allowanceConflict("Allowance can only expire after its open period ends", {
          periodId,
          periodState: period.state,
          expiresAt: period.expires_at.toISOString(),
        });
      }
      if (input.kind === "clawback" && period.state !== "open") {
        allowanceConflict("Only an open allowance period can be clawed back", {
          periodId,
          periodState: period.state,
        });
      }
      if (
        input.kind === "close" &&
        (period.state !== "open" || beforeExpiry || period.remaining_amount !== "0.000000")
      ) {
        allowanceConflict("A fully consumed allowance period can only close after expiry", {
          periodId,
          periodState: period.state,
          expiresAt: period.expires_at.toISOString(),
        });
      }
      if (input.kind === "refund") {
        const refundsSpendable = period.state === "open" && beforeExpiry;
        const remainingDelta =
          allowanceMicros(input.remaining_after, "remaining_after") -
          allowanceMicros(input.remaining_before, "remaining_before");
        const expiredDelta =
          allowanceMicros(input.expired_after, "expired_after") -
          allowanceMicros(input.expired_before, "expired_before");
        if (
          (refundsSpendable && (remainingDelta <= 0n || expiredDelta !== 0n)) ||
          (!refundsSpendable && (remainingDelta !== 0n || expiredDelta <= 0n))
        ) {
          allowanceConflict("Allowance refund must return to its original period bucket", {
            periodId,
            periodState: period.state,
            refundsSpendable,
          });
        }
      }
      if (
        nextPeriodState != null &&
        ((input.kind === "expire" && nextPeriodState !== "expired") ||
          (input.kind === "clawback" && nextPeriodState !== "clawed_back") ||
          (input.kind === "close" && nextPeriodState !== "closed") ||
          (input.kind !== "expire" &&
            input.kind !== "clawback" &&
            input.kind !== "close" &&
            nextPeriodState !== period.state))
      ) {
        allowanceConflict("Allowance mutation requested an invalid period state transition", {
          periodId,
          kind: input.kind,
          currentState: period.state,
          requestedState: nextPeriodState,
        });
      }
      const [last] = await tx
        .select({ sequence: subscriptionAllowanceTransactions.sequence })
        .from(subscriptionAllowanceTransactions)
        .where(eq(subscriptionAllowanceTransactions.allowance_period_id, periodId))
        .orderBy(desc(subscriptionAllowanceTransactions.sequence))
        .limit(1);
      const sequence = (last?.sequence ?? 0) + 1;
      const [updatedPeriod] = await tx
        .update(subscriptionAllowancePeriods)
        .set({
          ...(input.kind === "grant_adjustment"
            ? {
                granted_amount: sql`${subscriptionAllowancePeriods.granted_amount} + ${input.amount}`,
              }
            : {}),
          remaining_amount: input.remaining_after,
          expired_amount: input.expired_after,
          clawed_back_amount: input.clawed_back_after,
          ...(nextPeriodState ? { state: nextPeriodState } : {}),
          updated_at: new Date(),
        })
        .where(
          and(
            eq(subscriptionAllowancePeriods.id, periodId),
            eq(subscriptionAllowancePeriods.organization_id, organizationId),
            eq(subscriptionAllowancePeriods.remaining_amount, input.remaining_before),
            eq(subscriptionAllowancePeriods.expired_amount, input.expired_before),
            eq(subscriptionAllowancePeriods.clawed_back_amount, input.clawed_back_before),
          ),
        )
        .returning();
      if (!updatedPeriod) {
        allowanceConflict("Allowance snapshot compare-and-swap lost", { periodId });
      }
      const [transaction] = await tx
        .insert(subscriptionAllowanceTransactions)
        .values({
          ...input,
          organization_id: organizationId,
          allowance_period_id: periodId,
          sequence,
        })
        .returning();
      if (!transaction) {
        allowanceConflict("Allowance ledger insert returned no row", { periodId, sequence });
      }
      return { period: updatedPeriod, transaction, replayed: false };
    });
  }
}

export const subscriptionAllowanceRepository = new SubscriptionAllowanceRepository();
