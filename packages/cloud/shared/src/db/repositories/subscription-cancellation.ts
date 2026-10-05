/** Serializes organization cancellation intent, provider leases and atomic lifecycle publication against primary actor and subscription authority. Provider requests occur outside these transactions. */

import { createHash, randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { observeConfiguredCancellation } from "../../lib/services/configured-schedule-cancellation";
import { validatePeriodEndCancellationObservation } from "../../lib/services/stripe-period-end-cancellation";
import { resolveSubscriptionLifecycleBinding } from "../../lib/services/subscription-lifecycle-provider-binding";
import {
  type SubscriptionRenewalReview,
  subscriptionRenewalReviewSchema,
} from "../../lib/services/subscription-renewal-review-contract";
import type { DbTransaction } from "../client";
import { dbWrite, writeTransaction } from "../helpers";
import { organizationSubscriptionAuthorities } from "../schemas/billing-subscriptions";
import { organizationEntitlements } from "../schemas/organization-entitlements";
import { organizations } from "../schemas/organizations";
import {
  type BillingSubscriptionCommand,
  billingSubscriptionCommands,
  billingSubscriptionRenewalReviews,
} from "../schemas/subscription-billing-operations";
import { readConfiguredCancellationAuthority } from "./configured-schedule-cancellation-authority";
import {
  lockCurrentOrganizationSubscription,
  lockOrganizationSubscriptionManager,
} from "./organization-subscription-manager";
import { readPostLockDatabaseNow } from "./primary-database-clock";
import { subscriptionAuthorityRepository } from "./subscription-authority";
import { subscriptionEntitlementsRepository } from "./subscription-entitlements";
import { readLatestSubscriptionScheduleCommand } from "./subscription-schedule-lineage";

export interface CancellationIdentity {
  organizationId: string;
  actorId: string;
}
export interface PrepareCancellationInput extends CancellationIdentity {
  subscriptionId: string;
  expectedSubscriptionRevision: number;
  idempotencyKey: string;
  renewalReview?: SubscriptionRenewalReview;
}
function reject(reason: string): never {
  throw new ElizaError("Organization subscription cancellation is not currently authorized", {
    code:
      reason === "command_unavailable"
        ? "SUBSCRIPTION_CANCELLATION_NOT_FOUND"
        : reason === "current_manager_required" || reason === "organization_authority_unavailable"
          ? "SUBSCRIPTION_CANCELLATION_FORBIDDEN"
          : "SUBSCRIPTION_CANCELLATION_CONFLICT",
    context: { reason },
  });
}
function lockActor(tx: DbTransaction, input: CancellationIdentity) {
  return lockOrganizationSubscriptionManager(tx, input, reject);
}
async function currentSource(
  tx: DbTransaction,
  input: Omit<PrepareCancellationInput, "idempotencyKey">,
  locked: Awaited<ReturnType<typeof lockActor>>,
) {
  const source = await lockCurrentOrganizationSubscription(
    tx,
    input,
    locked,
    reject,
    "configured_cancellation",
  );
  if (source.pending_plan_key !== null) await readConfiguredCancellationAuthority(tx, source);
  return source;
}
/** Source checks that fail for good once the subscription moved past the command's revision. */
const STALE_SOURCE_REASONS = new Set([
  "current_subscription_unavailable",
  "source_changed_or_unsupported",
  "schedule_predecessor_changed",
]);
function isStaleSourceRejection(error: unknown): boolean {
  if (!(error instanceof ElizaError)) return false;
  const reason = (error.context as { reason?: unknown } | undefined)?.reason;
  return typeof reason === "string" && STALE_SOURCE_REASONS.has(reason);
}
/**
 * A PREPARED cancellation was never claimed, so it never crossed the dispatch
 * fence. Once its subscription moved on it can never be claimed either; left
 * PREPARED it would block every later cancel or undo for the organization.
 */
async function supersedeStalePreparedCancellation(
  tx: DbTransaction,
  organizationId: string,
  commandId: string,
  now: Date,
) {
  await tx
    .update(billingSubscriptionCommands)
    .set({
      status: "SUPERSEDED",
      error_code: "SUBSCRIPTION_CHANGED_BEFORE_DISPATCH",
      state_revision: sql`${billingSubscriptionCommands.state_revision} + 1`,
      completed_at: now,
      updated_at: now,
    })
    .where(
      and(
        isNull(billingSubscriptionCommands.billing_scope_id),
        isNull(billingSubscriptionCommands.app_id),
        eq(billingSubscriptionCommands.organization_id, organizationId),
        eq(billingSubscriptionCommands.id, commandId),
        inArray(billingSubscriptionCommands.kind, ["cancel", "resume"]),
        eq(billingSubscriptionCommands.status, "PREPARED"),
      ),
    );
}
/**
 * Live organization commands split into those that block a new schedule
 * change and stale PREPARED cancellations pinned to an older subscription
 * revision, which can never be claimed and must not block.
 */
async function liveScheduleCommands(
  tx: DbTransaction,
  organizationId: string,
  source: import("../schemas/billing-subscriptions").BillingSubscription,
) {
  const live = await tx
    .select({
      id: billingSubscriptionCommands.id,
      kind: billingSubscriptionCommands.kind,
      status: billingSubscriptionCommands.status,
      subscriptionId: billingSubscriptionCommands.subscription_id,
      expectedRevision: billingSubscriptionCommands.expected_subscription_revision,
    })
    .from(billingSubscriptionCommands)
    .where(
      and(
        isNull(billingSubscriptionCommands.billing_scope_id),
        isNull(billingSubscriptionCommands.app_id),
        eq(billingSubscriptionCommands.organization_id, organizationId),
        inArray(billingSubscriptionCommands.status, ["PREPARED", "OUTCOME_UNKNOWN", "SUCCEEDED"]),
      ),
    );
  const isStale = (command: (typeof live)[number]) =>
    command.status === "PREPARED" &&
    (command.kind === "cancel" || command.kind === "resume") &&
    (command.subscriptionId !== source.id ||
      command.expectedRevision !== source.lifecycle_revision);
  return {
    blocking: live.filter((command) => !isStale(command)),
    stale: live.filter(isStale),
  };
}
/** Captures eligible undo authority without admitting a command or sending a provider mutation. */
export async function readCancellationUndoReviewSource(
  input: Omit<PrepareCancellationInput, "idempotencyKey">,
) {
  return writeTransaction(async (tx) => {
    const locked = await lockActor(tx, input);
    const source = await currentSource(tx, input, locked);
    const predecessor = await readLatestSubscriptionScheduleCommand(tx, source);
    if (!source.cancel_at_period_end || predecessor?.kind !== "cancel")
      reject("schedule_transition_unavailable");
    // A stale PREPARED command cannot be claimed; the next prepare supersedes it.
    const { blocking } = await liveScheduleCommands(tx, input.organizationId, source);
    if (blocking.length) reject("contradictory_command_pending");
    const [projection] = await tx
      .select()
      .from(organizationEntitlements)
      .where(
        and(
          isNull(organizationEntitlements.billing_scope_id),
          eq(organizationEntitlements.organization_id, input.organizationId),
        ),
      );
    if (
      !projection ||
      projection.source_subscription_id !== source.id ||
      projection.source_subscription_revision !== source.lifecycle_revision
    )
      reject("projection_unavailable");
    return {
      source,
      organizationCustomerId: locked.organization.customer,
      configuredCancellation: await readConfiguredCancellationAuthority(tx, source),
    };
  });
}
function intentDigest(
  input: PrepareCancellationInput,
  kind: "cancel" | "resume",
  predecessorCommandId: string | null = null,
  renewalTermsDigest = input.renewalReview?.termsDigest,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        organizationId: input.organizationId,
        actorId: input.actorId,
        subscriptionId: input.subscriptionId,
        expectedSubscriptionRevision: input.expectedSubscriptionRevision,
        kind: kind === "cancel" ? "cancel_at_period_end" : "undo_cancel_at_period_end",
        ...(predecessorCommandId === null ? {} : { predecessorCommandId }),
        ...(renewalTermsDigest === undefined ? {} : { renewalTermsDigest }),
      }),
    )
    .digest("hex");
}
export async function prepareCancellation(
  input: PrepareCancellationInput,
  kind: "cancel" | "resume" = "cancel",
): Promise<BillingSubscriptionCommand> {
  if (input.renewalReview !== undefined && kind !== "resume") reject("review_requires_undo");
  return writeTransaction(async (tx) => {
    const locked = await lockActor(tx, input);
    const [existing] = await tx
      .select()
      .from(billingSubscriptionCommands)
      .where(
        and(
          isNull(billingSubscriptionCommands.billing_scope_id),
          isNull(billingSubscriptionCommands.app_id),
          eq(billingSubscriptionCommands.organization_id, input.organizationId),
          eq(billingSubscriptionCommands.idempotency_key, input.idempotencyKey),
        ),
      )
      .for("update");
    if (existing) {
      if (
        existing.kind !== kind ||
        existing.request_digest !==
          intentDigest(input, kind, existing.schedule_predecessor_command_id)
      )
        reject("idempotency_intent_changed");
      return existing;
    }
    const source = await currentSource(tx, input, locked);
    if (
      kind === "resume" &&
      input.renewalReview === undefined &&
      (await readConfiguredCancellationAuthority(tx, source))
    )
      reject("configured_resume_requires_renewal_review");
    const predecessor = await readLatestSubscriptionScheduleCommand(tx, source);
    if (
      kind === "resume"
        ? !source.cancel_at_period_end || predecessor?.kind !== "cancel"
        : source.cancel_at_period_end || (predecessor !== null && predecessor.kind !== "resume")
    )
      reject("schedule_transition_unavailable");
    const { blocking, stale } = await liveScheduleCommands(tx, input.organizationId, source);
    if (blocking.length) reject("contradictory_command_pending");
    for (const command of stale)
      await supersedeStalePreparedCancellation(tx, input.organizationId, command.id, locked.now);
    if (input.renewalReview !== undefined) {
      const parsed = subscriptionRenewalReviewSchema.safeParse(input.renewalReview);
      if (!parsed.success) reject("renewal_review_invalid");
      const review = parsed.data;
      const observed = Date.parse(review.observedAt),
        expires = Date.parse(review.expiresAt);
      if (
        review.subscriptionId !== source.id ||
        review.expectedSubscriptionRevision !== String(source.lifecycle_revision) ||
        review.catalogVersion !== source.catalog_version ||
        review.planKey !== source.plan_key ||
        review.renewalAt !== source.current_period_end?.toISOString() ||
        observed > locked.now.getTime() + 5000 ||
        expires <= locked.now.getTime() ||
        expires > observed + 60_000 ||
        expires <= observed
      )
        reject("renewal_review_expired_or_changed");
    }
    const id = randomUUID();
    const [command] = await tx
      .insert(billingSubscriptionCommands)
      .values({
        id,
        organization_id: input.organizationId,
        requested_by_user_id: input.actorId,
        subscription_id: input.subscriptionId,
        kind,
        schedule_predecessor_command_id: predecessor?.id ?? null,
        cancellation_dispatch_state: "ready",
        expected_subscription_revision: input.expectedSubscriptionRevision,
        idempotency_key: input.idempotencyKey,
        provider_idempotency_key: `organization-cancellation:${id}`,
        request_digest: intentDigest(input, kind, predecessor?.id ?? null),
        created_at: locked.now,
        updated_at: locked.now,
      })
      .returning();
    if (!command) reject("command_insert_failed");
    if (input.renewalReview !== undefined)
      await tx.insert(billingSubscriptionRenewalReviews).values({
        command_id: command.id,
        organization_id: input.organizationId,
        payload: input.renewalReview,
        expires_at: new Date(input.renewalReview.expiresAt),
        created_at: locked.now,
      });
    return command;
  });
}
export async function readCancellation(
  input: CancellationIdentity & { commandId: string },
  kind: "cancel" | "resume" = "cancel",
) {
  return writeTransaction(async (tx) => {
    await lockActor(tx, input);
    const [command] = await tx
      .select()
      .from(billingSubscriptionCommands)
      .where(
        and(
          isNull(billingSubscriptionCommands.billing_scope_id),
          isNull(billingSubscriptionCommands.app_id),
          eq(billingSubscriptionCommands.organization_id, input.organizationId),
          eq(billingSubscriptionCommands.id, input.commandId),
          eq(billingSubscriptionCommands.kind, kind),
        ),
      );
    if (!command) reject("command_unavailable");
    return command;
  });
}
export async function claimCancellation(
  input: CancellationIdentity & { commandId: string },
  kind: "cancel" | "resume" = "cancel",
) {
  return writeTransaction(async (tx) => {
    const locked = await lockActor(tx, input);
    const [command] = await tx
      .select()
      .from(billingSubscriptionCommands)
      .where(
        and(
          isNull(billingSubscriptionCommands.billing_scope_id),
          isNull(billingSubscriptionCommands.app_id),
          eq(billingSubscriptionCommands.organization_id, input.organizationId),
          eq(billingSubscriptionCommands.id, input.commandId),
        ),
      )
      .for("update");
    if (
      !command ||
      command.kind !== kind ||
      command.requested_by_user_id !== input.actorId ||
      command.subscription_id === null ||
      command.expected_subscription_revision === null
    )
      reject("command_unavailable");
    if (command.status !== "PREPARED" && command.status !== "OUTCOME_UNKNOWN") return null;
    const now = await readPostLockDatabaseNow(tx);
    if (command.lease_expires_at !== null && command.lease_expires_at > now) return null;
    let source: Awaited<ReturnType<typeof currentSource>>;
    try {
      source = await currentSource(
        tx,
        {
          ...input,
          subscriptionId: command.subscription_id,
          expectedSubscriptionRevision: command.expected_subscription_revision,
        },
        locked,
      );
      await validatePredecessor(tx, source, command);
    } catch (error) {
      if (command.status !== "PREPARED" || !isStaleSourceRejection(error)) throw error;
      // Nothing was sent to the provider; settle it so the organization can retry.
      await supersedeStalePreparedCancellation(tx, input.organizationId, command.id, now);
      return null;
    }
    const [projection] = await tx
      .select()
      .from(organizationEntitlements)
      .where(
        and(
          isNull(organizationEntitlements.billing_scope_id),
          eq(organizationEntitlements.organization_id, input.organizationId),
          isNull(organizationEntitlements.billing_scope_id),
        ),
      );
    if (
      !projection ||
      projection.source_subscription_id !== source.id ||
      projection.source_subscription_revision !== source.lifecycle_revision
    )
      reject("projection_unavailable");
    const leaseToken = randomUUID();
    const [claimed] = await tx
      .update(billingSubscriptionCommands)
      .set({
        status: "OUTCOME_UNKNOWN",
        state_revision: command.state_revision + 1,
        execution_generation: command.execution_generation + 1,
        attempt_count: command.attempt_count + 1,
        lease_token: leaseToken,
        lease_expires_at: new Date(now.getTime() + 60_000),
        provider_started_at: command.provider_started_at ?? now,
        updated_at: now,
      })
      .where(eq(billingSubscriptionCommands.id, command.id))
      .returning();
    if (!claimed) reject("claim_failed");
    return {
      command: claimed,
      source,
      configuredCancellation: await readConfiguredCancellationAuthority(tx, source),
      organizationCustomerId: locked.organization.customer,
      projectionRevision: projection.projection_revision,
      canDispatch: command.cancellation_dispatch_state === "ready",
    };
  });
}
export type CancellationClaim = NonNullable<Awaited<ReturnType<typeof claimCancellation>>>;
/** Retains uncertainty and releases only this attempt; later recovery can inspect without redispatching. */
export async function releaseCancellation(input: CancellationIdentity, claim: CancellationClaim) {
  return writeTransaction(async (tx) => {
    await lockActor(tx, input);
    await tx
      .update(billingSubscriptionCommands)
      .set({ lease_token: null, lease_expires_at: null, updated_at: sql`clock_timestamp()` })
      .where(
        and(
          isNull(billingSubscriptionCommands.billing_scope_id),
          isNull(billingSubscriptionCommands.app_id),
          eq(billingSubscriptionCommands.id, claim.command.id),
          eq(billingSubscriptionCommands.organization_id, input.organizationId),
          eq(billingSubscriptionCommands.status, "OUTCOME_UNKNOWN"),
          eq(billingSubscriptionCommands.lease_token, claim.command.lease_token!),
          eq(billingSubscriptionCommands.execution_generation, claim.command.execution_generation),
        ),
      );
  });
}
export async function finalizeCancellation(
  input: CancellationIdentity,
  claim: CancellationClaim,
  raw: unknown,
  providerAccountId?: string,
  rawSchedule?: unknown,
) {
  return writeTransaction(async (tx) => {
    const locked = await lockActor(tx, input);
    const [command] = await tx
      .select()
      .from(billingSubscriptionCommands)
      .where(
        and(
          isNull(billingSubscriptionCommands.billing_scope_id),
          isNull(billingSubscriptionCommands.app_id),
          eq(billingSubscriptionCommands.organization_id, input.organizationId),
          eq(billingSubscriptionCommands.id, claim.command.id),
        ),
      )
      .for("update");
    if (
      !command ||
      (command.kind !== "cancel" && command.kind !== "resume") ||
      command.requested_by_user_id !== input.actorId
    )
      reject("command_unavailable");
    if (command.status === "APPLIED") return command;
    const now = await readPostLockDatabaseNow(tx);
    if (
      command.status !== "OUTCOME_UNKNOWN" ||
      command.lease_token !== claim.command.lease_token ||
      command.execution_generation !== claim.command.execution_generation ||
      command.lease_expires_at === null ||
      command.lease_expires_at <= now
    )
      reject("command_lease_lost");
    const source = await currentSource(
      tx,
      {
        ...input,
        subscriptionId: claim.source.id,
        expectedSubscriptionRevision: claim.source.lifecycle_revision,
      },
      locked,
    );
    await validatePredecessor(tx, source, command);
    const configuredCancellation = await readConfiguredCancellationAuthority(tx, source);
    if (configuredCancellation?.authorityDigest !== claim.configuredCancellation?.authorityDigest)
      reject("configured_cancellation_authority_changed");
    const environment = await resolveSubscriptionLifecycleBinding(source, providerAccountId, tx);
    const observed = configuredCancellation
      ? observeConfiguredCancellation({
          authority: configuredCancellation,
          source,
          rawSubscription: raw,
          rawSchedule,
          observedAt: now,
        })
      : validatePeriodEndCancellationObservation({
          source,
          organizationCustomerId: locked.organization.customer,
          environment,
          raw,
          observedAt: now,
          requireScheduled: command.kind === "cancel",
          allowRetainedCanceledAt: source.canceled_at,
        });
    if (observed.scheduled !== (command.kind === "cancel")) reject("schedule_effect_unconfirmed");
    const values = {
      provider: source.provider,
      provider_environment: source.provider_environment,
      stripe_customer_id: source.stripe_customer_id,
      stripe_subscription_id: source.stripe_subscription_id,
      stripe_subscription_item_id: source.stripe_subscription_item_id,
      catalog_version: source.catalog_version,
      plan_key: source.plan_key,
      status: source.status,
      current_period_start: source.current_period_start,
      current_period_end: source.current_period_end,
      ended_at: source.ended_at,
      dunning_started_at: source.dunning_started_at,
      grace_expires_at: source.grace_expires_at,
      pending_plan_key: configuredCancellation ? null : source.pending_plan_key,
    };
    const changed = await subscriptionAuthorityRepository.advanceCommandInTransaction(tx, {
      organizationId: input.organizationId,
      subscriptionId: source.id,
      expectedRevision: source.lifecycle_revision,
      commandId: command.id,
      commandLeaseToken: command.lease_token!,
      commandExecutionGeneration: command.execution_generation,
      observation: "authoritative_provider_retrieval",
      values: {
        ...values,
        cancel_at_period_end: command.kind === "cancel",
        canceled_at: observed.canceledAt,
        provider_object_digest: observed.providerObjectDigest,
      },
    });
    await subscriptionEntitlementsRepository.rebuildInTransaction(tx, {
      organizationId: input.organizationId,
      sourceSubscriptionId: source.id,
      sourceSubscriptionRevision: changed.subscription.lifecycle_revision,
      expectedProjectionRevision: claim.projectionRevision,
    });
    const [applied] = await tx
      .update(billingSubscriptionCommands)
      .set({
        status: "APPLIED",
        state_revision: command.state_revision + 1,
        lease_token: null,
        lease_expires_at: null,
        provider_response_digest: observed.providerObjectDigest,
        result_subscription_id: source.id,
        result_subscription_revision: changed.subscription.lifecycle_revision,
        completed_at: sql`clock_timestamp()`,
        applied_at: sql`clock_timestamp()`,
        updated_at: sql`clock_timestamp()`,
      })
      .where(
        and(
          isNull(billingSubscriptionCommands.billing_scope_id),
          isNull(billingSubscriptionCommands.app_id),
          eq(billingSubscriptionCommands.id, command.id),
          eq(billingSubscriptionCommands.status, "OUTCOME_UNKNOWN"),
          eq(billingSubscriptionCommands.lease_token, command.lease_token!),
          eq(billingSubscriptionCommands.execution_generation, command.execution_generation),
          gt(billingSubscriptionCommands.lease_expires_at, sql`clock_timestamp()`),
        ),
      )
      .returning();
    if (!applied) reject("finalization_lease_lost");
    return applied;
  });
}
function recoverableCancellationState() {
  return sql`(${billingSubscriptionCommands.status} = 'OUTCOME_UNKNOWN' OR (
    ${billingSubscriptionCommands.status} = 'PREPARED' AND EXISTS (
      SELECT 1 FROM ${billingSubscriptionRenewalReviews} AS renewal_review
      WHERE renewal_review.command_id = ${billingSubscriptionCommands.id}
        AND renewal_review.organization_id = ${billingSubscriptionCommands.organization_id}
        AND renewal_review.expires_at <= clock_timestamp()
    )
  ))`;
}
/** Filter before LIMIT and rotate each claimed inspection, so one unverifiable command cannot monopolize recovery. */
export async function listCancellationRecovery(limit: number) {
  return dbWrite
    .select()
    .from(billingSubscriptionCommands)
    .where(
      and(
        isNull(billingSubscriptionCommands.billing_scope_id),
        isNull(billingSubscriptionCommands.app_id),
        inArray(billingSubscriptionCommands.kind, ["cancel", "resume"]),
        recoverableCancellationState(),
        sql`(${billingSubscriptionCommands.lease_expires_at} IS NULL OR ${billingSubscriptionCommands.lease_expires_at} <= clock_timestamp())`,
      ),
    )
    .orderBy(asc(billingSubscriptionCommands.updated_at), asc(billingSubscriptionCommands.id))
    .limit(limit);
}

