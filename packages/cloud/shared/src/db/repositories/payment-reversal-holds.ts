/**
 * Owns organization billing holds placed by Stripe payment reversals (#22930,
 * Decision A).
 *
 * A refund or dispute clawback that cannot take the full reversal from the
 * balance leaves an unrecovered shortfall. The clawback transaction records a
 * `reversal_shortfall` hold carrying that amount in the same statement (see
 * `CreditsService.clawbackCredits`). While any hold is active, new paid
 * admission fails closed. A hold clears when:
 * - repayment covers its outstanding amount (credits added to the balance are
 *   applied to the oldest outstanding shortfall first), or
 * - Stripe reinstates the disputed funds for the clawback that created it, or
 * - an operator releases it with an audited actor and reason.
 */
import { ElizaError } from "@elizaos/core";
import Decimal from "decimal.js";
import { and, asc, eq, isNull, type SQL, sql } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { sqlRows } from "../execute-helpers";
import { dbWrite, writeTransaction } from "../helpers";
import {
  type OrganizationPaymentReversalHold,
  organizationPaymentReversalHolds,
} from "../schemas/organization-payment-reversal-holds";
import { organizations } from "../schemas/organizations";

/** SQL predicate: the organization in scope has no unreleased reversal hold. */
export function organizationHasNoActivePaymentReversalHold(): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${organizationPaymentReversalHolds} AS reversal_hold
    WHERE reversal_hold.organization_id = ${organizations.id}
      AND reversal_hold.released_at IS NULL
  )`;
}

/** Reads active holds on the primary; funding admission must not trust a replica. */
export async function listActivePaymentReversalHolds(
  organizationId: string,
  executor: typeof dbWrite | DbTransaction = dbWrite,
): Promise<OrganizationPaymentReversalHold[]> {
  return executor
    .select()
    .from(organizationPaymentReversalHolds)
    .where(
      and(
        eq(organizationPaymentReversalHolds.organization_id, organizationId),
        isNull(organizationPaymentReversalHolds.released_at),
      ),
    )
    .orderBy(
      asc(organizationPaymentReversalHolds.created_at),
      asc(organizationPaymentReversalHolds.id),
    );
}

export interface ReversalShortfallSettlement {
  /** USD moved from the balance to outstanding shortfalls by this settlement. */
  appliedUsd: string;
  /** USD still owed across active shortfall holds after this settlement. */
  outstandingUsd: string;
  /** Holds cleared because repayment covered them. */
  releasedHoldIds: string[];
  /** Ledger debit recording the repayment, when one was applied. */
  repaymentTransactionId: string | null;
}

function parseUsd(value: string | number | null, field: string): Decimal {
  const parsed = value === null ? null : new Decimal(String(value));
  if (!parsed?.isFinite()) {
    throw new ElizaError("Payment reversal hold carries a non-finite amount", {
      code: "PAYMENT_REVERSAL_HOLD_CORRUPT",
      context: { field, value: String(value) },
    });
  }
  return parsed;
}

async function settleInTransaction(
  tx: DbTransaction,
  organizationId: string,
): Promise<ReversalShortfallSettlement> {
  const [org] = await sqlRows<{ credit_balance: string }>(
    tx,
    sql`SELECT credit_balance::text AS credit_balance FROM organizations
        WHERE id = ${organizationId} FOR UPDATE`,
  );
  if (!org) {
    throw new ElizaError("Organization not found for reversal shortfall settlement", {
      code: "PAYMENT_REVERSAL_HOLD_ORG_NOT_FOUND",
      context: { organizationId },
    });
  }
  const holds = await sqlRows<{ id: string; outstanding_usd: string }>(
    tx,
    sql`SELECT id, outstanding_usd::text AS outstanding_usd
        FROM organization_payment_reversal_holds
        WHERE organization_id = ${organizationId}
          AND reason = 'reversal_shortfall'
          AND released_at IS NULL
        ORDER BY created_at, id
        FOR UPDATE`,
  );
  if (holds.length === 0) {
    return {
      appliedUsd: "0.000000",
      outstandingUsd: "0.000000",
      releasedHoldIds: [],
      repaymentTransactionId: null,
    };
  }

  let available = Decimal.max(parseUsd(org.credit_balance, "credit_balance"), 0);
  const allocations = holds.map((hold) => {
    const outstanding = parseUsd(hold.outstanding_usd, "outstanding_usd");
    const applied = Decimal.min(available, outstanding);
    available = available.minus(applied);
    return { id: hold.id, applied, remaining: outstanding.minus(applied) };
  });
  const applied = allocations.reduce((sum, row) => sum.plus(row.applied), new Decimal(0));

  let repaymentTransactionId: string | null = null;
  if (applied.gt(0)) {
    const appliedText = applied.toFixed(6);
    const [debit] = await sqlRows<{ id: string }>(
      tx,
      sql`INSERT INTO credit_transactions (organization_id, amount, type, description, metadata, created_at)
          VALUES (
            ${organizationId},
            ${`-${appliedText}`}::numeric,
            'debit',
            'Repayment of reversed payment shortfall',
            ${JSON.stringify({
              type: "reversal_shortfall_repayment",
              hold_allocations: allocations
                .filter((row) => row.applied.gt(0))
                .map((row) => ({ hold_id: row.id, applied_usd: row.applied.toFixed(6) })),
            })}::jsonb,
            NOW()
          )
          RETURNING id`,
    );
    if (!debit) {
      throw new ElizaError("Reversal shortfall repayment did not record a ledger debit", {
        code: "PAYMENT_REVERSAL_HOLD_REPAYMENT_FAILED",
        context: { organizationId },
      });
    }
    repaymentTransactionId = debit.id;
    await tx.execute(
      sql`UPDATE organizations
          SET credit_balance = credit_balance - ${appliedText}::numeric, updated_at = NOW()
          WHERE id = ${organizationId}`,
    );
  }

  const releasedHoldIds: string[] = [];
  for (const row of allocations) {
    if (row.applied.lte(0) && row.remaining.gt(0)) continue;
    const cleared = row.remaining.lte(0);
    await tx.execute(
      sql`UPDATE organization_payment_reversal_holds
          SET outstanding_usd = ${row.remaining.toFixed(6)}::numeric,
              released_at = CASE WHEN ${cleared} THEN NOW() ELSE NULL END,
              released_by = CASE WHEN ${cleared} THEN 'system:repayment' ELSE NULL END,
              release_reason = CASE WHEN ${cleared}
                THEN ${`Outstanding reversal shortfall repaid (credit transaction ${repaymentTransactionId ?? "none"})`}
                ELSE NULL END
          WHERE id = ${row.id}`,
    );
    if (cleared) releasedHoldIds.push(row.id);
  }

  const outstanding = allocations.reduce((sum, row) => sum.plus(row.remaining), new Decimal(0));
  return {
    appliedUsd: applied.toFixed(6),
    outstandingUsd: outstanding.toFixed(6),
    releasedHoldIds,
    repaymentTransactionId,
  };
}

/**
 * Applies the organization's current credit balance to its outstanding
 * reversal shortfalls, oldest first, under the organization lock. Idempotent:
 * with no balance or no outstanding shortfall it changes nothing.
 */
export async function settleReversalShortfalls(
  organizationId: string,
  tx?: DbTransaction,
): Promise<ReversalShortfallSettlement> {
  if (tx) return settleInTransaction(tx, organizationId);
  return writeTransaction((inner) => settleInTransaction(inner, organizationId));
}

/**
 * Clears the shortfall hold created by one clawback because Stripe returned
 * the disputed funds. Returns the hold (released now or earlier) so the caller
 * can return any repayment already applied to it, or null when that clawback
 * left no shortfall.
 */
export async function releaseShortfallHoldForReinstatement(input: {
  clawbackTransactionId: string;
  stripeDisputeId: string;
}): Promise<OrganizationPaymentReversalHold | null> {
  const [released] = await dbWrite
    .update(organizationPaymentReversalHolds)
    .set({
      released_at: new Date(),
      released_by: "system:dispute_reinstated",
      release_reason: `Stripe reinstated the funds for dispute ${input.stripeDisputeId}`,
    })
    .where(
      and(
        eq(organizationPaymentReversalHolds.clawback_transaction_id, input.clawbackTransactionId),
        isNull(organizationPaymentReversalHolds.released_at),
      ),
    )
    .returning();
  if (released) return released;
  const [existing] = await dbWrite
    .select()
    .from(organizationPaymentReversalHolds)
    .where(
      eq(organizationPaymentReversalHolds.clawback_transaction_id, input.clawbackTransactionId),
    )
    .limit(1);
  return existing ?? null;
}

/**
 * Explicit operator release (for example a support write-off). The actor and
 * reason are recorded; the remaining outstanding amount is kept for audit.
 */
export async function releasePaymentReversalHold(input: {
  organizationId: string;
  holdId: string;
  releasedBy: string;
  reason: string;
}): Promise<OrganizationPaymentReversalHold> {
  if (!input.releasedBy.trim() || !input.reason.trim()) {
    throw new ElizaError("Releasing a payment reversal hold requires an actor and a reason", {
      code: "PAYMENT_REVERSAL_HOLD_RELEASE_INVALID",
      context: { organizationId: input.organizationId, holdId: input.holdId },
    });
  }
  const [released] = await dbWrite
    .update(organizationPaymentReversalHolds)
    .set({ released_at: new Date(), released_by: input.releasedBy, release_reason: input.reason })
    .where(
      and(
        eq(organizationPaymentReversalHolds.organization_id, input.organizationId),
        eq(organizationPaymentReversalHolds.id, input.holdId),
        isNull(organizationPaymentReversalHolds.released_at),
      ),
    )
    .returning();
  if (!released) {
    throw new ElizaError("No active payment reversal hold matches this release", {
      code: "PAYMENT_REVERSAL_HOLD_NOT_ACTIVE",
      context: { organizationId: input.organizationId, holdId: input.holdId },
    });
  }
  return released;
}
