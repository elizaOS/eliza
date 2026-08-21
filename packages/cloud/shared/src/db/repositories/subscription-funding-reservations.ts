/**
 * Owns tenant-scoped split-funding reservation authority without deciding how
 * allowance or purchased credits are allocated. CAS transitions lock in the
 * billing order: organization, allowance period, reservation, credit rows.
 */
import { ElizaError } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import { dbWrite, writeTransaction } from "../helpers";
import {
  type BillingFundingReservation,
  type BillingFundingReservationStatus,
  billingFundingReservations,
  type NewBillingFundingReservation,
} from "../schemas/billing-funding-reservations";
import { billingSubscriptions } from "../schemas/billing-subscriptions";
import { creditTransactions } from "../schemas/credit-transactions";
import { organizations } from "../schemas/organizations";
import { subscriptionAllowancePeriods } from "../schemas/subscription-allowance-periods";

export const SUBSCRIPTION_FUNDING_CONFLICT = "SUBSCRIPTION_FUNDING_CONFLICT";
export const SUBSCRIPTION_FUNDING_NOT_FOUND = "SUBSCRIPTION_FUNDING_NOT_FOUND";

type CreateFundingReservation = Omit<
  NewBillingFundingReservation,
  "id" | "created_at" | "updated_at"
> & { id?: string };

type FundingTransitionValues =
  | {
      status: "settled";
      settled_allowance_amount: string;
      settled_purchased_credit_amount: string;
      purchased_credit_settlement_transaction_id: string | null;
      settled_at: Date;
    }
  | {
      status: "partially_refunded";
      refunded_allowance_amount: string;
      refunded_purchased_credit_amount: string;
      purchased_credit_refund_transaction_id: string | null;
    }
  | {
      status: "refunded";
      refunded_allowance_amount: string;
      refunded_purchased_credit_amount: string;
      purchased_credit_refund_transaction_id: string | null;
      closed_at: Date;
    }
  | { status: "canceled"; closed_at: Date };

export interface FundingReservationMutationResult {
  reservation: BillingFundingReservation;
  replayed: boolean;
}

function fundingConflict(message: string, context: Record<string, unknown>): never {
  throw new ElizaError(message, {
    code: SUBSCRIPTION_FUNDING_CONFLICT,
    context,
    severity: "fatal",
  });
}

function exactCreateReplay(
  row: BillingFundingReservation,
  input: CreateFundingReservation,
): boolean {
  return (
    row.funding_class === input.funding_class &&
    row.requested_amount === input.requested_amount &&
    row.allowance_amount === input.allowance_amount &&
    row.purchased_credit_amount === input.purchased_credit_amount &&
    row.allowance_period_id === (input.allowance_period_id ?? null) &&
    row.purchased_credit_reservation_transaction_id ===
      (input.purchased_credit_reservation_transaction_id ?? null) &&
    row.expires_at.getTime() === input.expires_at.getTime()
  );
}

function exactTransitionReplay(
  row: BillingFundingReservation,
  input: FundingTransitionValues,
): boolean {
  if (row.status !== input.status) return false;
  for (const [key, value] of Object.entries(input)) {
    const actual = row[key as keyof BillingFundingReservation];
    if (actual instanceof Date && value instanceof Date) {
      if (actual.getTime() !== value.getTime()) return false;
    } else if (actual !== value) return false;
  }
  return true;
}

const ALLOWED_FUNDING_TRANSITIONS: Readonly<
  Record<BillingFundingReservationStatus, readonly BillingFundingReservationStatus[]>
> = {
  reserved: ["settled", "canceled"],
  settled: ["partially_refunded", "refunded"],
  partially_refunded: ["partially_refunded", "refunded"],
  refunded: [],
  canceled: [],
};

export class SubscriptionFundingReservationsRepository {
  async findByOperation(
    organizationId: string,
    logicalOperationId: string,
  ): Promise<BillingFundingReservation | undefined> {
    const [row] = await dbWrite
      .select()
      .from(billingFundingReservations)
      .where(
        and(
          eq(billingFundingReservations.organization_id, organizationId),
          eq(billingFundingReservations.logical_operation_id, logicalOperationId),
        ),
      )
      .limit(1);
    return row;
  }