/** A fresh primary fence immediately precedes external mutation; it cannot provide Stripe with a local-revision CAS. */
export async function assertCancellationClaimCurrent(
  input: CancellationIdentity,
  claim: CancellationClaim,
  markDispatch = false,
) {
  return writeTransaction(async (tx) => {
    const locked = await lockActor(tx, input);
    const [command] = await tx
      .select()
      .from(billingSubscriptionCommands)
      .where(
        and(
          isNull(billingSubscriptionCommands.billing_scope_id),
          isNull(billingSubscriptionCommands.app_id),
          eq(billingSubscriptionCommands.organization_id, input.organizationId),
          eq(billingSubscriptionCommands.id, claim.command.id),
        ),
      )
      .for("update");
    const now = await readPostLockDatabaseNow(tx);
    if (
      !command ||
      command.status !== "OUTCOME_UNKNOWN" ||
      command.lease_token !== claim.command.lease_token ||
      command.execution_generation !== claim.command.execution_generation ||
      command.lease_expires_at === null ||
      command.lease_expires_at <= now
    )
      reject("command_lease_lost");
    const source = await currentSource(
      tx,
      {
        ...input,
        subscriptionId: claim.source.id,
        expectedSubscriptionRevision: claim.source.lifecycle_revision,
      },
      locked,
    );
    await validatePredecessor(tx, source, command);
    const configuredCancellation = await readConfiguredCancellationAuthority(tx, source);
    if (
      configuredCancellation?.authorityDigest !== claim.configuredCancellation?.authorityDigest ||
      configuredCancellation?.originalPending !== claim.configuredCancellation?.originalPending
    )
      reject("configured_cancellation_authority_changed");
    if (markDispatch) {
      if (command.cancellation_dispatch_state !== "ready")
        reject("dispatch_already_started_or_unknown");
      const [started] = await tx
        .update(billingSubscriptionCommands)
        .set({
          cancellation_dispatch_state: "started",
          state_revision: command.state_revision + 1,
          updated_at: sql`clock_timestamp()`,
        })
        .where(
          and(
            isNull(billingSubscriptionCommands.billing_scope_id),
            isNull(billingSubscriptionCommands.app_id),
            eq(billingSubscriptionCommands.id, command.id),
            eq(billingSubscriptionCommands.organization_id, input.organizationId),
            eq(billingSubscriptionCommands.status, "OUTCOME_UNKNOWN"),
            eq(billingSubscriptionCommands.lease_token, claim.command.lease_token!),
            eq(
              billingSubscriptionCommands.execution_generation,
              claim.command.execution_generation,
            ),
            gt(billingSubscriptionCommands.lease_expires_at, sql`clock_timestamp()`),
          ),
        )
        .returning({ id: billingSubscriptionCommands.id });
      if (!started) reject("dispatch_lease_lost");
    }
  });
}
/** Records inspection order only, including unverifiable actors; no provider or lifecycle authority is granted by this bookkeeping update. */
export async function rotateCancellationRecovery(command: BillingSubscriptionCommand) {
  await writeTransaction(async (tx) => {
    await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, command.organization_id))
      .for("update");
    await tx
      .select()
      .from(organizationSubscriptionAuthorities)
      .where(eq(organizationSubscriptionAuthorities.organization_id, command.organization_id))
      .for("update");
    await tx
      .update(billingSubscriptionCommands)
      .set({ updated_at: sql`clock_timestamp()` })
      .where(
        and(
          isNull(billingSubscriptionCommands.billing_scope_id),
          isNull(billingSubscriptionCommands.app_id),
          eq(billingSubscriptionCommands.id, command.id),
          eq(billingSubscriptionCommands.organization_id, command.organization_id),
          isNull(billingSubscriptionCommands.billing_scope_id),
          isNull(billingSubscriptionCommands.app_id),
          inArray(billingSubscriptionCommands.kind, ["cancel", "resume"]),
          recoverableCancellationState(),
        ),
      );
  });
}

