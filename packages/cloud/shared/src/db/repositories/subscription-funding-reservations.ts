/**
 * Provides transaction-scoped funding reservation and allocation persistence.
 * It validates exact source conservation but never opens a transaction or
 * mutates purchased-credit balances; the owning authority supplies both.
 */
import { ElizaError } from "@elizaos/core";
import { and, asc, eq } from "drizzle-orm";
import type { DbTransaction } from "../client";
import {
  type BillingFundingAllocation,
  type BillingFundingReservation,
  billingFundingAllocations,
  billingFundingReservations,
} from "../schemas/billing-funding-reservations";
import { creditTransactions } from "../schemas/credit-transactions";

export const SUBSCRIPTION_FUNDING_CONFLICT = "SUBSCRIPTION_FUNDING_CONFLICT";
export const SUBSCRIPTION_FUNDING_NOT_FOUND = "SUBSCRIPTION_FUNDING_NOT_FOUND";

export type CanonicalMoney = string & { readonly __canonicalMoney: unique symbol };
const MONEY_PATTERN = /^(0|[1-9]\d{0,9})\.\d{6}$/;
const MAX_MONEY_MICROS = 9_999_999_999_999_999n;

function conflict(message: string, context: Record<string, unknown>): never {
  throw new ElizaError(message, {
    code: SUBSCRIPTION_FUNDING_CONFLICT,
    context,
    severity: "fatal",
  });
}

export function moneyToMicros(value: string, field: string): bigint {
  if (!MONEY_PATTERN.test(value)) {
    conflict("Money must use canonical fixed-six decimal notation", { field, value });
  }
  const micros = BigInt(value.replace(".", ""));
  if (micros > MAX_MONEY_MICROS) conflict("Money exceeds numeric(16,6)", { field, value });
  return micros;
}

export function microsToMoney(value: bigint, field = "amount"): CanonicalMoney {
  if (value < 0n || value > MAX_MONEY_MICROS) {
    conflict("Money micro-units are outside numeric(16,6)", { field, value: value.toString() });
  }
  return `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, "0")}` as CanonicalMoney;
}

export interface CreateFundingPrerequisite {
  organizationId: string;
  logicalOperationId: string;
  requestDigest: string;
  fundingClass: "allowance_eligible" | "cash_only";
  requestedAmount: CanonicalMoney;
  allowancePeriodId: string | null;
  allowanceAmount: CanonicalMoney;
  purchasedCreditAmount: CanonicalMoney;
  purchasedCreditReservationTransactionId: string | null;
  expiresAt: Date;
}

export interface LockedFundingReservation {
  reservation: BillingFundingReservation;
  allocations: BillingFundingAllocation[];
}

async function requireCreditReference(
  tx: DbTransaction,
  organizationId: string,
  transactionId: string | null,
  amount: bigint,
): Promise<void> {
  if ((amount === 0n) !== (transactionId === null)) {
    conflict("Purchased-credit amount and reservation reference disagree", { organizationId });
  }
  if (!transactionId) return;
  const [row] = await tx
    .select({ id: creditTransactions.id })
    .from(creditTransactions)
    .where(
      and(
        eq(creditTransactions.organization_id, organizationId),
        eq(creditTransactions.id, transactionId),
      ),
    )
    .limit(1)
    .for("update");
  if (!row) {
    throw new ElizaError("Purchased-credit transaction does not exist", {
      code: SUBSCRIPTION_FUNDING_NOT_FOUND,
      context: { organizationId, transactionId },
    });
  }
}

function exactReservationReplay(row: BillingFundingReservation, input: CreateFundingPrerequisite) {
  return (
    row.request_digest === input.requestDigest &&
    row.funding_class === input.fundingClass &&
    row.requested_amount === input.requestedAmount &&
    row.reserved_amount === input.requestedAmount &&
    row.expires_at.getTime() === input.expiresAt.getTime()
  );
}

function exactAllocationReplay(rows: BillingFundingAllocation[], input: CreateFundingPrerequisite) {
  const allowance = rows.find((row) => row.source === "allowance");
  const purchased = rows.find((row) => row.source === "purchased_credit");
  return (
    (moneyToMicros(input.allowanceAmount, "allowanceAmount") === 0n
      ? allowance === undefined
      : allowance?.allowance_period_id === input.allowancePeriodId &&
        allowance.reserved_amount === input.allowanceAmount) &&
    (moneyToMicros(input.purchasedCreditAmount, "purchasedCreditAmount") === 0n
      ? purchased === undefined
      : purchased?.reserved_amount === input.purchasedCreditAmount &&
        purchased.purchased_credit_reservation_transaction_id ===
          input.purchasedCreditReservationTransactionId)
  );
}

