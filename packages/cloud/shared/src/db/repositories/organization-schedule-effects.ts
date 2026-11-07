/** Original-command leases and ordered schedule effects. Provider I/O stays outside transactions. */
import { randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
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
import {
  projectAuthenticatedScheduleEvent,
  projectOriginalScheduleResponse,
} from "../../lib/services/organization-schedule-effect-origin";
import { proveOrganizationSchedulePublication } from "../../lib/services/organization-schedule-publication-proof";
import { proveOrganizationScheduleRelease } from "../../lib/services/organization-schedule-release-proof";
import { settlementDigest } from "../../lib/services/settlement-digest";
import type { DbTransaction } from "../client";
import { writeTransaction } from "../helpers";
import {
  billingSubscriptions,
  organizationSubscriptionAuthorities,
} from "../schemas/billing-subscriptions";
import { organizationEntitlements } from "../schemas/organization-entitlements";
import { organizationPlanChangeQuotes } from "../schemas/organization-plan-change-quotes";
import { organizationScheduleEffects as effects } from "../schemas/organization-schedule-effects";
import { organizations } from "../schemas/organizations";
import { billingSubscriptionCommands as commands } from "../schemas/subscription-billing-operations.ts";
import { lockOrganizationPlanChangeSource } from "./organization-plan-change";
import { resolveOrganizationScheduleIncidentsInTransaction } from "./organization-schedule-maintenance";
import { readOriginalScheduleQuoteTerms } from "./organization-schedule-quote-terms";
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
  const retained = stored
    ? await readOriginalScheduleQuoteTerms(tx, stored.id, input.organizationId)
    : null;
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
        retainedTermsDigest: retained?.snapshot_digest ?? null,
      })
  )
    reject("original_review_changed");
  const review = organizationDowngradeReviewSchema.parse(stored.review),
    binding = organizationPlanChangeProviderBindingSchema.parse(stored.provider_binding);
  return { command, quote: { ...stored, review }, binding, retained };
}
type Locked = Awaited<ReturnType<typeof lockOriginal>>;
async function currentSource(tx: DbTransaction, input: Identity, locked: Locked) {
  if (!locked.retained) reject("original_retained_terms_required");
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
      await resolveOrganizationScheduleIncidentsInTransaction(tx, input);
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
      await resolveOrganizationScheduleIncidentsInTransaction(tx, input);
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
        // Preserve database precision and original provenance on replacement claims.
        ...(c.provider_started_at === null ? { provider_started_at: now } : {}),
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
      current.find((x) => x.kind === "schedule_release") ??
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
  return recordReceipt(input, claim, effectId, () =>
    organizationScheduleEffectReceiptSchema.parse(raw),
  );
}
/** Caller authenticates the platform SDK response or verifies the event signature first.
 * Original identity and dispatch time come from locked storage, never the caller.
 * Exact evidence replay retains the first observation timestamp and provenance.
 */
export async function recordAuthenticatedOrganizationScheduleEvidence(
  input: Identity,
  claim: Claim,
  effectId: string,
  evidence: { kind: "response" | "event"; raw: unknown },
) {
  return recordReceipt(input, claim, effectId, (effect, now) => {
    if (!effect.started_at) reject("effect_not_started");
    const args = {
      raw: evidence.raw,
      originalRequest: {
        request: effect.request_payload,
        providerIdempotencyKey: effect.provider_idempotency_key,
        customerId: effect.customer_id,
        subscriptionId: effect.subscription_id,
        livemode: effect.livemode,
        startedAt: effect.started_at,
      },
      observedAt: now,
    };
    const receipt =
      evidence.kind === "response"
        ? projectOriginalScheduleResponse(args)
        : projectAuthenticatedScheduleEvent(args);
    if (effect.receipt) {
      // Compare all immutable evidence fields, ignoring only the new observation time.
      const replay = { ...receipt, observedAt: effect.receipt.observedAt };
      if (settlementDigest(replay) !== effect.receipt_digest) reject("original_receipt_changed");
      return effect.receipt;
    }
    return receipt;
  });
}
async function recordReceipt(
  input: Identity,
  claim: Claim,
  effectId: string,
  project: (effect: typeof effects.$inferSelect, now: Date) => OrganizationScheduleEffectReceipt,
) {
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
    const receipt = project(effect, now);
    const observedAt = new Date(receipt.observedAt);
    if (
      receipt.customerId !== effect.customer_id ||
      receipt.subscriptionId !== effect.subscription_id ||
      receipt.livemode !== effect.livemode ||
      receipt.providerIdempotencyKey !== effect.provider_idempotency_key ||
      observedAt < effect.started_at ||
      observedAt > now ||
      (effect.request_payload.kind !== "schedule_create" &&
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
    if (expired) await resolveOrganizationScheduleIncidentsInTransaction(tx, input);
    return true;
  });
}