async function validatePredecessor(
  tx: DbTransaction,
  source: import("../schemas/billing-subscriptions").BillingSubscription,
  command: BillingSubscriptionCommand,
) {
  const latest = await readLatestSubscriptionScheduleCommand(tx, source);
  if (
    (latest?.id ?? null) !== command.schedule_predecessor_command_id ||
    (command.kind === "resume"
      ? !source.cancel_at_period_end || latest?.kind !== "cancel"
      : source.cancel_at_period_end || (latest !== null && latest.kind !== "resume"))
  )
    reject("schedule_predecessor_changed");
}

/** Replays only recorded state, without refreshing terms or repeating a dispatch. */
export async function readReviewedCancellationReplay(
  input: PrepareCancellationInput & { expectedRenewalTermsDigest: string },
) {
  return writeTransaction(async (tx) => {
    await lockActor(tx, input);
    const [command] = await tx
      .select()
      .from(billingSubscriptionCommands)
      .where(
        and(
          isNull(billingSubscriptionCommands.billing_scope_id),
          isNull(billingSubscriptionCommands.app_id),
          eq(billingSubscriptionCommands.organization_id, input.organizationId),
          eq(billingSubscriptionCommands.idempotency_key, input.idempotencyKey),
        ),
      )
      .for("update");
    if (!command) return null;
    if (
      command.kind !== "resume" ||
      command.request_digest !==
        intentDigest(
          input,
          "resume",
          command.schedule_predecessor_command_id,
          input.expectedRenewalTermsDigest,
        )
    )
      reject("idempotency_intent_changed");
    const [receipt] = await tx
      .select()
      .from(billingSubscriptionRenewalReviews)
      .where(
        and(
          eq(billingSubscriptionRenewalReviews.organization_id, input.organizationId),
          eq(billingSubscriptionRenewalReviews.command_id, command.id),
        ),
      );
    if (!receipt || receipt.payload.termsDigest !== input.expectedRenewalTermsDigest)
      reject("renewal_review_receipt_unavailable");
    return command;
  });
}
export async function readCancellationRenewalReview(
  input: CancellationIdentity,
  commandId: string,
) {
  return writeTransaction(async (tx) => {
    await lockActor(tx, input);
    const [receipt] = await tx
      .select()
      .from(billingSubscriptionRenewalReviews)
      .where(
        and(
          eq(billingSubscriptionRenewalReviews.organization_id, input.organizationId),
          eq(billingSubscriptionRenewalReviews.command_id, commandId),
        ),
      );
    if (!receipt) return null;
    const parsed = subscriptionRenewalReviewSchema.safeParse(receipt.payload);
    if (!parsed.success) reject("renewal_review_receipt_invalid");
    return parsed.data;
  });
}
/** A ready, owned lease proves this reviewed command has never crossed the dispatch fence. */
export async function failReviewedCancellationBeforeDispatch(
  input: CancellationIdentity,
  claim: CancellationClaim,
) {
  return writeTransaction(async (tx) => {
    await lockActor(tx, input);
    const [receipt] = await tx
      .select({ id: billingSubscriptionRenewalReviews.command_id })
      .from(billingSubscriptionRenewalReviews)
      .where(
        and(
          eq(billingSubscriptionRenewalReviews.organization_id, input.organizationId),
          eq(billingSubscriptionRenewalReviews.command_id, claim.command.id),
        ),
      );
    if (!receipt) return false;
    const [failed] = await tx
      .update(billingSubscriptionCommands)
      .set({
        status: "FAILED",
        error_code: "RENEWAL_REVIEW_REJECTED_BEFORE_DISPATCH",
        state_revision: sql`${billingSubscriptionCommands.state_revision} + 1`,
        completed_at: sql`clock_timestamp()`,
        updated_at: sql`clock_timestamp()`,
        lease_token: null,
        lease_expires_at: null,
      })
      .where(
        and(
          isNull(billingSubscriptionCommands.billing_scope_id),
          isNull(billingSubscriptionCommands.app_id),
          eq(billingSubscriptionCommands.organization_id, input.organizationId),
          eq(billingSubscriptionCommands.id, claim.command.id),
          eq(billingSubscriptionCommands.requested_by_user_id, input.actorId),
          eq(billingSubscriptionCommands.kind, "resume"),
          eq(billingSubscriptionCommands.status, "OUTCOME_UNKNOWN"),
          eq(billingSubscriptionCommands.cancellation_dispatch_state, "ready"),
          eq(billingSubscriptionCommands.lease_token, claim.command.lease_token!),
          eq(billingSubscriptionCommands.execution_generation, claim.command.execution_generation),
          gt(billingSubscriptionCommands.lease_expires_at, sql`clock_timestamp()`),
        ),
      )
      .returning({ id: billingSubscriptionCommands.id });
    return Boolean(failed);
  });
}