export class SubscriptionFundingReservationsRepository {
  async lockById(
    tx: DbTransaction,
    organizationId: string,
    reservationId: string,
  ): Promise<LockedFundingReservation> {
    const [reservation] = await tx
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
    if (!reservation) {
      throw new ElizaError("Funding reservation does not exist", {
        code: SUBSCRIPTION_FUNDING_NOT_FOUND,
        context: { organizationId, reservationId },
      });
    }
    const allocations = await tx
      .select()
      .from(billingFundingAllocations)
      .where(
        and(
          eq(billingFundingAllocations.organization_id, organizationId),
          eq(billingFundingAllocations.reservation_id, reservationId),
        ),
      )
      .orderBy(asc(billingFundingAllocations.sequence))
      .for("update");
    return { reservation, allocations };
  }

  async createPrerequisite(
    tx: DbTransaction,
    input: CreateFundingPrerequisite,
  ): Promise<LockedFundingReservation & { replayed: boolean }> {
    const requested = moneyToMicros(input.requestedAmount, "requestedAmount");
    const allowance = moneyToMicros(input.allowanceAmount, "allowanceAmount");
    const purchased = moneyToMicros(input.purchasedCreditAmount, "purchasedCreditAmount");
    if (
      requested <= 0n ||
      allowance + purchased !== requested ||
      (input.fundingClass === "cash_only" && allowance !== 0n) ||
      (allowance === 0n) !== (input.allowancePeriodId === null)
    ) {
      conflict("Funding prerequisite does not conserve its requested amount", {
        logicalOperationId: input.logicalOperationId,
      });
    }
    const inserted = await tx
      .insert(billingFundingReservations)
      .values({
        organization_id: input.organizationId,
        logical_operation_id: input.logicalOperationId,
        request_digest: input.requestDigest,
        funding_class: input.fundingClass,
        requested_amount: input.requestedAmount,
        reserved_amount: input.requestedAmount,
        expires_at: input.expiresAt,
      })
      .onConflictDoNothing({
        target: [
          billingFundingReservations.organization_id,
          billingFundingReservations.logical_operation_id,
        ],
      })
      .returning();
    if (!inserted[0]) {
      const [existing] = await tx
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
      if (!existing || !exactReservationReplay(existing, input)) {
        conflict("Funding operation key conflicts with a different request", {
          logicalOperationId: input.logicalOperationId,
        });
      }
      const replay = await this.lockById(tx, input.organizationId, existing.id);
      await requireCreditReference(
        tx,
        input.organizationId,
        input.purchasedCreditReservationTransactionId,
        purchased,
      );
      if (!exactAllocationReplay(replay.allocations, input)) {
        conflict("Funding replay allocations differ from the original request", {
          reservationId: existing.id,
        });
      }
      return { ...replay, replayed: true };
    }
    const reservation = inserted[0];
    await requireCreditReference(
      tx,
      input.organizationId,
      input.purchasedCreditReservationTransactionId,
      purchased,
    );
    const allocationValues: (typeof billingFundingAllocations.$inferInsert)[] = [];
    if (allowance > 0n) {
      allocationValues.push({
        organization_id: input.organizationId,
        reservation_id: reservation.id,
        sequence: 1,
        source: "allowance",
        allowance_period_id: input.allowancePeriodId,
        reserved_amount: input.allowanceAmount,
      });
    }
    if (purchased > 0n) {
      allocationValues.push({
        organization_id: input.organizationId,
        reservation_id: reservation.id,
        sequence: allocationValues.length + 1,
        source: "purchased_credit",
        purchased_credit_reservation_transaction_id: input.purchasedCreditReservationTransactionId,
        reserved_amount: input.purchasedCreditAmount,
      });
    }
    const allocations = await tx
      .insert(billingFundingAllocations)
      .values(allocationValues)
      .returning();
    return { reservation, allocations, replayed: false };
  }