/** Private original review and retained terms for a manager-owned dispatch attempt.
 * Provider I/O happens after commit, followed by the existing irreversible marker fence.
 */
async function readOrganizationScheduleExecutionSource(
  input: Identity,
  claim: Claim,
  effectId: string,
  purpose: "dispatch" | "configuration",
) {
  return writeTransaction(async (tx) => {
    const locked = await lockOriginal(tx, input, true);
    const captured = await currentSource(tx, input, locked);
    const existing = await rows(tx, input);
    const effect = existing.find((row) => row.id === effectId);
    const now = await readPostLockDatabaseNow(tx);
    assertLease(input, locked, claim, now);
    if (
      !effect ||
      (purpose === "dispatch"
        ? effect.state !== "ready"
        : effect.state !== "observed" ||
          effect.kind !== "schedule_create" ||
          !effect.receipt ||
          !effect.started_at) ||
      locked.quote.expires_at <= now ||
      !locked.retained
    )
      reject("effect_not_dispatchable");
    scope(
      locked,
      effect,
      existing.find((row) => row.id === effect.predecessor_id),
    );
    return {
      ...captured,
      review: locked.quote.review,
      providerBinding: locked.binding,
      retainedTerms: locked.retained.snapshot,
      quoteId: locked.quote.id,
      effect,
      predecessor: existing.find((row) => row.id === effect.predecessor_id) ?? null,
      checkedAt: now,
    };
  });
}

export function readOrganizationScheduleDispatchSource(
  input: Identity,
  claim: Claim,
  effectId: string,
) {
  return readOrganizationScheduleExecutionSource(input, claim, effectId, "dispatch");
}
export function readOrganizationScheduleConfigurationSource(
  input: Identity,
  claim: Claim,
  createEffectId: string,
) {
  return readOrganizationScheduleExecutionSource(input, claim, createEffectId, "configuration");
}

/** Original intent authorizes cleanup even after review expiry or manager revocation.
 * Only a proven original create with no started configuration is eligible.
 */
