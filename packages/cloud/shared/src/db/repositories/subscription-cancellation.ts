/** Serializes organization cancellation intent, provider leases and atomic lifecycle publication against primary actor and subscription authority. Provider requests occur outside these transactions. */
import { createHash, randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { getCloudAwareEnv } from "../../lib/runtime/cloud-bindings";
import { validatePeriodEndCancellationObservation } from "../../lib/services/stripe-period-end-cancellation";
import type { DbTransaction } from "../client";
import { dbWrite, writeTransaction } from "../helpers";
import {
  billingSubscriptions,
  organizationSubscriptionAuthorities,
} from "../schemas/billing-subscriptions";
import { organizationEntitlements } from "../schemas/organization-entitlements";
import { organizations } from "../schemas/organizations";
import {
  type BillingSubscriptionCommand,
  billingSubscriptionCommands,
} from "../schemas/subscription-billing-operations";
import { users } from "../schemas/users";
import { readPostLockDatabaseNow } from "./primary-database-clock";
import { subscriptionAuthorityRepository } from "./subscription-authority";
import { subscriptionEntitlementsRepository } from "./subscription-entitlements";

export interface CancellationIdentity {
  organizationId: string;
  actorId: string;
}
export interface PrepareCancellationInput extends CancellationIdentity {
  subscriptionId: string;
  expectedSubscriptionRevision: number;
  idempotencyKey: string;
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
async function lockActor(tx: DbTransaction, input: CancellationIdentity) {
  const [organization] = await tx
    .select({
      id: organizations.id,
      active: organizations.is_active,
      state: organizations.account_lifecycle_state,
      deletion: organizations.account_deletion_request_id,
      fenced: organizations.paid_work_fenced_at,
      customer: organizations.stripe_customer_id,
    })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .for("update");
  if (
    !organization ||
    !organization.active ||
    organization.state !== "active" ||
    organization.deletion !== null ||
    organization.fenced !== null
  )
    reject("organization_authority_unavailable");
  const [association] = await tx
    .select()
    .from(organizationSubscriptionAuthorities)
    .where(eq(organizationSubscriptionAuthorities.organization_id, input.organizationId))
    .for("update");
  const [actor] = await tx
    .select({
      organizationId: users.organization_id,
      role: users.role,
      active: users.is_active,
      anonymous: users.is_anonymous,
      deleted: users.deleted_at,
      expires: users.expires_at,
    })
    .from(users)
    .where(eq(users.id, input.actorId));
  const now = await readPostLockDatabaseNow(tx);
  if (
    !actor ||
    actor.organizationId !== input.organizationId ||
    !actor.active ||
    actor.anonymous ||
    actor.deleted !== null ||
    (actor.expires !== null && actor.expires <= now) ||
    (actor.role !== "owner" && actor.role !== "admin")
  )
    reject("current_manager_required");
  return { organization, association, now };
}
async function currentSource(
  tx: DbTransaction,
  input: PrepareCancellationInput,
  locked: Awaited<ReturnType<typeof lockActor>>,
) {
  if (
    !locked.association ||
    locked.association.state !== "current" ||
    locked.association.subscription_id !== input.subscriptionId
  )
    reject("current_subscription_unavailable");
  const [source] = await tx
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.organization_id, input.organizationId),
        eq(billingSubscriptions.id, input.subscriptionId),
      ),
    )
    .for("update");
  if (
    !source ||
    source.lifecycle_revision !== input.expectedSubscriptionRevision ||
    source.status !== "active" ||
    source.current_period_start === null ||
    source.current_period_end === null ||
    source.current_period_end <= locked.now ||
    source.ended_at !== null ||
    source.pending_plan_key !== null ||
    source.dunning_started_at !== null ||
    source.grace_expires_at !== null ||
    locked.organization.customer === null ||
    locked.organization.customer !== source.stripe_customer_id
  )
    reject("source_changed_or_unsupported");
  return source;
}
function intentDigest(input: PrepareCancellationInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        organizationId: input.organizationId,
        actorId: input.actorId,
        subscriptionId: input.subscriptionId,
        expectedSubscriptionRevision: input.expectedSubscriptionRevision,
        kind: "cancel_at_period_end",
      }),
    )
    .digest("hex");
}
export async function prepareCancellation(
  input: PrepareCancellationInput,
): Promise<BillingSubscriptionCommand> {
  return writeTransaction(async (tx) => {
    const locked = await lockActor(tx, input);
    const digest = intentDigest(input);
    const [existing] = await tx
      .select()
      .from(billingSubscriptionCommands)
      .where(
        and(
          eq(billingSubscriptionCommands.organization_id, input.organizationId),
          eq(billingSubscriptionCommands.idempotency_key, input.idempotencyKey),
        ),
      )
      .for("update");
    if (existing) {
      if (existing.kind !== "cancel" || existing.request_digest !== digest)
        reject("idempotency_intent_changed");
      return existing;
    }
    const source = await currentSource(tx, input, locked);
    if (source.cancel_at_period_end) reject("already_scheduled_without_this_command");
    const [live] = await tx
      .select({ id: billingSubscriptionCommands.id })
      .from(billingSubscriptionCommands)
      .where(
        and(
          eq(billingSubscriptionCommands.organization_id, input.organizationId),
          inArray(billingSubscriptionCommands.status, ["PREPARED", "OUTCOME_UNKNOWN", "SUCCEEDED"]),
        ),
      )
      .limit(1);
    if (live) reject("contradictory_command_pending");
    const id = randomUUID();
    const [command] = await tx
      .insert(billingSubscriptionCommands)
      .values({
        id,
        organization_id: input.organizationId,
        requested_by_user_id: input.actorId,
        subscription_id: input.subscriptionId,
        kind: "cancel",
        cancellation_dispatch_state: "ready",
        expected_subscription_revision: input.expectedSubscriptionRevision,
        idempotency_key: input.idempotencyKey,
        provider_idempotency_key: `organization-cancellation:${id}`,
        request_digest: digest,
        created_at: locked.now,
        updated_at: locked.now,
      })
      .returning();
    if (!command) reject("command_insert_failed");
    return command;
  });
}
export async function readCancellation(input: CancellationIdentity & { commandId: string }) {
  return writeTransaction(async (tx) => {
    await lockActor(tx, input);
    const [command] = await tx
      .select()
      .from(billingSubscriptionCommands)
      .where(
        and(
          eq(billingSubscriptionCommands.organization_id, input.organizationId),
          eq(billingSubscriptionCommands.id, input.commandId),
          eq(billingSubscriptionCommands.kind, "cancel"),
        ),
      );
    if (!command) reject("command_unavailable");
    return command;
  });
}
export async function claimCancellation(input: CancellationIdentity & { commandId: string }) {
  return writeTransaction(async (tx) => {
    const locked = await lockActor(tx, input);
    const [command] = await tx
      .select()
      .from(billingSubscriptionCommands)
      .where(
        and(
          eq(billingSubscriptionCommands.organization_id, input.organizationId),
          eq(billingSubscriptionCommands.id, input.commandId),
        ),
      )
      .for("update");
    if (
      !command ||
      command.kind !== "cancel" ||
      command.requested_by_user_id !== input.actorId ||
      command.subscription_id === null ||
      command.expected_subscription_revision === null
    )
      reject("command_unavailable");
    if (command.status !== "PREPARED" && command.status !== "OUTCOME_UNKNOWN") return null;
    const now = await readPostLockDatabaseNow(tx);
    if (command.lease_expires_at !== null && command.lease_expires_at > now) return null;
    const source = await currentSource(
      tx,
      {
        ...input,
        subscriptionId: command.subscription_id,
        expectedSubscriptionRevision: command.expected_subscription_revision,
        idempotencyKey: command.idempotency_key,
      },
      locked,
    );
    const [projection] = await tx
      .select()
      .from(organizationEntitlements)
      .where(eq(organizationEntitlements.organization_id, input.organizationId));
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
) {
  return writeTransaction(async (tx) => {
    const locked = await lockActor(tx, input);
    const [command] = await tx
      .select()
      .from(billingSubscriptionCommands)
      .where(
        and(
          eq(billingSubscriptionCommands.organization_id, input.organizationId),
          eq(billingSubscriptionCommands.id, claim.command.id),
        ),
      )
      .for("update");
    if (!command || command.kind !== "cancel" || command.requested_by_user_id !== input.actorId)
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
        idempotencyKey: command.idempotency_key,
      },
      locked,
    );
    const observed = validatePeriodEndCancellationObservation({
      source,
      organizationCustomerId: locked.organization.customer,
      environment: getCloudAwareEnv(),
      raw,
      observedAt: now,
      requireScheduled: true,
    });
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
      pending_plan_key: source.pending_plan_key,
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
        cancel_at_period_end: true,
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
/** Filter before LIMIT and rotate each claimed inspection, so one unverifiable command cannot monopolize recovery. */
export async function listCancellationRecovery(limit: number) {
  return dbWrite
    .select()
    .from(billingSubscriptionCommands)
    .where(
      and(
        eq(billingSubscriptionCommands.kind, "cancel"),
        eq(billingSubscriptionCommands.status, "OUTCOME_UNKNOWN"),
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
    await currentSource(
      tx,
      {
        ...input,
        subscriptionId: claim.source.id,
        expectedSubscriptionRevision: claim.source.lifecycle_revision,
        idempotencyKey: command.idempotency_key,
      },
      locked,
    );
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
          eq(billingSubscriptionCommands.id, command.id),
          eq(billingSubscriptionCommands.organization_id, command.organization_id),
          eq(billingSubscriptionCommands.kind, "cancel"),
          eq(billingSubscriptionCommands.status, "OUTCOME_UNKNOWN"),
        ),
      );
  });
}
