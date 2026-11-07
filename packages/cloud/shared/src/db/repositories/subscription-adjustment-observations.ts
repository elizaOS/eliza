/** Records read-only adjustment observations; monetary correction remains a separate policy-bound transaction. */
import { ElizaError } from "@elizaos/core";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { assertOrganizationSubscription } from "../../lib/services/organization-subscription-source";
import { observeRetainedRenewalAdjustments } from "../../lib/services/renewal-adjustment-observation";
import { settlementDigest } from "../../lib/services/settlement-digest";
import type { DbTransaction } from "../client";
import { writeTransaction } from "../helpers";
import {
  billingSubscriptionRevisions,
  billingSubscriptions,
} from "../schemas/billing-subscriptions";
import { organizations } from "../schemas/organizations";
import { subscriptionAdjustmentObservations as observations } from "../schemas/subscription-adjustment-observations";
import { subscriptionAllowancePeriods as periods } from "../schemas/subscription-allowance-periods";
import { subscriptionAllowanceTransactions as grants } from "../schemas/subscription-allowance-transactions";
import { readPostLockDatabaseNow } from "./primary-database-clock";
import {
  type AdjustmentRecoveryIdentity,
  completeAdjustmentLease,
  requireAdjustmentLease,
} from "./subscription-adjustment-lease";

const request = z
  .object({
    organizationId: z.string().uuid(),
    grantId: z.string().uuid(),
    requestId: z.string().uuid(),
    expectedPreviousId: z.string().uuid().nullable(),
  })
  .strict();
function unavailable(): never {
  throw new ElizaError("Original grant adjustment observation is unavailable or stale", {
    code: "SUBSCRIPTION_ADJUSTMENT_OBSERVATION_UNAVAILABLE",
  });
}
export async function loadOriginalAdjustmentGrant(
  tx: DbTransaction,
  input: z.infer<typeof request>,
) {
  const [org] = await tx
    .select({
      id: organizations.id,
      is_active: organizations.is_active,
      account_lifecycle_state: organizations.account_lifecycle_state,
      account_deletion_request_id: organizations.account_deletion_request_id,
      paid_work_fenced_at: organizations.paid_work_fenced_at,
    })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .for("update");
  if (
    !org ||
    !org.is_active ||
    org.account_lifecycle_state !== "active" ||
    org.account_deletion_request_id ||
    org.paid_work_fenced_at
  )
    unavailable();
  const [grant] = await tx
    .select()
    .from(grants)
    .where(and(eq(grants.id, input.grantId), eq(grants.organization_id, input.organizationId)));
  if (
    !grant ||
    grant.kind !== "grant" ||
    grant.billing_scope_id !== null ||
    grant.merchant_key !== "platform"
  )
    unavailable();
  const [period] = await tx
    .select()
    .from(periods)
    .where(
      and(
        eq(periods.id, grant.allowance_period_id),
        eq(periods.organization_id, input.organizationId),
      ),
    );
  if (
    !period ||
    !period.subscription_id ||
    !period.subscription_revision ||
    !period.stripe_invoice_id ||
    period.billing_scope_id !== null ||
    period.merchant_key !== "platform" ||
    period.grant_source !== "paid_invoice"
  )
    unavailable();
  const [existing] = await tx
    .select()
    .from(observations)
    .where(and(eq(observations.grant_id, grant.id), eq(observations.request_id, input.requestId)));
  if (existing) {
    if (
      existing.organization_id !== input.organizationId ||
      existing.previous_id !== input.expectedPreviousId
    )
      unavailable();
    return { existing } as const;
  }
  const [head] = await tx
    .select()
    .from(observations)
    .where(eq(observations.grant_id, grant.id))
    .orderBy(desc(observations.version))
    .limit(1);
  if ((head?.id ?? null) !== input.expectedPreviousId) unavailable();
  const [source] = await tx
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.id, period.subscription_id),
        eq(billingSubscriptions.organization_id, input.organizationId),
      ),
    );
  const [revision] = await tx
    .select()
    .from(billingSubscriptionRevisions)
    .where(
      and(
        eq(billingSubscriptionRevisions.subscription_id, period.subscription_id),
        eq(billingSubscriptionRevisions.organization_id, input.organizationId),
        eq(billingSubscriptionRevisions.revision, period.subscription_revision),
      ),
    );
  if (
    !source ||
    !revision ||
    revision.provider !== source.provider ||
    revision.provider_environment !== source.provider_environment
  )
    unavailable();
  const original = {
    ...source,
    ...revision,
    id: revision.subscription_id,
    lifecycle_revision: revision.revision,
  };
  assertOrganizationSubscription(original);
  const databaseNow = await readPostLockDatabaseNow(tx);
  return { grant, period, original, databaseNow, version: (head?.version ?? 0) + 1 } as const;
}
/** Private server API: caller authenticates and supplies a stable request UUID plus the last
 * journal head it read. Provider reads occur outside locks. Publication reloads the original
 * grant and organization fence, and rejects a competing append. Retry returns the first
 * durable observation for the same request; it never refreshes or changes that observation. */