async function lockCompensation(tx: DbTransaction, input: Identity, claim: Claim) {
  const locked = await lockOriginal(tx, input, false),
    existing = await rows(tx, input);
  const now = await readPostLockDatabaseNow(tx);
  assertLease(input, locked, claim, now);
  const create = existing.find((row) => row.kind === "schedule_create");
  if (
    !locked.retained ||
    !create ||
    create.state !== "observed" ||
    !create.receipt ||
    !create.started_at ||
    create.receipt_digest !== settlementDigest(create.receipt) ||
    existing.some((row) => row.kind === "schedule_configure" && row.state !== "ready")
  )
    reject("original_unconfigured_create_required");
  scope(locked, create, undefined);
  const release = existing.find((row) => row.kind === "schedule_release") ?? null;
  if (release) scope(locked, release, create);
  return { locked, create, release, now };
}
export function readOrganizationScheduleCompensationSource(input: Identity, claim: Claim) {
  return writeTransaction(async (tx) => {
    const result = await lockCompensation(tx, input, claim);
    return {
      create: result.create,
      release: result.release,
      retainedTerms: result.locked.retained!.snapshot,
      providerBinding: result.locked.binding,
      checkedAt: result.now,
    };
  });
}
export function prepareOrganizationScheduleCompensation(input: Identity, claim: Claim) {
  return writeTransaction(async (tx) => {
    const { create, release, now } = await lockCompensation(tx, input, claim);
    if (release) return release;
    const request: OrganizationScheduleEffectRequest = {
      kind: "schedule_release",
      scheduleId: create.receipt!.scheduleId,
      params: { preserve_cancel_date: true },
    };
    const [inserted] = await tx
      .insert(effects)
      .values({
        organization_id: input.organizationId,
        command_id: input.commandId,
        predecessor_id: create.id,
        kind: request.kind,
        provider_idempotency_key: `organization-schedule:${input.commandId}:schedule_release`,
        customer_id: create.customer_id,
        subscription_id: create.subscription_id,
        livemode: create.livemode,
        request_payload: request,
        request_digest: scheduleEffectRequestDigest(request),
        created_at: now,
      })
      .returning();
    if (!inserted) reject("compensation_insert_failed");
    return inserted;
  });
}
/** Caller has just reobserved original create/defaults and retained subscription/customer terms. */
export function markOrganizationScheduleCompensationDispatch(
  input: Identity,
  claim: Claim,
  effectId: string,
) {
  return writeTransaction(async (tx) => {
    const { release, now } = await lockCompensation(tx, input, claim);
    if (!release || release.id !== effectId || release.state !== "ready")
      reject("compensation_not_dispatchable");
    const [started] = await tx
      .update(effects)
      .set({
        state: "started",
        started_at: now,
        started_generation: claim.generation,
        started_lease_token: claim.leaseToken,
      })
      .where(eq(effects.id, release.id))
      .returning();
    if (!started) reject("compensation_dispatch_failed");
    return started;
  });
}
/** Publish a proven original cleanup outcome without changing paid authority. */
export async function finalizeOrganizationScheduleCompensation(
  input: Identity,
  claim: Claim,
  observation: {
    createEvidence: { kind: "response" | "event"; raw: unknown };
    releaseEvidence: { kind: "response" | "event"; raw: unknown };
    rawCurrentSchedule: unknown;
    rawSubscription: unknown;
    rawCustomer: unknown;
  },
) {
  return writeTransaction(async (tx) => {
    // Preserve organization -> association -> command -> source lock order.
    // Fencing prevents new paid work; it cannot strand proven original cleanup.
    const [org] = await tx
      .select({ id: organizations.id, stripe_customer_id: organizations.stripe_customer_id })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .for("update");
    if (!org) reject("organization_authority_unavailable");
    const [association] = await tx
      .select()
      .from(organizationSubscriptionAuthorities)
      .where(eq(organizationSubscriptionAuthorities.organization_id, input.organizationId))
      .for("update");
    const original = await lockOriginal(tx, input, false);
    if (
      original.command.status === "FAILED" &&
      original.command.organization_schedule_failure_evidence !== null
    )
      return { command: original.command, replayed: true };
    const { locked, create, release } = await lockCompensation(tx, input, claim);
    if (
      !release ||
      release.state !== "observed" ||
      !release.receipt ||
      !release.started_at ||
      release.receipt_digest !== settlementDigest(release.receipt)
    )
      reject("original_release_receipt_required");
    if (
      !association ||
      association.state !== "current" ||
      association.subscription_id !== locked.quote.subscription_id
    )
      reject("current_source_authority_changed");
    const [source] = await tx
      .select()
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.id, locked.quote.subscription_id),
          eq(billingSubscriptions.organization_id, input.organizationId),
          isNull(billingSubscriptions.billing_scope_id),
        ),
      )
      .for("update");
    const [projection] = await tx
      .select()
      .from(organizationEntitlements)
      .where(
        and(
          eq(organizationEntitlements.organization_id, input.organizationId),
          isNull(organizationEntitlements.billing_scope_id),
        ),
      )
      .for("update");
    if (
      !source ||
      source.lifecycle_revision !== locked.quote.subscription_revision ||
      !projection ||
      projection.source_subscription_id !== source.id ||
      projection.source_subscription_revision !== source.lifecycle_revision ||
      settlementDigest({ source, organizationCustomerId: org.stripe_customer_id }) !==
        locked.quote.source_digest
    )
      reject("original_source_or_projection_changed");
    const now = await readPostLockDatabaseNow(tx);
    assertLease(input, locked, claim, now);
    const requestFor = (effect: typeof create) => {
      if (!effect.started_at) reject("original_dispatch_provenance_missing");
      return {
        request: effect.request_payload,
        providerIdempotencyKey: effect.provider_idempotency_key,
        customerId: effect.customer_id,
        subscriptionId: effect.subscription_id,
        livemode: effect.livemode,
        startedAt: effect.started_at,
      };
    };
    // All original request/receipt/terms authority comes from locked immutable rows.
    // Inputs are authenticated server reads, never a renderer-provided proof digest.
    const verified = proveOrganizationScheduleRelease({
      originalCreate: {
        originalReceipt: create.receipt!,
        originalRequest: requestFor(create),
        evidence: observation.createEvidence,
        observedAt: now,
      },
      originalRelease: {
        originalReceipt: release.receipt,
        originalRequest: requestFor(release),
        evidence: observation.releaseEvidence,
        observedAt: now,
      },
      rawCurrentSchedule: observation.rawCurrentSchedule,
      rawSubscription: observation.rawSubscription,
      rawCustomer: observation.rawCustomer,
      originalTerms: locked.retained!.snapshot,
    });
    if (verified.retainedTermsDigest !== locked.retained!.snapshot_digest)
      reject("original_retained_terms_changed");
    const proof = {
      kind: "original_unconfigured_schedule_released" as const,
      ...verified,
      quoteId: locked.quote.id,
      sourceDigest: locked.quote.source_digest,
      createEffectId: create.id,
      releaseEffectId: release.id,
      createReceiptDigest: create.receipt_digest!,
      releaseReceiptDigest: release.receipt_digest!,
      observedAt: now.toISOString(),
    };
    const [failed] = await tx
      .update(commands)
      .set({
        status: "FAILED",
        error_code: "ORIGINAL_SCHEDULE_CREATE_COMPENSATED",
        organization_schedule_failure_evidence: proof,
        provider_response_digest: settlementDigest(proof),
        lease_token: null,
        lease_expires_at: null,
        state_revision: locked.command.state_revision + 1,
        completed_at: sql`clock_timestamp()`,
        updated_at: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(commands.id, input.commandId),
          eq(commands.organization_id, input.organizationId),
          eq(commands.status, "OUTCOME_UNKNOWN"),
          eq(commands.execution_generation, claim.generation),
          eq(commands.lease_token, claim.leaseToken),
          gt(commands.lease_expires_at, sql`clock_timestamp()`),
        ),
      )
      .returning();
    if (!failed) reject("original_lease_lost_before_commit");
    await resolveOrganizationScheduleIncidentsInTransaction(tx, input);
    return { command: failed, replayed: false };
  });
}

