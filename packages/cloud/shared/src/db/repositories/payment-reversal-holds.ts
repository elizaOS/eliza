/**
 * Owns organization holds placed by final payment reversals (#22930).
 *
 * Only a LOST chargeback creates a hold: the reversal is final and the
 * organization's funded position can no longer be trusted, so new paid
 * admission fails closed. Refunds, open disputes and won disputes never
 * create a hold. Timing for already-running resources, debt treatment and
 * automatic restoration are owner decisions that this module deliberately
 * does not infer; a hold ends only through an explicit, audited release.
 */
import { ElizaError } from "@elizaos/core";
import { and, eq, isNull, type SQL, sql } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import {
  type OrganizationPaymentReversalHold,
  organizationPaymentReversalHolds,
} from "../schemas/organization-payment-reversal-holds";
import { organizations } from "../schemas/organizations";

export interface LostChargebackHoldInput {
  organizationId: string;
  stripeDisputeId: string;
  stripeChargeId?: string | null;
  stripePaymentIntentId?: string | null;
  amountCents?: number | null;
}

/**
 * Idempotently records the hold for one lost dispute. Replays and
 * out-of-order redeliveries converge on the single row keyed by dispute.
 */
export async function recordLostChargebackHold(
  input: LostChargebackHoldInput,
): Promise<{ hold: OrganizationPaymentReversalHold; created: boolean }> {
  if (!input.stripeDisputeId.trim()) {
    throw new ElizaError("Lost chargeback hold requires a Stripe dispute id", {
      code: "PAYMENT_REVERSAL_HOLD_INVALID",
      context: { organizationId: input.organizationId },
    });
  }
  const [inserted] = await dbWrite
    .insert(organizationPaymentReversalHolds)
    .values({
      organization_id: input.organizationId,
      reason: "chargeback_lost",
      stripe_dispute_id: input.stripeDisputeId,
      stripe_charge_id: input.stripeChargeId ?? null,
      stripe_payment_intent_id: input.stripePaymentIntentId ?? null,
      amount_cents: input.amountCents ?? null,
    })
    .onConflictDoNothing({ target: organizationPaymentReversalHolds.stripe_dispute_id })
    .returning();
  if (inserted) return { hold: inserted, created: true };
  const [existing] = await dbWrite
    .select()
    .from(organizationPaymentReversalHolds)
    .where(eq(organizationPaymentReversalHolds.stripe_dispute_id, input.stripeDisputeId))
    .limit(1);
  if (!existing || existing.organization_id !== input.organizationId) {
    throw new ElizaError("Lost chargeback hold is bound to a different organization", {
      code: "PAYMENT_REVERSAL_HOLD_CONFLICT",
      context: { stripeDisputeId: input.stripeDisputeId },
    });
  }
  return { hold: existing, created: false };
}

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
    );
}

/**
 * Explicit operator release after the owner-defined restoration condition is
 * met (for example verified repayment). There is no automatic release path.
 */
export async function releasePaymentReversalHold(input: {
  organizationId: string;
  stripeDisputeId: string;
  releasedBy: string;
  reason: string;
}): Promise<OrganizationPaymentReversalHold> {
  if (!input.releasedBy.trim() || !input.reason.trim()) {
    throw new ElizaError("Releasing a payment reversal hold requires an actor and a reason", {
      code: "PAYMENT_REVERSAL_HOLD_RELEASE_INVALID",
      context: { organizationId: input.organizationId, stripeDisputeId: input.stripeDisputeId },
    });
  }
  const [released] = await dbWrite
    .update(organizationPaymentReversalHolds)
    .set({ released_at: new Date(), released_by: input.releasedBy, release_reason: input.reason })
    .where(
      and(
        eq(organizationPaymentReversalHolds.organization_id, input.organizationId),
        eq(organizationPaymentReversalHolds.stripe_dispute_id, input.stripeDisputeId),
        isNull(organizationPaymentReversalHolds.released_at),
      ),
    )
    .returning();
  if (!released) {
    throw new ElizaError("No active payment reversal hold matches this release", {
      code: "PAYMENT_REVERSAL_HOLD_NOT_ACTIVE",
      context: { organizationId: input.organizationId, stripeDisputeId: input.stripeDisputeId },
    });
  }
  return released;
}