export async function observeAndRecordRenewalAdjustment(
  value: z.infer<typeof request>,
  stripe: Parameters<typeof observeRetainedRenewalAdjustments>[1],
  recovery?: AdjustmentRecoveryIdentity,
) {
  const parsed = request.safeParse(value);
  if (!parsed.success) unavailable();
  const input = parsed.data;
  if (
    recovery &&
    (recovery.organizationId !== input.organizationId ||
      recovery.grantId !== input.grantId ||
      recovery.attemptId !== input.requestId)
  )
    unavailable();
  const before = await writeTransaction(async (tx) => {
    const loaded = await loadOriginalAdjustmentGrant(tx, input);
    if (recovery) {
      if (loaded.existing) await completeAdjustmentLease(tx, recovery, loaded.existing.id);
      else {
        const lease = await requireAdjustmentLease(tx, recovery);
        if (
          lease.attempt.expected_previous_id !== input.expectedPreviousId ||
          recovery.originalDigest !== settlementDigest(loaded.grant.metadata)
        )
          unavailable();
      }
    }
    return loaded;
  });
  if (before.existing) return { observation: before.existing, replayed: true };
  const evidence = await observeRetainedRenewalAdjustments(
    {
      source: before.original,
      invoiceId: before.period.stripe_invoice_id!,
      grantDigest: before.grant.request_digest,
      metadata: before.grant.metadata,
    },
    stripe,
  );
  return writeTransaction(async (tx) => {
    const after = await loadOriginalAdjustmentGrant(tx, input);
    if (after.existing) {
      if (recovery) await completeAdjustmentLease(tx, recovery, after.existing.id);
      return { observation: after.existing, replayed: true };
    }
    if (recovery) {
      const lease = await requireAdjustmentLease(tx, recovery);
      if (
        lease.attempt.expected_previous_id !== input.expectedPreviousId ||
        recovery.originalDigest !== settlementDigest(after.grant.metadata)
      )
        unavailable();
    }
    if (
      after.grant.request_digest !== before.grant.request_digest ||
      after.version !== before.version ||
      after.grant.metadata.renewalInvoiceAuthority === undefined ||
      JSON.stringify(after.grant.metadata) !== JSON.stringify(before.grant.metadata)
    )
      unavailable();
    const [saved] = await tx
      .insert(observations)
      .values({
        organization_id: input.organizationId,
        grant_id: input.grantId,
        request_id: input.requestId,
        version: before.version,
        previous_id: input.expectedPreviousId,
        observation: evidence,
        observed_at: after.databaseNow,
      })
      .returning();
    if (!saved) unavailable();
    if (recovery) await completeAdjustmentLease(tx, recovery, saved.id);
    return { observation: saved, replayed: false };
  });
}