  async findById(
    organizationId: string,
    reservationId: string,
  ): Promise<BillingFundingReservation | undefined> {
    const [row] = await dbWrite
      .select()
      .from(billingFundingReservations)
      .where(
        and(
          eq(billingFundingReservations.organization_id, organizationId),
          eq(billingFundingReservations.id, reservationId),
        ),
      )
      .limit(1);
    return row;
  }

  async create(input: CreateFundingReservation): Promise<FundingReservationMutationResult> {
    return writeTransaction(async (tx) => {
      const [organization] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, input.organization_id))
        .limit(1)
        .for("update");
      if (!organization) {
        throw new ElizaError("Funding reservation organization does not exist", {
          code: SUBSCRIPTION_FUNDING_NOT_FOUND,
          context: { organizationId: input.organization_id },
        });
      }
      if (input.allowance_period_id != null) {
        const [periodHint] = await tx
          .select({ subscriptionId: subscriptionAllowancePeriods.subscription_id })
          .from(subscriptionAllowancePeriods)
          .where(
            and(
              eq(subscriptionAllowancePeriods.organization_id, input.organization_id),
              eq(subscriptionAllowancePeriods.id, input.allowance_period_id),
            ),
          )
          .limit(1);
        if (!periodHint) {
          throw new ElizaError("Funding allowance period does not exist", {
            code: SUBSCRIPTION_FUNDING_NOT_FOUND,
            context: { allowancePeriodId: input.allowance_period_id },
          });
        }
        await tx
          .select({ id: billingSubscriptions.id })
          .from(billingSubscriptions)
          .where(
            and(
              eq(billingSubscriptions.organization_id, input.organization_id),
              eq(billingSubscriptions.id, periodHint.subscriptionId),
            ),
          )
          .limit(1)
          .for("update");
        const [period] = await tx
          .select({ id: subscriptionAllowancePeriods.id })
          .from(subscriptionAllowancePeriods)
          .where(
            and(
              eq(subscriptionAllowancePeriods.organization_id, input.organization_id),
              eq(subscriptionAllowancePeriods.id, input.allowance_period_id),
            ),
          )
          .limit(1)
          .for("update");
        if (!period) {
          throw new ElizaError("Funding allowance period does not exist", {
            code: SUBSCRIPTION_FUNDING_NOT_FOUND,
            context: { allowancePeriodId: input.allowance_period_id },
          });
        }
      }

      const inserted = await tx
        .insert(billingFundingReservations)
        .values(input)
        .onConflictDoNothing({
          target: [
            billingFundingReservations.organization_id,
            billingFundingReservations.logical_operation_id,
          ],
        })
        .returning();
      let reservation = inserted.at(0);
      if (!reservation) {
        [reservation] = await tx
          .select()
          .from(billingFundingReservations)
          .where(
            and(
              eq(billingFundingReservations.organization_id, input.organization_id),
              eq(billingFundingReservations.logical_operation_id, input.logical_operation_id),
            ),
          )
          .limit(1)
          .for("update");
        if (!reservation || !exactCreateReplay(reservation, input)) {
          fundingConflict("Funding operation id conflicts with a different reservation", {
            organizationId: input.organization_id,
            logicalOperationId: input.logical_operation_id,
          });
        }
        return { reservation, replayed: true };
      }
      if (reservation.purchased_credit_reservation_transaction_id != null) {
        const [credit] = await tx
          .select({ id: creditTransactions.id })
          .from(creditTransactions)
          .where(
            and(
              eq(creditTransactions.organization_id, input.organization_id),
              eq(creditTransactions.id, reservation.purchased_credit_reservation_transaction_id),
            ),
          )
          .limit(1)
          .for("update");
        if (!credit) {
          throw new ElizaError("Funding purchased-credit reservation does not exist", {
            code: SUBSCRIPTION_FUNDING_NOT_FOUND,
            context: {
              creditTransactionId: reservation.purchased_credit_reservation_transaction_id,
            },
          });
        }
      }
      return { reservation, replayed: false };
    });
  }

  async transition(
    organizationId: string,
    reservationId: string,
    expectedStatus: BillingFundingReservationStatus,
    values: FundingTransitionValues,
  ): Promise<FundingReservationMutationResult> {
    return writeTransaction(async (tx) => {
      const [hint] = await tx
        .select({ allowancePeriodId: billingFundingReservations.allowance_period_id })
        .from(billingFundingReservations)
        .where(
          and(
            eq(billingFundingReservations.organization_id, organizationId),
            eq(billingFundingReservations.id, reservationId),
          ),
        )
        .limit(1);
      const [organization] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1)
        .for("update");
      if (!organization || !hint) {
        throw new ElizaError("Funding reservation does not exist", {
          code: SUBSCRIPTION_FUNDING_NOT_FOUND,
          context: { organizationId, reservationId },
        });
      }
      if (hint.allowancePeriodId != null) {
        const [periodHint] = await tx
          .select({ subscriptionId: subscriptionAllowancePeriods.subscription_id })
          .from(subscriptionAllowancePeriods)
          .where(
            and(
              eq(subscriptionAllowancePeriods.organization_id, organizationId),
              eq(subscriptionAllowancePeriods.id, hint.allowancePeriodId),
            ),
          )
          .limit(1);
        if (!periodHint) {
          throw new ElizaError("Funding allowance period does not exist", {
            code: SUBSCRIPTION_FUNDING_NOT_FOUND,
            context: { allowancePeriodId: hint.allowancePeriodId },
          });
        }
        await tx
          .select({ id: billingSubscriptions.id })
          .from(billingSubscriptions)
          .where(
            and(
              eq(billingSubscriptions.organization_id, organizationId),
              eq(billingSubscriptions.id, periodHint.subscriptionId),
            ),
          )
          .limit(1)
          .for("update");
        await tx
          .select({ id: subscriptionAllowancePeriods.id })
          .from(subscriptionAllowancePeriods)
          .where(eq(subscriptionAllowancePeriods.id, hint.allowancePeriodId))
          .limit(1)
          .for("update");
      }
      const [current] = await tx
        .select()
        .from(billingFundingReservations)
        .where(
          and(
            eq(billingFundingReservations.organization_id, organizationId),
            eq(billingFundingReservations.id, reservationId),
          ),
        )
        .limit(1)
        .for("update");
      if (!current) {
        throw new ElizaError("Funding reservation disappeared during transition", {
          code: SUBSCRIPTION_FUNDING_NOT_FOUND,
          context: { organizationId, reservationId },
        });
      }
      if (exactTransitionReplay(current, values)) return { reservation: current, replayed: true };
      if (current.status !== expectedStatus) {
        fundingConflict("Funding reservation status compare-and-swap failed", {
          reservationId,
          expectedStatus,
          actualStatus: current.status,
        });
      }
      if (!ALLOWED_FUNDING_TRANSITIONS[current.status].includes(values.status)) {
        fundingConflict("Funding reservation transition is not monotonic", {
          reservationId,
          currentStatus: current.status,
          requestedStatus: values.status,
        });
      }

      const creditIds = [
        current.purchased_credit_reservation_transaction_id,
        values.status === "settled" ? values.purchased_credit_settlement_transaction_id : null,
        values.status === "partially_refunded" || values.status === "refunded"
          ? values.purchased_credit_refund_transaction_id
          : null,
      ].filter((id): id is string => id != null);
      for (const creditId of [...new Set(creditIds)].sort()) {
        const [credit] = await tx
          .select({ id: creditTransactions.id })
          .from(creditTransactions)
          .where(
            and(
              eq(creditTransactions.organization_id, organizationId),
              eq(creditTransactions.id, creditId),
            ),
          )
          .limit(1)
          .for("update");
        if (!credit) {
          throw new ElizaError("Funding credit transaction does not exist", {
            code: SUBSCRIPTION_FUNDING_NOT_FOUND,
            context: { organizationId, creditTransactionId: creditId },
          });
        }
      }
      const [reservation] = await tx
        .update(billingFundingReservations)
        .set({ ...values, updated_at: new Date() })
        .where(
          and(
            eq(billingFundingReservations.organization_id, organizationId),
            eq(billingFundingReservations.id, reservationId),
            eq(billingFundingReservations.status, expectedStatus),
          ),
        )
        .returning();
      if (!reservation) {
        fundingConflict("Funding reservation status compare-and-swap lost", {
          reservationId,
          expectedStatus,
        });
      }
      return { reservation, replayed: false };
    });
  }
}

export const subscriptionFundingReservationsRepository =
  new SubscriptionFundingReservationsRepository();
