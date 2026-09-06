/** Claims fair primary-database recovery work and atomically publishes terminal observations with immutable attempt provenance. Provider reads happen outside these transactions. */
import { createHash, randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { dbWrite, writeTransaction } from "../helpers";
import {
  type BillingSubscription,
  billingSubscriptions,
  organizationSubscriptionAuthorities,
} from "../schemas/billing-subscriptions";
import { organizationEntitlements } from "../schemas/organization-entitlements";
import { organizations } from "../schemas/organizations";
import { subscriptionBillingFences } from "../schemas/subscription-billing-operations";
import {
  subscriptionReconciliationAttempts as attempts,
  type SubscriptionReconciliationAttempt,
  subscriptionReconciliationScans as scans,
} from "../schemas/subscription-reconciliation";
import { readPostLockDatabaseNow } from "./primary-database-clock";
import { subscriptionAuthorityRepository } from "./subscription-authority";
import { subscriptionEntitlementsRepository } from "./subscription-entitlements";
import {
  sameTerminalLifecycle,
  terminalReconciliationObservationSchema,
  validateTerminalSource,
} from "./subscription-lifecycle-finalization";
import { enqueueCanceledNoticeInTransaction } from "./subscription-notices";
import {
  type ReconciliationIdentity,
  readReconciliationLease,
  requireLiveReconciliationLease,
} from "./subscription-reconciliation-lease";
import { requireReconciliationProjection } from "./subscription-reconciliation-projection";
import { readLatestSubscriptionScheduleCommand } from "./subscription-schedule-lineage";

export function reconciliationDigest(value: object): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function unavailable(reason: string): never {
  throw new ElizaError("Subscription recovery requires a new authoritative observation", {
    code: "SUBSCRIPTION_RECONCILIATION_UNAVAILABLE",
    context: { reason },
  });
}
const eligibleStatuses = [
  "pending",
  "incomplete",
  "active",
  "grace",
  "past_due",
  "unpaid",
  "canceled",
  "incomplete_expired",
] as const;
export async function listDueSubscriptionReconciliations(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5) unavailable("invalid_batch_size");
  return dbWrite
    .select({
      organizationId: billingSubscriptions.organization_id,
      subscriptionId: billingSubscriptions.id,
    })
    .from(billingSubscriptions)
    .innerJoin(organizations, eq(organizations.id, billingSubscriptions.organization_id))
    .innerJoin(
      organizationSubscriptionAuthorities,
      and(
        eq(
          organizationSubscriptionAuthorities.organization_id,
          billingSubscriptions.organization_id,
        ),
        eq(organizationSubscriptionAuthorities.subscription_id, billingSubscriptions.id),
        eq(organizationSubscriptionAuthorities.state, "current"),
      ),
    )
    .leftJoin(
      scans,
      and(
        eq(scans.organization_id, billingSubscriptions.organization_id),
        eq(scans.subscription_id, billingSubscriptions.id),
      ),
    )
    .leftJoin(
      subscriptionBillingFences,
      eq(subscriptionBillingFences.organization_id, billingSubscriptions.organization_id),
    )
    .where(
      and(
        eq(organizations.is_active, true),
        eq(organizations.account_lifecycle_state, "active"),
        isNull(organizations.account_deletion_request_id),
        isNull(organizations.paid_work_fenced_at),
        or(
          isNull(subscriptionBillingFences.organization_id),
          eq(subscriptionBillingFences.state, "open"),
        ),
        eq(billingSubscriptions.provider, "stripe"),
        eq(billingSubscriptions.catalog_version, "v1"),
        inArray(billingSubscriptions.status, [...eligibleStatuses]),
        or(isNull(scans.next_due_at), lte(scans.next_due_at, sql`clock_timestamp()`)),
      ),
    )
    .orderBy(
      asc(sql`coalesce(${scans.next_due_at}, '-infinity'::timestamptz)`),
      asc(billingSubscriptions.organization_id),
      asc(billingSubscriptions.id),
    )
    .limit(limit);
}
async function lockOrganization(tx: DbTransaction, organizationId: string) {
  const [org] = await tx
    .select({
      id: organizations.id,
      is_active: organizations.is_active,
      account_lifecycle_state: organizations.account_lifecycle_state,
      account_deletion_request_id: organizations.account_deletion_request_id,
      paid_work_fenced_at: organizations.paid_work_fenced_at,
      stripe_customer_id: organizations.stripe_customer_id,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("update");
  const [association] = await tx
    .select()
    .from(organizationSubscriptionAuthorities)
    .where(eq(organizationSubscriptionAuthorities.organization_id, organizationId))
    .for("update");
  const [fence] = await tx
    .select()
    .from(subscriptionBillingFences)
    .where(eq(subscriptionBillingFences.organization_id, organizationId));
  return {
    org,
    association,
    deletionOwned:
      !org ||
      !org.is_active ||
      org.account_lifecycle_state !== "active" ||
      org.account_deletion_request_id !== null ||
      org.paid_work_fenced_at !== null ||
      (fence !== undefined && fence.state !== "open"),
  };
}
export interface ReconciliationClaim extends ReconciliationIdentity {
  source: BillingSubscription;
  organizationCustomerId: string | null;
  expectedProjectionRevision: number | null;
}
export async function claimSubscriptionReconciliation(input: {
  organizationId: string;
  subscriptionId: string;
}): Promise<ReconciliationClaim | null> {
  return writeTransaction(async (tx) => {
    const { org, association, deletionOwned } = await lockOrganization(tx, input.organizationId);
    if (
      deletionOwned ||
      !org ||
      association?.state !== "current" ||
      association.subscription_id !== input.subscriptionId
    )
      return null;
    const [source] = await tx
      .select()
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.id, input.subscriptionId),
          eq(billingSubscriptions.organization_id, input.organizationId),
        ),
      );
    if (!source || source.provider !== "stripe" || source.catalog_version !== "v1") return null;
    await tx
      .insert(scans)
      .values({ organization_id: input.organizationId, subscription_id: input.subscriptionId })
      .onConflictDoNothing();
    const [scan] = await tx
      .select()
      .from(scans)
      .where(
        and(
          eq(scans.organization_id, input.organizationId),
          eq(scans.subscription_id, input.subscriptionId),
        ),
      )
      .for("update");
    const now = await readPostLockDatabaseNow(tx);
    if (!scan || scan.next_due_at > now) return null;
    const [prior] = await tx
      .select()
      .from(attempts)
      .where(
        and(
          eq(attempts.organization_id, input.organizationId),
          eq(attempts.subscription_id, input.subscriptionId),
          eq(attempts.generation, scan.generation),
        ),
      )
      .for("update");
    if (prior?.disposition === "processing") {
      if (prior.expires_at > now) return null;
      await tx
        .update(attempts)
        .set({ disposition: "superseded", reason: "lease_expired", completed_at: now })
        .where(eq(attempts.id, prior.id));
    }
    const [projection] = await tx
      .select()
      .from(organizationEntitlements)
      .where(eq(organizationEntitlements.organization_id, input.organizationId));
    const expectedProjectionRevision = projection?.projection_revision ?? null;
    const identityDigest = reconciliationDigest({
      source,
      expectedProjectionRevision,
      organizationCustomerId: org.stripe_customer_id,
    });
    const identity: ReconciliationIdentity = {
      ...input,
      attemptId: randomUUID(),
      generation: scan.generation + 1,
      leaseToken: randomUUID(),
      expectedRevision: source.lifecycle_revision,
      identityDigest,
    };
    const expires = new Date(now.getTime() + 60_000);
    await tx.insert(attempts).values({
      id: identity.attemptId,
      organization_id: input.organizationId,
      subscription_id: input.subscriptionId,
      generation: identity.generation,
      lease_token: identity.leaseToken,
      expected_revision: identity.expectedRevision,
      expected_projection_revision: expectedProjectionRevision,
      identity_digest: identityDigest,
      started_at: now,
      expires_at: expires,
    });
    await tx
      .update(scans)
      .set({ generation: identity.generation, next_due_at: expires })
      .where(
        and(
          eq(scans.organization_id, input.organizationId),
          eq(scans.subscription_id, input.subscriptionId),
        ),
      );
    return {
      ...identity,
      source,
      organizationCustomerId: org.stripe_customer_id,
      expectedProjectionRevision,
    };
  });
}
type FailedDisposition = "unsupported" | "unavailable" | "stale" | "deletion_owned";
async function complete(
  tx: DbTransaction,
  input: ReconciliationIdentity,
  outcome: {
    disposition: Exclude<
      SubscriptionReconciliationAttempt["disposition"],
      "processing" | "superseded"
    >;
    digest?: string;
    observedRevision?: number;
    resultRevision?: number;
    reason?: string;
  },
) {
  const { scan, now } = await requireLiveReconciliationLease(tx, input);
  const success = outcome.disposition === "applied" || outcome.disposition === "no_change";
  const failures = success ? 0 : Math.min(scan.failures + 1, 32);
  const delay = success ? 300_000 : Math.min(300_000 * 2 ** Math.min(failures - 1, 4), 3_600_000);
  const [updated] = await tx
    .update(attempts)
    .set({
      disposition: outcome.disposition,
      observation_digest: outcome.digest ?? null,
      observed_revision: outcome.observedRevision ?? null,
      result_revision: outcome.resultRevision ?? null,
      reason: outcome.reason ?? null,
      completed_at: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(attempts.id, input.attemptId),
        eq(attempts.disposition, "processing"),
        eq(attempts.lease_token, input.leaseToken),
        eq(attempts.generation, input.generation),
        sql`${attempts.expires_at}>clock_timestamp()`,
      ),
    )
    .returning();
  if (!updated) unavailable("lease_expired_before_commit");
  await tx
    .update(scans)
    .set({ failures, next_due_at: new Date(now.getTime() + delay) })
    .where(
      and(
        eq(scans.organization_id, input.organizationId),
        eq(scans.subscription_id, input.subscriptionId),
        eq(scans.generation, input.generation),
      ),
    );
  return updated;
}
export async function failSubscriptionReconciliation(
  input: ReconciliationIdentity,
  disposition: FailedDisposition,
  reason: string,
) {
  return writeTransaction(async (tx) => {
    await lockOrganization(tx, input.organizationId);
    const { attempt } = await readReconciliationLease(tx, input);
    if (attempt.disposition !== "processing") return attempt;
    return complete(tx, input, { disposition, reason });
  });
}
export type ReconciliationObservation =
  | { kind: "terminal"; value: unknown }
  | { kind: "owned_schedule"; scheduled: boolean; canceledAt: Date | null };
