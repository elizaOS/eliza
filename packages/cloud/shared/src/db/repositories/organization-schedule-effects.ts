/** Original-command leases and ordered schedule effects. Provider I/O stays outside transactions. */
import { randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, eq, isNull } from "drizzle-orm";
import { organizationDowngradeIntentDigest } from "../../lib/services/organization-downgrade-intent";
import { organizationDowngradeReviewSchema } from "../../lib/services/organization-downgrade-review";
import { organizationPlanChangeProviderBindingSchema } from "../../lib/services/organization-plan-change-provider-binding";
import {
  assertScheduleRequestScope,
  type OrganizationScheduleEffectReceipt,
  type OrganizationScheduleEffectRequest,
  organizationScheduleEffectReceiptSchema,
  scheduleEffectRequestDigest,
} from "../../lib/services/organization-schedule-effect-contract";
import { settlementDigest } from "../../lib/services/settlement-digest";
import type { DbTransaction } from "../client";
import { writeTransaction } from "../helpers";
import { organizationPlanChangeQuotes } from "../schemas/organization-plan-change-quotes";
import { organizationScheduleEffects as effects } from "../schemas/organization-schedule-effects";
import { organizations } from "../schemas/organizations";
import { billingSubscriptionCommands as commands } from "../schemas/subscription-billing-operations";
import { lockOrganizationPlanChangeSource } from "./organization-plan-change";
import {
  lockOrganizationSubscriptionManager,
  type OrganizationSubscriptionIdentity,
} from "./organization-subscription-manager";
import { readPostLockDatabaseNow } from "./primary-database-clock";