export type OrganizationScheduleConfiguredObservation = {
  createEvidence: { kind: "response" | "event"; raw: unknown };
  configurationEvidence: { kind: "response" | "event"; raw: unknown };
  rawCurrentSchedule: unknown;
  rawSubscription: unknown;
  rawCustomer: unknown;
};
export type OrganizationScheduleConfiguredIdentity = Identity & {
  leaseToken: string;
  executionGeneration: number;
};
/** Original read-only settlement authority; no new provider effects or manager grant. */
export async function lockOrganizationScheduleConfiguredAuthority(
  tx: DbTransaction,
  input: OrganizationScheduleConfiguredIdentity & OrganizationScheduleConfiguredObservation,
) {
  const [org] = await tx
    .select({
      id: organizations.id,
      customer: organizations.stripe_customer_id,
      active: organizations.is_active,
      lifecycle: organizations.account_lifecycle_state,
      fenced: organizations.paid_work_fenced_at,
      deletion: organizations.account_deletion_request_id,
    })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .for("update");
  if (
    !org ||
    !org.active ||
    org.lifecycle !== "active" ||
    org.fenced !== null ||
    org.deletion !== null
  )
    reject("organization_authority_unavailable");
  const [association] = await tx
    .select()
    .from(organizationSubscriptionAuthorities)
    .where(eq(organizationSubscriptionAuthorities.organization_id, input.organizationId))
    .for("update");
  const locked = await lockOriginal(tx, input, false);
  if (
    !locked.retained ||
    !association ||
    association.state !== "current" ||
    association.subscription_id !== locked.quote.subscription_id
  )
    reject("current_source_authority_changed");
  const existing = await rows(tx, input);
  const create = existing.find((e) => e.kind === "schedule_create");
  const configured = existing.find((e) => e.kind === "schedule_configure");
  if (
    !create ||
    !configured ||
    create.state !== "observed" ||
    configured.state !== "observed" ||
    !create.started_at ||
    !configured.started_at ||
    !create.receipt ||
    !configured.receipt ||
    create.receipt_digest !== settlementDigest(create.receipt) ||
    configured.receipt_digest !== settlementDigest(configured.receipt) ||
    configured.predecessor_id !== create.id ||
    existing.some((e) => e.kind === "schedule_release")
  )
    reject("original_configuration_receipts_required");
  scope(locked, create, undefined);
  scope(locked, configured, create);
  const [source] = await tx
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.id, locked.quote.subscription_id),
        eq(billingSubscriptions.organization_id, input.organizationId),
        isNull(billingSubscriptions.billing_scope_id),
      ),
    )
    .for("update");
  const [projection] = await tx
    .select()
    .from(organizationEntitlements)
    .where(
      and(
        eq(organizationEntitlements.organization_id, input.organizationId),
        isNull(organizationEntitlements.billing_scope_id),
      ),
    )
    .for("update");
  if (
    !source ||
    source.lifecycle_revision !== locked.quote.subscription_revision ||
    !projection ||
    projection.source_subscription_id !== source.id ||
    projection.source_subscription_revision !== source.lifecycle_revision ||
    settlementDigest({ source, organizationCustomerId: org.customer }) !==
      locked.quote.source_digest
  )
    reject("original_source_or_projection_changed");
  const now = await readPostLockDatabaseNow(tx);
  assertLease(
    input,
    locked,
    {
      commandId: input.commandId,
      leaseToken: input.leaseToken,
      generation: input.executionGeneration,
    },
    now,
  );
  const requestFor = (effect: typeof create) => ({
    request: effect.request_payload,
    providerIdempotencyKey: effect.provider_idempotency_key,
    customerId: effect.customer_id,
    subscriptionId: effect.subscription_id,
    livemode: effect.livemode,
    startedAt: effect.started_at!,
  });
  const { configuredSnapshot, ...verified } = proveOrganizationSchedulePublication({
    source,
    organizationCustomerId: org.customer,
    review: locked.quote.review,
    providerBinding: locked.binding,
    originalTerms: locked.retained.snapshot,
    originalCreate: {
      originalReceipt: create.receipt,
      originalRequest: requestFor(create),
      evidence: input.createEvidence,
      observedAt: now,
    },
    originalConfiguration: {
      originalReceipt: configured.receipt,
      originalRequest: requestFor(configured),
      evidence: input.configurationEvidence,
      observedAt: now,
    },
    rawCurrentSchedule: input.rawCurrentSchedule,
    rawSubscription: input.rawSubscription,
    rawCustomer: input.rawCustomer,
  });
  if (
    verified.retainedTermsDigest !== locked.retained.snapshot_digest ||
    verified.reviewDigest !== locked.quote.review_digest
  )
    reject("original_review_or_terms_changed");
  const proof = {
    kind: "original_schedule_configured" as const,
    ...verified,
    quoteId: locked.quote.id,
    sourceDigest: locked.quote.source_digest,
    createEffectId: create.id,
    configurationEffectId: configured.id,
    createReceiptDigest: create.receipt_digest!,
    configurationReceiptDigest: configured.receipt_digest!,
    observedAt: now.toISOString(),
  };
  // Persist the authenticated original snapshot, never the later mutable live schedule.
  if (settlementDigest(configuredSnapshot) !== proof.snapshotDigest)
    reject("configured_snapshot_changed");
  return { source, projection, command: locked.command, proof, configuredSnapshot };
}