export async function finalizeSubscriptionReconciliation(
  input: ReconciliationClaim,
  observation: ReconciliationObservation,
) {
  const parsedTerminal =
    observation.kind === "terminal"
      ? terminalReconciliationObservationSchema.safeParse(observation.value)
      : null;
  if (parsedTerminal && !parsedTerminal.success) unavailable("unsupported_terminal_observation");
  const terminal = parsedTerminal?.data ?? null;
  const normalized = terminal ? { ...terminal, provider_object_digest: undefined } : observation;
  const observationDigest = reconciliationDigest(normalized);
  return writeTransaction(async (tx) => {
    const { org, association, deletionOwned } = await lockOrganization(tx, input.organizationId);
    const { attempt } = await readReconciliationLease(tx, input);
    if (attempt.disposition !== "processing") {
      if (attempt.observation_digest !== observationDigest)
        unavailable("completed_observation_mismatch");
      return attempt;
    }
    const liveLease = await requireLiveReconciliationLease(tx, input);
    if (deletionOwned || !org)
      return complete(tx, input, {
        disposition: "deletion_owned",
        reason: "account_deletion_owns_source",
      });
    if (association?.state !== "current" || association.subscription_id !== input.subscriptionId)
      return complete(tx, input, { disposition: "stale", reason: "canonical_source_changed" });
    // All command writers hold this organization lock. Read lineage without acquiring a later command lock.
    const [source] = await tx
      .select()
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.id, input.subscriptionId),
          eq(billingSubscriptions.organization_id, input.organizationId),
        ),
      );
    const [projection] = await tx
      .select()
      .from(organizationEntitlements)
      .where(eq(organizationEntitlements.organization_id, input.organizationId));
    if (
      !source ||
      source.lifecycle_revision !== input.expectedRevision ||
      (projection?.projection_revision ?? null) !== attempt.expected_projection_revision ||
      reconciliationDigest({
        source,
        expectedProjectionRevision: attempt.expected_projection_revision,
        organizationCustomerId: org.stripe_customer_id,
      }) !== input.identityDigest
    )
      return complete(tx, input, { disposition: "stale", reason: "captured_authority_changed" });
    if (observation.kind === "owned_schedule") {
      const command = await readLatestSubscriptionScheduleCommand(tx, source);
      if (
        !command ||
        source.status !== "active" ||
        source.current_period_end === null ||
        source.current_period_end <= liveLease.now ||
        observation.scheduled !== source.cancel_at_period_end ||
        observation.canceledAt?.getTime() !== source.canceled_at?.getTime()
      )
        return complete(tx, input, {
          disposition: "unsupported",
          reason: "schedule_not_owned_by_current_command",
        });
      await requireReconciliationProjection(tx, source, attempt.expected_projection_revision);
      return complete(tx, input, {
        disposition: "no_change",
        digest: observationDigest,
        observedRevision: source.lifecycle_revision,
      });
    }
    if (!terminal) unavailable("terminal_observation_missing");
    validateTerminalSource(source, org.stripe_customer_id, terminal);
    if (sameTerminalLifecycle(source, terminal)) {
      await requireReconciliationProjection(tx, source, attempt.expected_projection_revision);
      return complete(tx, input, {
        disposition: "no_change",
        digest: observationDigest,
        observedRevision: source.lifecycle_revision,
      });
    }
    const lifecycle = await subscriptionAuthorityRepository.advanceReconciliationInTransaction(tx, {
      ...input,
      values: terminal,
    });
    if (
      lifecycle.replayed ||
      lifecycle.revision.source !== "reconciliation" ||
      lifecycle.revision.provider_event_id !== null ||
      lifecycle.revision.provider_event_created_at !== null ||
      lifecycle.subscription.lifecycle_revision !== input.expectedRevision + 1
    )
      unavailable("publication_provenance_mismatch");
    await subscriptionEntitlementsRepository.rebuildInTransaction(tx, {
      organizationId: input.organizationId,
      sourceSubscriptionId: input.subscriptionId,
      sourceSubscriptionRevision: lifecycle.subscription.lifecycle_revision,
      expectedProjectionRevision: attempt.expected_projection_revision,
    });
    if (lifecycle.subscription.status === "canceled")
      await enqueueCanceledNoticeInTransaction(tx, lifecycle.subscription);
    return complete(tx, input, {
      disposition: "applied",
      digest: observationDigest,
      observedRevision: lifecycle.subscription.lifecycle_revision,
      resultRevision: lifecycle.subscription.lifecycle_revision,
    });
  });
}