  async persistTerminal(
    tx: DbTransaction,
    locked: LockedFundingReservation,
    input: {
      kind: "settlement" | "cancellation";
      key: string;
      digest: string;
      actualAllowanceAmount: CanonicalMoney;
      actualPurchasedCreditAmount: CanonicalMoney;
      uncollectedOverageAmount: CanonicalMoney;
      allowanceExpired: boolean;
      purchasedCreditSettlementTransactionId: string | null;
      purchasedCreditRefundTransactionId: string | null;
      databaseNow: Date;
    },
  ): Promise<LockedFundingReservation & { replayed: boolean }> {
    const { reservation, allocations } = locked;
    if (reservation.status !== "reserved") {
      const replayed =
        (input.kind === "settlement" &&
          reservation.status === "finalized" &&
          reservation.settlement_key === input.key &&
          reservation.settlement_digest === input.digest) ||
        (input.kind === "cancellation" &&
          reservation.status === "canceled" &&
          reservation.cancellation_key === input.key &&
          reservation.cancellation_digest === input.digest);
      if (!replayed)
        conflict("Reservation already has a different terminal result", {
          reservationId: reservation.id,
        });
      return { ...locked, replayed: true };
    }
    const allowanceAllocation = allocations.find((row) => row.source === "allowance");
    const purchasedAllocation = allocations.find((row) => row.source === "purchased_credit");
    const actualAllowance = moneyToMicros(input.actualAllowanceAmount, "actualAllowanceAmount");
    const actualPurchased = moneyToMicros(
      input.actualPurchasedCreditAmount,
      "actualPurchasedCreditAmount",
    );
    // Canonical-form assertion: persistence stores this input directly after validation.
    moneyToMicros(input.uncollectedOverageAmount, "uncollectedOverageAmount");
    if (input.kind === "cancellation" && (actualAllowance !== 0n || actualPurchased !== 0n)) {
      conflict("Canceled reservations cannot finalize usage", {
        reservationId: reservation.id,
      });
    }
    const reservedAllowance = allowanceAllocation
      ? moneyToMicros(allowanceAllocation.reserved_amount, "reservedAllowance")
      : 0n;
    const reservedPurchased = purchasedAllocation
      ? moneyToMicros(purchasedAllocation.reserved_amount, "reservedPurchased")
      : 0n;
    if (actualAllowance > reservedAllowance || actualPurchased > reservedPurchased) {
      conflict("Terminal amounts exceed reserved sources", { reservationId: reservation.id });
    }
    await requireCreditReference(
      tx,
      reservation.organization_id,
      input.purchasedCreditSettlementTransactionId,
      actualPurchased,
    );
    await requireCreditReference(
      tx,
      reservation.organization_id,
      input.purchasedCreditRefundTransactionId,
      reservedPurchased - actualPurchased,
    );
    const updatedAllocations: BillingFundingAllocation[] = [];
    for (const allocation of allocations) {
      const actual = allocation.source === "allowance" ? actualAllowance : actualPurchased;
      const reserved = moneyToMicros(allocation.reserved_amount, "allocation.reservedAmount");
      const released = reserved - actual;
      const expiredRefund =
        allocation.source === "allowance" && input.allowanceExpired ? released : 0n;
      const [updated] = await tx
        .update(billingFundingAllocations)
        .set({
          finalized_amount: microsToMoney(actual),
          released_amount: microsToMoney(released - expiredRefund),
          expired_refund_amount: microsToMoney(expiredRefund),
          purchased_credit_settlement_transaction_id:
            allocation.source === "purchased_credit"
              ? input.purchasedCreditSettlementTransactionId
              : null,
          purchased_credit_refund_transaction_id:
            allocation.source === "purchased_credit"
              ? input.purchasedCreditRefundTransactionId
              : null,
          updated_at: input.databaseNow,
        })
        .where(
          and(
            eq(billingFundingAllocations.id, allocation.id),
            eq(billingFundingAllocations.finalized_amount, "0.000000"),
            eq(billingFundingAllocations.released_amount, "0.000000"),
            eq(billingFundingAllocations.expired_refund_amount, "0.000000"),
          ),
        )
        .returning();
      if (!updated)
        conflict("Funding allocation terminal compare-and-swap lost", {
          allocationId: allocation.id,
        });
      updatedAllocations.push(updated);
    }
    const terminalValues =
      input.kind === "settlement"
        ? {
            status: "finalized" as const,
            settlement_key: input.key,
            settlement_digest: input.digest,
            finalized_at: input.databaseNow,
          }
        : {
            status: "canceled" as const,
            cancellation_key: input.key,
            cancellation_digest: input.digest,
            canceled_at: input.databaseNow,
          };
    const [updatedReservation] = await tx
      .update(billingFundingReservations)
      .set({
        ...terminalValues,
        uncollected_overage_amount: input.uncollectedOverageAmount,
        updated_at: input.databaseNow,
      })
      .where(
        and(
          eq(billingFundingReservations.id, reservation.id),
          eq(billingFundingReservations.status, "reserved"),
        ),
      )
      .returning();
    if (!updatedReservation)
      conflict("Funding terminal compare-and-swap lost", { reservationId: reservation.id });
    return { reservation: updatedReservation, allocations: updatedAllocations, replayed: false };
  }
}

export const subscriptionFundingReservationsRepository =
  new SubscriptionFundingReservationsRepository();