/** Read-only original command context. A terminal result can replay without current provider reads. */
export async function readOrganizationSchedulePublicationSource(input: Identity, claim: Claim) {
  return writeTransaction(async (tx) => {
    const locked = await lockOriginal(tx, input, false);
    if (
      locked.command.status === "APPLIED" &&
      locked.command.organization_schedule_configuration_evidence !== null
    )
      return { kind: "terminal" as const, command: locked.command };
    const existing = await rows(tx, input);
    const create = existing.find((e) => e.kind === "schedule_create"),
      configuration = existing.find((e) => e.kind === "schedule_configure");
    if (
      !create ||
      create.state !== "observed" ||
      !create.receipt ||
      !create.started_at ||
      !configuration ||
      configuration.state === "ready" ||
      !configuration.started_at ||
      configuration.predecessor_id !== create.id ||
      existing.some((e) => e.kind === "schedule_release")
    )
      reject("original_configuration_attempt_required");
    scope(locked, create, undefined);
    scope(locked, configuration, create);
    assertLease(input, locked, claim, await readPostLockDatabaseNow(tx));
    return {
      kind: "observe" as const,
      create,
      configuration,
      apiVersion: locked.binding.apiVersion,
    };
  });
}

/** Original actor/current manager status; no provider request and no dispatch authority. */
export function readOrganizationScheduleCommand(input: Identity) {
  return writeTransaction(async (tx) => {
    const locked = await lockOriginal(tx, input, true);
    const existing = await rows(tx, input);
    return { command: locked.command, effects: existing };
  });
}

/** Read-only original effect scope under its current lease, including after manager loss. */
export function readOrganizationScheduleRecoverySource(input: Identity, claim: Claim) {
  return writeTransaction(async (tx) => {
    const locked = await lockOriginal(tx, input, false);
    assertLease(input, locked, claim, await readPostLockDatabaseNow(tx));
    const existing = await rows(tx, input);
    for (const effect of existing)
      scope(
        locked,
        effect,
        existing.find((e) => e.id === effect.predecessor_id),
      );
    return {
      effects: existing,
      apiVersion: locked.binding.apiVersion,
      reviewExpiresAt: locked.quote.expires_at,
      observedAt: await readPostLockDatabaseNow(tx),
    };
  });
}

/** Internal original-command read; system recovery does not borrow a user session. */
export function readOrganizationScheduleRecoveryCommand(input: Identity) {
  return writeTransaction(async (tx) => (await lockOriginal(tx, input, false)).command);
}