type Identity = OrganizationSubscriptionIdentity & { commandId: string };
type Claim = { commandId: string; leaseToken: string; generation: number };
function reject(reason: string): never {
  throw new ElizaError("Original schedule effect authority changed", {
    code:
      reason === "current_manager_required" || reason === "organization_authority_unavailable"
        ? "SUBSCRIPTION_PLAN_CHANGE_FORBIDDEN"
        : "SUBSCRIPTION_PLAN_CHANGE_CONFLICT",
    context: { reason },
  });
}
async function lockOriginal(tx: DbTransaction, input: Identity, manager: boolean) {
  if (manager) await lockOrganizationSubscriptionManager(tx, input, reject);
  else {
    const [org] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .for("update");
    if (!org) reject("organization_authority_unavailable");
  }
  const [command] = await tx
    .select()
    .from(commands)
    .where(
      and(
        eq(commands.id, input.commandId),
        eq(commands.organization_id, input.organizationId),
        eq(commands.requested_by_user_id, input.actorId),
        isNull(commands.app_id),
        isNull(commands.billing_scope_id),
      ),
    )
    .for("update");
  if (!command || command.kind !== "downgrade" || command.merchant_key !== "platform")
    reject("original_command_unavailable");
  const [stored] = await tx
    .select()
    .from(organizationPlanChangeQuotes)
    .where(
      and(
        eq(organizationPlanChangeQuotes.consumed_by_command_id, command.id),
        eq(organizationPlanChangeQuotes.organization_id, input.organizationId),
        eq(organizationPlanChangeQuotes.actor_id, input.actorId),
      ),
    )
    .for("update");
  if (
    !stored ||
    stored.subscription_id !== command.subscription_id ||
    stored.subscription_revision !== command.expected_subscription_revision ||
    stored.target_plan_key !== command.target_plan_key ||
    stored.review_digest !== settlementDigest(stored.review) ||
    command.request_digest !==
      organizationDowngradeIntentDigest({
        organizationId: input.organizationId,
        actorId: input.actorId,
        quoteId: stored.id,
        reviewDigest: stored.review_digest,
        sourceDigest: stored.source_digest,
        providerBinding: stored.provider_binding,
      })
  )
    reject("original_review_changed");
  const review = organizationDowngradeReviewSchema.parse(stored.review),
    binding = organizationPlanChangeProviderBindingSchema.parse(stored.provider_binding);
  return { command, quote: { ...stored, review }, binding };
}
type Locked = Awaited<ReturnType<typeof lockOriginal>>;
async function currentSource(tx: DbTransaction, input: Identity, locked: Locked) {
  const captured = await lockOrganizationPlanChangeSource(
    tx,
    {
      ...input,
      subscriptionId: locked.quote.subscription_id,
      expectedSubscriptionRevision: locked.quote.subscription_revision,
    },
    input.commandId,
  );
  if (settlementDigest(captured) !== locked.quote.source_digest) reject("original_source_changed");
  return captured;
}
function assertLease(input: Identity, locked: Locked, claim: Claim, now: Date) {
  const c = locked.command;
  if (
    input.commandId !== claim.commandId ||
    c.status !== "OUTCOME_UNKNOWN" ||
    c.lease_token !== claim.leaseToken ||
    c.execution_generation !== claim.generation ||
    !c.lease_expires_at ||
    c.lease_expires_at <= now
  )
    reject("original_lease_lost");
}
async function rows(tx: DbTransaction, input: Identity) {
  return tx
    .select()
    .from(effects)
    .where(
      and(
        eq(effects.command_id, input.commandId),
        eq(effects.organization_id, input.organizationId),
      ),
    )
    .for("update");
}
function scope(
  locked: Locked,
  row: typeof effects.$inferSelect,
  predecessor: typeof effects.$inferSelect | undefined,
) {
  if (row.request_digest !== scheduleEffectRequestDigest(row.request_payload))
    reject("effect_request_changed");
  return assertScheduleRequestScope({
    request: row.request_payload,
    subscriptionId: row.subscription_id,
    sourcePriceId: locked.binding.sourcePriceId,
    targetPriceId: locked.binding.targetPriceId,
    periodStart: new Date(locked.quote.review.currentPeriodStart),
    periodEnd: new Date(locked.quote.review.currentPeriodEnd),
    predecessorScheduleId: predecessor?.receipt?.scheduleId ?? null,
  });
}
/** Recovery is read-only authority: it can observe an existing attempt, never mint an initial effect. */
export async function claimOrganizationSchedule(
  input: Identity,
  mode: "manager" | "recovery" = "manager",
) {
  return writeTransaction(async (tx) => {
    const locked = await lockOriginal(tx, input, mode === "manager");
    const c = locked.command;
    if (c.status !== "PREPARED" && c.status !== "OUTCOME_UNKNOWN") return null;
    const initialNow = await readPostLockDatabaseNow(tx);
    if (c.lease_expires_at && c.lease_expires_at > initialNow) return null;
    const existing = await rows(tx, input);
    if ((existing.length === 0) !== (c.status === "PREPARED")) reject("original_effect_missing");
    const checkedAt = await readPostLockDatabaseNow(tx);
    if (c.status === "PREPARED" && locked.quote.expires_at <= checkedAt) {
      await tx
        .update(commands)
        .set({
          status: "SUPERSEDED",
          error_code: "DOWNGRADE_REVIEW_EXPIRED_BEFORE_DISPATCH",
          completed_at: checkedAt,
          updated_at: checkedAt,
          state_revision: c.state_revision + 1,
          lease_token: null,
          lease_expires_at: null,
        })
        .where(eq(commands.id, c.id));
      return null;
    }
    if (c.status === "PREPARED" && mode === "recovery") return null;
    const captured = c.status === "PREPARED" ? await currentSource(tx, input, locked) : null;
    const now = await readPostLockDatabaseNow(tx);
    if (c.status === "PREPARED" && locked.quote.expires_at <= now) {
      await tx
        .update(commands)
        .set({
          status: "SUPERSEDED",
          error_code: "DOWNGRADE_REVIEW_EXPIRED_BEFORE_DISPATCH",
          completed_at: now,
          updated_at: now,
          state_revision: c.state_revision + 1,
          lease_token: null,
          lease_expires_at: null,
        })
        .where(eq(commands.id, c.id));
      return null;
    }
    const claim = {
      commandId: c.id,
      leaseToken: randomUUID(),
      generation: c.execution_generation + 1,
    };
    await tx
      .update(commands)
      .set({
        status: "OUTCOME_UNKNOWN",
        state_revision: c.state_revision + 1,
        execution_generation: claim.generation,
        attempt_count: c.attempt_count + 1,
        lease_token: claim.leaseToken,
        lease_expires_at: new Date(now.getTime() + 60000),
        provider_started_at: c.provider_started_at ?? now,
        updated_at: now,
      })
      .where(eq(commands.id, c.id));
    if (captured) {
      const request: OrganizationScheduleEffectRequest = {
        kind: "schedule_create",
        subscriptionId: captured.source.stripe_subscription_id!,
      };
      await tx.insert(effects).values({
        organization_id: input.organizationId,
        command_id: c.id,
        kind: request.kind,
        provider_idempotency_key: `organization-schedule:${c.id}:${request.kind}`,
        customer_id: captured.source.stripe_customer_id!,
        subscription_id: request.subscriptionId,
        livemode: locked.binding.livemode,
        request_payload: request,
        request_digest: scheduleEffectRequestDigest(request),
        created_at: now,
      });
    }
    const current = await rows(tx, input);
    const active =
      current.find((x) => x.kind === "schedule_configure") ??
      current.find((x) => x.kind === "schedule_create");
    if (!active) reject("original_effect_missing");
    return {
      claim,
      effect: active,
      canDispatch: mode === "manager" && active.state === "ready" && locked.quote.expires_at > now,
    };
  });
}
/** Stages exact, validated configuration only after the original create receipt is durable. */
export async function prepareOrganizationScheduleConfiguration(
  input: Identity,
  claim: Claim,
  request: Extract<OrganizationScheduleEffectRequest, { kind: "schedule_configure" }>,
) {
  return writeTransaction(async (tx) => {
    const locked = await lockOriginal(tx, input, true);
    await currentSource(tx, input, locked);
    const existing = await rows(tx, input),
      predecessor = existing.find((x) => x.kind === "schedule_create");
    const now = await readPostLockDatabaseNow(tx);
    assertLease(input, locked, claim, now);
    if (locked.quote.expires_at <= now) reject("review_expired");
    if (!predecessor || predecessor.state !== "observed" || !predecessor.receipt)
      reject("original_create_unobserved");
    const parsed = assertScheduleRequestScope({
      request,
      subscriptionId: predecessor.subscription_id,
      sourcePriceId: locked.binding.sourcePriceId,
      targetPriceId: locked.binding.targetPriceId,
      periodStart: new Date(locked.quote.review.currentPeriodStart),
      periodEnd: new Date(locked.quote.review.currentPeriodEnd),
      predecessorScheduleId: predecessor.receipt.scheduleId,
    });
    const digest = scheduleEffectRequestDigest(parsed),
      prior = existing.find((x) => x.kind === "schedule_configure");
    if (prior) {
      if (prior.request_digest !== digest) reject("original_configuration_changed");
      return prior;
    }
    const [created] = await tx
      .insert(effects)
      .values({
        organization_id: input.organizationId,
        command_id: input.commandId,
        predecessor_id: predecessor.id,
        kind: "schedule_configure",
        provider_idempotency_key: `organization-schedule:${input.commandId}:schedule_configure`,
        customer_id: predecessor.customer_id,
        subscription_id: predecessor.subscription_id,
        livemode: predecessor.livemode,
        request_payload: parsed,
        request_digest: digest,
        created_at: now,
      })
      .returning();
    if (!created) reject("configuration_insert_failed");
    return created;
  });
}
/** Call only after fresh provider observation and session revalidation, immediately before provider I/O. */
export async function markOrganizationScheduleEffectDispatch(
  input: Identity,
  claim: Claim,
  effectId: string,
) {
  return writeTransaction(async (tx) => {
    const locked = await lockOriginal(tx, input, true);
    await currentSource(tx, input, locked);
    const existing = await rows(tx, input),
      effect = existing.find((x) => x.id === effectId);
    const now = await readPostLockDatabaseNow(tx);
    assertLease(input, locked, claim, now);
    if (!effect || effect.state !== "ready" || locked.quote.expires_at <= now)
      reject("effect_not_dispatchable");
    scope(
      locked,
      effect,
      existing.find((x) => x.id === effect.predecessor_id),
    );
    const [started] = await tx
      .update(effects)
      .set({
        state: "started",
        started_at: now,
        started_generation: claim.generation,
        started_lease_token: claim.leaseToken,
      })
      .where(eq(effects.id, effect.id))
      .returning();
    if (!started) reject("effect_dispatch_failed");
    return started;
  });
}
/** Receipt authenticity must be established by the pinned response/event observer before this call. */
export async function recordOrganizationScheduleEffectReceipt(
  input: Identity,
  claim: Claim,
  effectId: string,
  raw: OrganizationScheduleEffectReceipt,
) {
  const receipt = organizationScheduleEffectReceiptSchema.parse(raw);
  return writeTransaction(async (tx) => {
    const locked = await lockOriginal(tx, input, false),
      existing = await rows(tx, input),
      effect = existing.find((x) => x.id === effectId);
    const now = await readPostLockDatabaseNow(tx);
    assertLease(input, locked, claim, now);
    if (!effect || effect.state === "ready" || !effect.started_at) reject("effect_not_started");
    scope(
      locked,
      effect,
      existing.find((x) => x.id === effect.predecessor_id),
    );
    const observedAt = new Date(receipt.observedAt);
    if (
      receipt.customerId !== effect.customer_id ||
      receipt.subscriptionId !== effect.subscription_id ||
      receipt.livemode !== effect.livemode ||
      receipt.providerIdempotencyKey !== effect.provider_idempotency_key ||
      observedAt < effect.started_at ||
      observedAt > now ||
      (effect.request_payload.kind === "schedule_configure" &&
        receipt.scheduleId !== effect.request_payload.scheduleId)
    )
      reject("receipt_scope_changed");
    const digest = settlementDigest(receipt);
    if (effect.state === "observed") {
      if (effect.receipt_digest !== digest) reject("original_receipt_changed");
      return effect;
    }
    const [saved] = await tx
      .update(effects)
      .set({
        state: "observed",
        receipt,
        receipt_digest: digest,
        observed_at: observedAt,
        observation_generation: claim.generation,
        observation_lease_token: claim.leaseToken,
      })
      .where(eq(effects.id, effect.id))
      .returning();
    if (!saved) reject("receipt_insert_failed");
    return saved;
  });
}
/** Releases only the original lease. Started or observed provider effects can never be retired here. */
export async function finishOrganizationScheduleAttempt(input: Identity, claim: Claim) {
  return writeTransaction(async (tx) => {
    const locked = await lockOriginal(tx, input, false),
      c = locked.command;
    if (
      input.commandId !== claim.commandId ||
      c.lease_token !== claim.leaseToken ||
      c.execution_generation !== claim.generation ||
      c.status !== "OUTCOME_UNKNOWN"
    )
      return false;
    const existing = await rows(tx, input),
      now = await readPostLockDatabaseNow(tx);
    const unstarted =
      existing.length === 1 &&
      existing[0]!.kind === "schedule_create" &&
      existing[0]!.state === "ready";
    const expired = unstarted && locked.quote.expires_at <= now;
    await tx
      .update(commands)
      .set({
        lease_token: null,
        lease_expires_at: null,
        state_revision: c.state_revision + 1,
        updated_at: now,
        ...(expired
          ? {
              status: "FAILED" as const,
              error_code: "DOWNGRADE_REVIEW_EXPIRED_BEFORE_DISPATCH",
              completed_at: now,
            }
          : {}),
      })
      .where(eq(commands.id, c.id));
    return true;
  });
}
