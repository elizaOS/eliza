/**
 * Reversible, entitlement-driven fallback from a personal Dedicated agent to
 * Personal Shared (#25146).
 *
 * Withdrawal policy (owner-authorized). Dedicated access is withdrawn only by
 * a confirmed state, never by transient or unknown billing:
 * - the organization's paid plan (Plus/Pro) lapsed: payment failed past its
 *   grace period (`past_due`/`unpaid`), or the plan ended (`canceled`,
 *   including cancel-at-period-end once the period boundary is confirmed);
 * - or, for credit-funded agents, the runtime is `stopped` by a
 *   provider-confirmed `billing_request` stop that is still its latest
 *   lifecycle decision and the organization is unfunded now.
 * An active plan whose allowance is spent, `grace`, a passed deadline without
 * a confirmed lifecycle event (webhook lag), an expired incomplete checkout,
 * provisioning, user sleep and errors never withdraw access. Payment reversal
 * holds are owned by #22930 and are not interpreted here.
 *
 * One durable interval row per withdrawal is the transition owner:
 * dedicated_active → fallback_pending → shared_active → recovery_pending →
 * recovered (dedicated_active). Every transition runs under the account
 * advisory lock, re-reads the entitlement projection inside that transaction
 * and compare-and-swaps the row revision, so concurrent webhooks, reconciler
 * pages and connector turns converge on one state and one set of effects.
 *
 * While withdrawn, Shared answers in a new, separately scoped journal keyed by
 * a monotonic generation. The canonical Dedicated/pre-upgrade room is never
 * reopened. A running Dedicated runtime is stopped through the lifecycle queue
 * (state captured, runtime preserved, never deleted) and restored with the
 * same agent id once entitlement returns. Before routing returns, the complete
 * Shared interval is reconciled into Dedicated with a receipt.
 */
import { randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, asc, desc, eq, gt, isNotNull, sql } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { dbWrite } from "../../db/helpers";
import { findConfirmedBillingSuspension } from "../../db/repositories/agent-billing-resume";
import type { AgentSandbox } from "../../db/repositories/agent-sandboxes";
import { agentSandboxes } from "../../db/schemas/agent-sandboxes";
import {
  type BillingSubscriptionStatus,
  billingSubscriptionRevisions,
} from "../../db/schemas/billing-subscriptions";
import { jobs } from "../../db/schemas/jobs";
import {
  type OrganizationEntitlementState,
  organizationEntitlements,
} from "../../db/schemas/organization-entitlements";
import {
  type PersonalDedicatedFallback,
  type PersonalDedicatedFallbackReason,
  personalDedicatedFallbacks,
} from "../../db/schemas/personal-dedicated-fallbacks";
import { personalDedicatedUpgradeAuthorities } from "../../db/schemas/personal-dedicated-upgrade-authorities";
import { ApiError } from "../api/cloud-worker-errors";
import { logger } from "../utils/logger";
import { checkAgentCreditGate } from "./agent-billing-gate";
import { AGENT_FUNDING_RETENTION_DAYS } from "./agent-funding-retention";
import { withPersonalFallbackRecoveryLink } from "./personal-fallback-recovery-link";
import type { PersonalSharedFallbackAccountState } from "./shared-runtime/personal-fallback-account-state";

export type { PersonalDedicatedFallback } from "../../db/schemas/personal-dedicated-fallbacks";
export type { PersonalSharedFallbackAccountState } from "./shared-runtime/personal-fallback-account-state";

/**
 * Preservation window for a Dedicated agent whose paid plan lapsed. Nothing in
 * this workflow deletes the agent; `agent-funding-retention.ts` (#22967) sends
 * the 7-day and 1-day notices and removes the container through the sleep
 * lifecycle once this deadline passes, keeping the latest backup 90 more days.
 */
export const PERSONAL_DEDICATED_FALLBACK_RETENTION_DAYS = AGENT_FUNDING_RETENTION_DAYS;
export const PERSONAL_DEDICATED_FALLBACK_RETRY_AFTER_SECONDS = 5;

export const PERSONAL_DEDICATED_FALLBACK_CONFLICT = "PERSONAL_DEDICATED_FALLBACK_CONFLICT";

type PlanReason = Exclude<PersonalDedicatedFallbackReason, "billing_suspended">;

/** The subset of the organization entitlement projection the policy reads. */
export interface DedicatedPlanEntitlementSource {
  plan_key: string;
  state: OrganizationEntitlementState;
  entitlement_effective: boolean;
  effective_until: Date | null;
  projection_revision: number;
  source_subscription_id: string | null;
  /** Lifecycle status of the exact subscription revision the projection was built from. */
  source_status: BillingSubscriptionStatus | null;
}

export type DedicatedPlanEntitlement =
  /** No platform plan has ever governed this organization. */
  | { kind: "not_plan_governed" }
  | { kind: "entitled"; revision: number }
  /** A deadline passed without a confirmed lifecycle event: keep the current destination. */
  | { kind: "unconfirmed"; revision: number }
  | { kind: "withdrawn"; revision: number; reason: PlanReason };

/** Pure withdrawal policy over the organization entitlement projection. */
export function classifyDedicatedPlanEntitlement(
  source: DedicatedPlanEntitlementSource | undefined,
  now: Date,
): DedicatedPlanEntitlement {
  if (!source || source.source_subscription_id === null) return { kind: "not_plan_governed" };
  const revision = source.projection_revision;
  // An initial checkout that never paid never granted a plan to lapse.
  if (source.source_status === "incomplete_expired") return { kind: "not_plan_governed" };
  if (source.plan_key === "free") {
    // Canceled (immediately or at period end) projects to Free once confirmed.
    return source.source_status === "canceled"
      ? { kind: "withdrawn", revision, reason: "subscription_ended" }
      : { kind: "unconfirmed", revision };
  }
  if (source.state === "past_due" || source.state === "unpaid") {
    return { kind: "withdrawn", revision, reason: "subscription_payment_failed" };
  }
  if ((source.state === "active" || source.state === "grace") && source.entitlement_effective) {
    return source.effective_until === null || source.effective_until > now
      ? { kind: "entitled", revision }
      : { kind: "unconfirmed", revision };
  }
  return { kind: "unconfirmed", revision };
}

async function readPlanSource(
  executor: typeof dbWrite | DbTransaction,
  organizationId: string,
): Promise<DedicatedPlanEntitlementSource | undefined> {
  const [row] = await executor
    .select({
      plan_key: organizationEntitlements.plan_key,
      state: organizationEntitlements.state,
      entitlement_effective: organizationEntitlements.entitlement_effective,
      effective_until: organizationEntitlements.effective_until,
      projection_revision: organizationEntitlements.projection_revision,
      source_subscription_id: organizationEntitlements.source_subscription_id,
      source_status: billingSubscriptionRevisions.status,
    })
    .from(organizationEntitlements)
    .leftJoin(
      billingSubscriptionRevisions,
      and(
        eq(billingSubscriptionRevisions.organization_id, organizationEntitlements.organization_id),
        eq(
          billingSubscriptionRevisions.subscription_id,
          organizationEntitlements.source_subscription_id,
        ),
        eq(
          billingSubscriptionRevisions.revision,
          organizationEntitlements.source_subscription_revision,
        ),
      ),
    )
    .where(
      and(
        eq(organizationEntitlements.organization_id, organizationId),
        sql`${organizationEntitlements.billing_scope_id} IS NULL`,
      ),
    )
    .limit(1);
  return row;
}

/** A target already resolved for this exact account by the personal route authority. */
type DedicatedTarget = Pick<AgentSandbox, "id" | "status">;

export type PersonalDedicatedAccessDecision =
  | { access: "dedicated" }
  /** Unconfirmed plan state: neither withdraw nor restore. */
  | { access: "hold" }
  | {
      access: "withdrawn";
      reason: PersonalDedicatedFallbackReason;
      stopIntentId?: string;
      entitlementRevision?: number;
    };

async function legacyBillingWithdrawal(
  dedicated: DedicatedTarget,
  organizationId: string,
): Promise<{ stopIntentId: string } | null> {
  if (dedicated.status !== "stopped") return null;
  // Tenant-scoped: the suspension must belong to this organization's agent.
  const suspension = await findConfirmedBillingSuspension({
    agentId: dedicated.id,
    organizationId,
  });
  if (!suspension) return null;
  // Funding already returned: automatic resume restores Dedicated.
  const funding = await checkAgentCreditGate(organizationId);
  return funding.allowed ? null : { stopIntentId: suspension.intentId };
}

function combineDecision(
  plan: DedicatedPlanEntitlement,
  legacy: { stopIntentId: string } | null,
): PersonalDedicatedAccessDecision {
  if (plan.kind === "withdrawn") {
    return { access: "withdrawn", reason: plan.reason, entitlementRevision: plan.revision };
  }
  if (legacy) {
    return { access: "withdrawn", reason: "billing_suspended", stopIntentId: legacy.stopIntentId };
  }
  return plan.kind === "unconfirmed" ? { access: "hold" } : { access: "dedicated" };
}

/** Decide Dedicated access with the policy described above. */
export async function resolvePersonalDedicatedAccess(
  dedicated: DedicatedTarget,
  organizationId: string,
): Promise<PersonalDedicatedAccessDecision> {
  const [planSource, legacy] = await Promise.all([
    readPlanSource(dbWrite, organizationId),
    legacyBillingWithdrawal(dedicated, organizationId),
  ]);
  return combineDecision(classifyDedicatedPlanEntitlement(planSource, new Date()), legacy);
}

/** Effects the transition owner admits; production uses the lifecycle queue. */
export interface PersonalDedicatedFallbackEffects {
  /** Stop a live runtime inside the transition transaction: state captured, runtime preserved. */
  suspendInTransaction(
    tx: DbTransaction,
    input: { agentId: string; organizationId: string; userId: string },
  ): Promise<{ jobId: string }>;
  /** Resume the same preserved runtime once entitlement returns. */
  resume(input: {
    agentId: string;
    organizationId: string;
    userId: string;
  }): Promise<{ jobId: string }>;
}

async function lifecycleEffects(): Promise<PersonalDedicatedFallbackEffects> {
  // Lazy: the lifecycle queue is heavy and only needed when an effect is due.
  const { provisioningJobService } = await import("./provisioning-job-queue");
  return {
    async suspendInTransaction(tx, input) {
      // A user_request stop is the unconditional, state-preserving stop: a
      // billing_request stop would be skipped while credits remain, but plan
      // entitlement (not credit) is what withdrew this runtime.
      const { job } = await provisioningJobService.enqueueAgentSuspendOnceInTransaction(tx, {
        ...input,
        authorization: "user_request",
      });
      return { jobId: job.id };
    },
    async resume(input) {
      const { job } = await provisioningJobService.enqueueAgentResumeOnce(input);
      return { jobId: job.id };
    },
  };
}

function lockAccount(organizationId: string, userId: string, sourceAgentId: string) {
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${`personal-dedicated-fallback:${organizationId}:${userId}:${sourceAgentId}`}, 0))`;
}

function accountScope(input: { organizationId: string; userId: string; sourceAgentId: string }) {
  return and(
    eq(personalDedicatedFallbacks.organization_id, input.organizationId),
    eq(personalDedicatedFallbacks.user_id, input.userId),
    eq(personalDedicatedFallbacks.source_agent_id, input.sourceAgentId),
  );
}

function fallbackConflict(message: string, context: Record<string, unknown>): never {
  throw new ElizaError(message, { code: PERSONAL_DEDICATED_FALLBACK_CONFLICT, context });
}

function isLifecycleAdmissionConflict(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 409 || error.status === 404);
}

const LIVE_RUNTIME_STATUSES: ReadonlySet<string> = new Set(["running", "pending", "provisioning"]);

export interface PersonalDedicatedAccount {
  organizationId: string;
  userId: string;
  /** Canonical `personal:` Shared identity. */
  sourceAgentId: string;
}

async function lastAppliedEntitlementRevision(
  tx: DbTransaction,
  input: PersonalDedicatedAccount,
): Promise<number | null> {
  const [row] = await tx
    .select({
      revision: sql<string | null>`MAX(GREATEST(
        COALESCE(${personalDedicatedFallbacks.entitlement_revision}, -1),
        COALESCE(${personalDedicatedFallbacks.recovery_entitlement_revision}, -1)))`,
    })
    .from(personalDedicatedFallbacks)
    .where(accountScope(input));
  const value = row?.revision === null || row?.revision === undefined ? -1 : Number(row.revision);
  return value >= 0 ? value : null;
}

/**
 * Applies the current entitlement decision to the account's interval under
 * the account lock. Returns the open interval after the transition, or null
 * when the account is `dedicated_active`.
 */
async function applyTransition(
  input: PersonalDedicatedAccount & { dedicatedAgentId: string },
  legacy: { stopIntentId: string } | null,
  effects: PersonalDedicatedFallbackEffects,
): Promise<PersonalDedicatedFallback | null> {
  return dbWrite.transaction(async (tx) => {
    await tx.execute(lockAccount(input.organizationId, input.userId, input.sourceAgentId));
    const now = new Date();
    // Re-read inside the lock: the decision acted on is the committed projection.
    const plan = classifyDedicatedPlanEntitlement(
      await readPlanSource(tx, input.organizationId),
      now,
    );
    const decision = combineDecision(plan, legacy);
    const [latest] = await tx
      .select()
      .from(personalDedicatedFallbacks)
      .where(accountScope(input))
      .orderBy(desc(personalDedicatedFallbacks.generation))
      .limit(1)
      .for("update");
    let open = latest && latest.state !== "recovered" ? latest : null;
    if (open && open.dedicated_agent_id !== input.dedicatedAgentId) {
      fallbackConflict("Personal fallback belongs to a different Dedicated agent", {
        organizationId: input.organizationId,
        fallbackId: open.id,
      });
    }
    // Monotonic fence: a decision derived from an older entitlement
    // projection than one this account already applied is stale.
    const applied = await lastAppliedEntitlementRevision(tx, input);
    const planRevision = plan.kind === "not_plan_governed" ? null : plan.revision;
    if (planRevision !== null && applied !== null && planRevision < applied) return open;

    if (decision.access === "withdrawn") {
      if (!open) {
        const retainUntil =
          decision.reason === "billing_suspended"
            ? null
            : new Date(now.getTime() + PERSONAL_DEDICATED_FALLBACK_RETENTION_DAYS * 86_400_000);
        const [created] = await tx
          .insert(personalDedicatedFallbacks)
          .values({
            organization_id: input.organizationId,
            user_id: input.userId,
            source_agent_id: input.sourceAgentId,
            dedicated_agent_id: input.dedicatedAgentId,
            generation: (latest?.generation ?? 0) + 1,
            state: "fallback_pending",
            reason: decision.reason,
            stop_intent_id: decision.stopIntentId ?? null,
            entitlement_revision: decision.entitlementRevision ?? null,
            retain_until: retainUntil,
            journal_room_id: `fallback:${randomUUID()}`,
            activated_at: now,
            updated_at: now,
          })
          .returning();
        open = created;
        logger.warn("[personal-dedicated-fallback] Dedicated access withdrawn", {
          organizationId: input.organizationId,
          dedicatedAgentId: input.dedicatedAgentId,
          generation: created.generation,
          reason: created.reason,
          entitlementRevision: created.entitlement_revision,
        });
      } else if (open.state === "recovery_pending") {
        // Withdrawn again before recovery committed: the same interval and
        // journal continue; any in-flight resume is followed by a new stop.
        const [reopened] = await tx
          .update(personalDedicatedFallbacks)
          .set({
            state: "fallback_pending",
            recovery_requested_at: null,
            recovery_entitlement_revision: null,
            ...(decision.entitlementRevision !== undefined
              ? { entitlement_revision: decision.entitlementRevision }
              : {}),
            revision: open.revision + 1,
            updated_at: now,
          })
          .where(
            and(
              eq(personalDedicatedFallbacks.id, open.id),
              eq(personalDedicatedFallbacks.revision, open.revision),
            ),
          )
          .returning();
        open = reopened;
      }
      if (open.state === "fallback_pending") open = await activateInTransaction(tx, open, effects);
      return open;
    }

    if (decision.access === "dedicated" && open && open.state !== "recovery_pending") {
      const [recovering] = await tx
        .update(personalDedicatedFallbacks)
        .set({
          state: "recovery_pending",
          recovery_requested_at: now,
          recovery_entitlement_revision: planRevision,
          revision: open.revision + 1,
          updated_at: now,
        })
        .where(
          and(
            eq(personalDedicatedFallbacks.id, open.id),
            eq(personalDedicatedFallbacks.revision, open.revision),
          ),
        )
        .returning();
      open = recovering;
      logger.info("[personal-dedicated-fallback] Dedicated entitlement restored; recovering", {
        organizationId: input.organizationId,
        dedicatedAgentId: input.dedicatedAgentId,
        generation: recovering.generation,
      });
    }
    if (decision.access === "hold" && open?.state === "fallback_pending") {
      open = await activateInTransaction(tx, open, effects);
    }
    return open;
  });
}

/**
 * fallback_pending → shared_active. A live runtime is stopped through the
 * lifecycle queue in the same transaction; a conflicting lifecycle job keeps
 * the interval pending (honestly unavailable) until a later attempt.
 */
async function activateInTransaction(
  tx: DbTransaction,
  row: PersonalDedicatedFallback,
  effects: PersonalDedicatedFallbackEffects,
): Promise<PersonalDedicatedFallback> {
  const [agent] = await tx
    .select({ status: agentSandboxes.status, deletedAt: agentSandboxes.deleted_at })
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.id, row.dedicated_agent_id),
        eq(agentSandboxes.organization_id, row.organization_id),
      ),
    )
    .limit(1);
  let suspendJobId = row.suspend_job_id;
  if (agent && agent.deletedAt === null && LIVE_RUNTIME_STATUSES.has(agent.status)) {
    try {
      const admitted = await tx.transaction((savepoint) =>
        effects.suspendInTransaction(savepoint, {
          agentId: row.dedicated_agent_id,
          organizationId: row.organization_id,
          userId: row.user_id,
        }),
      );
      suspendJobId = admitted.jobId;
    } catch (error) {
      if (!isLifecycleAdmissionConflict(error)) throw error;
      // error-policy:J1 another lifecycle owner holds the runtime; the
      // interval stays pending and routing reports honest unavailability.
      logger.warn("[personal-dedicated-fallback] Dedicated stop not admitted yet", {
        organizationId: row.organization_id,
        dedicatedAgentId: row.dedicated_agent_id,
        generation: row.generation,
        error: error instanceof Error ? error.message : String(error),
      });
      return row;
    }
  }
  const now = new Date();
  const [active] = await tx
    .update(personalDedicatedFallbacks)
    .set({
      state: "shared_active",
      suspend_job_id: suspendJobId,
      revision: row.revision + 1,
      updated_at: now,
    })
    .where(
      and(
        eq(personalDedicatedFallbacks.id, row.id),
        eq(personalDedicatedFallbacks.revision, row.revision),
        eq(personalDedicatedFallbacks.state, "fallback_pending"),
      ),
    )
    .returning();
  if (!active) {
    fallbackConflict("Personal fallback activation lost its revision fence", {
      fallbackId: row.id,
      revision: row.revision,
    });
  }
  return active;
}

/**
 * True when this interval stopped a live runtime and so owns restarting it.
 * Credit-driven intervals leave restart to automatic billing resume (#30702)
 * and the owner's explicit start, as before this workflow.
 */
function ownsDedicatedRestart(row: PersonalDedicatedFallback): boolean {
  return row.suspend_job_id !== null;
}

/** Whether a lifecycle job this interval admitted is still queued or running. */
async function jobInFlight(row: PersonalDedicatedFallback, jobId: string | null): Promise<boolean> {
  if (!jobId) return false;
  const [job] = await dbWrite
    .select({ status: jobs.status })
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.organization_id, row.organization_id)))
    .limit(1);
  return job !== undefined && job.status !== "failed" && job.status !== "completed";
}

/**
 * Admits one resume of the same preserved runtime for an interval that
 * stopped it. It waits for that stop to settle, so a queued stop can never
 * land after the restart. Idempotent: an admitted, unfinished resume is never
 * duplicated.
 */
async function admitRecoveryResume(
  row: PersonalDedicatedFallback,
  dedicated: DedicatedTarget,
  effects: PersonalDedicatedFallbackEffects,
): Promise<PersonalDedicatedFallback> {
  if (
    row.state !== "recovery_pending" ||
    !ownsDedicatedRestart(row) ||
    (dedicated.status !== "stopped" && dedicated.status !== "sleeping") ||
    (await jobInFlight(row, row.suspend_job_id)) ||
    (await jobInFlight(row, row.resume_job_id))
  ) {
    return row;
  }
  let jobId: string;
  try {
    ({ jobId } = await effects.resume({
      agentId: row.dedicated_agent_id,
      organizationId: row.organization_id,
      userId: row.user_id,
    }));
  } catch (error) {
    if (!isLifecycleAdmissionConflict(error)) throw error;
    // error-policy:J1 a conflicting lifecycle job (e.g. the stop still
    // settling) owns the runtime; the next turn or reconciler page retries.
    logger.warn("[personal-dedicated-fallback] Dedicated resume not admitted yet", {
      organizationId: row.organization_id,
      dedicatedAgentId: row.dedicated_agent_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return row;
  }
  const [updated] = await dbWrite
    .update(personalDedicatedFallbacks)
    .set({ resume_job_id: jobId, revision: row.revision + 1, updated_at: new Date() })
    .where(
      and(
        eq(personalDedicatedFallbacks.id, row.id),
        eq(personalDedicatedFallbacks.revision, row.revision),
        eq(personalDedicatedFallbacks.state, "recovery_pending"),
      ),
    )
    .returning();
  // A concurrent transition won; its state is authoritative.
  return updated ?? (await readFallback(row.id)) ?? row;
}

async function readFallback(id: string): Promise<PersonalDedicatedFallback | undefined> {
  const [row] = await dbWrite
    .select()
    .from(personalDedicatedFallbacks)
    .where(eq(personalDedicatedFallbacks.id, id))
    .limit(1);
  return row;
}

function needsTransition(
  decision: PersonalDedicatedAccessDecision,
  open: PersonalDedicatedFallback | undefined,
): boolean {
  if (decision.access === "withdrawn") return !open || open.state !== "shared_active";
  if (decision.access === "dedicated") {
    return open !== undefined && open.state !== "recovery_pending";
  }
  // Unconfirmed state never changes direction, but a withdrawal already
  // committed still finishes activating.
  return open?.state === "fallback_pending";
}

/**
 * Converges one account on its current entitlement: the single transition
 * owner for connector turns and the reconciler. Returns the open interval, or
 * null when the account is `dedicated_active`.
 */
export async function syncPersonalDedicatedEntitlement(
  input: PersonalDedicatedAccount & {
    dedicated: DedicatedTarget;
    effects?: PersonalDedicatedFallbackEffects;
  },
): Promise<PersonalDedicatedFallback | null> {
  const [decision, [open]] = await Promise.all([
    resolvePersonalDedicatedAccess(input.dedicated, input.organizationId),
    dbWrite
      .select()
      .from(personalDedicatedFallbacks)
      .where(and(accountScope(input), sql`${personalDedicatedFallbacks.state} <> 'recovered'`))
      .limit(1),
  ]);
  // Hot path: most Dedicated turns are entitled with no open interval.
  let row: PersonalDedicatedFallback | null = open ?? null;
  if (needsTransition(decision, open)) {
    const effects = input.effects ?? (await lifecycleEffects());
    const legacy =
      decision.access === "withdrawn" && decision.reason === "billing_suspended"
        ? { stopIntentId: decision.stopIntentId as string }
        : null;
    row = await applyTransition(
      { ...input, dedicatedAgentId: input.dedicated.id },
      legacy,
      effects,
    );
  }
  if (row?.state === "recovery_pending") {
    row = await admitRecoveryResume(
      row,
      input.dedicated,
      input.effects ?? (await lifecycleEffects()),
    );
  }
  return row;
}

function accountState(fallback: PersonalDedicatedFallback): PersonalSharedFallbackAccountState {
  return {
    access: "shared_fallback",
    state: fallback.state === "recovery_pending" ? "recovery_pending" : "shared_active",
    reason: fallback.reason,
    dedicatedMemory: "unavailable",
    generation: fallback.generation,
    dedicatedRetainedUntil: fallback.retain_until?.toISOString() ?? null,
    recoveryAction: {
      kind: fallback.reason === "billing_suspended" ? "add_credits" : "restore_subscription",
      path: "/cloud/billing",
    },
  };
}

export interface PersonalSharedFallbackDelivery {
  fallback: PersonalDedicatedFallback;
  /** Separately scoped Shared journal for this interval only. */
  journalRoomId: string;
  accountState: PersonalSharedFallbackAccountState;
}

export type PersonalDedicatedRoute =
  /** Dedicated owns routing. `reconcile` is an interval to import before the first send. */
  | { route: "dedicated"; reconcile: PersonalDedicatedFallback | null }
  | { route: "shared_fallback"; delivery: PersonalSharedFallbackDelivery }
  | {
      route: "unavailable";
      code: "dedicated_fallback_pending";
      error: string;
      status: 503;
      retryable: true;
      retryAfterSeconds: number;
    };

/**
 * The single authority decision both personal consumers use for a direct
 * turn whose account has a Dedicated target.
 */
export async function resolvePersonalDedicatedRoute(
  input: PersonalDedicatedAccount & {
    dedicated: DedicatedTarget;
    effects?: PersonalDedicatedFallbackEffects;
  },
): Promise<PersonalDedicatedRoute> {
  const row = await syncPersonalDedicatedEntitlement(input);
  if (!row) return { route: "dedicated", reconcile: null };
  if (row.state === "fallback_pending") {
    return {
      route: "unavailable",
      code: "dedicated_fallback_pending",
      error: "Eliza is switching this account to the free agent. Try again in a moment.",
      status: 503,
      retryable: true,
      retryAfterSeconds: PERSONAL_DEDICATED_FALLBACK_RETRY_AFTER_SECONDS,
    };
  }
  if (row.state === "recovery_pending") {
    // An interval that stopped the runtime keeps Shared in its journal until
    // that stop settled and the same runtime is running again. Otherwise
    // Dedicated owns routing with its existing honest unavailability, and the
    // interval is reconciled before the first Dedicated send.
    const restarting =
      ownsDedicatedRestart(row) &&
      (input.dedicated.status !== "running" || (await jobInFlight(row, row.suspend_job_id)));
    if (!restarting) return { route: "dedicated", reconcile: row };
  }
  // The pay action carries a signed, expiring link to the billing surface.
  const state = await withPersonalFallbackRecoveryLink(accountState(row), row, (error) =>
    logger.error("[personal-dedicated-fallback] Recovery link signing is unavailable", {
      organizationId: row.organization_id,
      fallbackId: row.id,
      code: error.code,
    }),
  );
  return {
    route: "shared_fallback",
    delivery: {
      fallback: row,
      journalRoomId: row.journal_room_id,
      accountState: state,
    },
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PersonalDedicatedTrafficAccess =
  /** Not a withdrawn personal Dedicated: the caller's normal Dedicated contract applies. */
  | { access: "dedicated" }
  | {
      access: "withdrawn";
      /** 409 while Shared owns the owner's direct conversation; 503 while switching. */
      status: 409 | 503;
      code:
        | "personal_dedicated_access_withdrawn"
        | "dedicated_fallback_pending"
        | "dedicated_reconciling";
      error: string;
      retryable: boolean;
      retryAfterSeconds?: number;
      /** Owner-only account state. Never render it into group or shared-gateway replies. */
      accountState?: PersonalSharedFallbackAccountState;
    };

/**
 * The route decision for traffic that addresses a Dedicated agent directly
 * rather than through its owner's personal identity: group rooms, the shared
 * connector gateway and the Dedicated bridge. Such traffic never has a Shared
 * fallback of its own (the fallback journal is scoped to the owner's direct
 * conversation), so while the owner's Dedicated access is withdrawn it is
 * refused with the same typed state and never reaches Dedicated memory. An
 * agent that is not a cut-over personal Dedicated is unaffected.
 */
export async function resolvePersonalDedicatedTrafficAccess(input: {
  dedicatedAgentId: string;
  organizationId: string;
  effects?: PersonalDedicatedFallbackEffects;
}): Promise<PersonalDedicatedTrafficAccess> {
  // Only uuid-keyed agent rows can hold a personal Dedicated authority.
  if (!UUID_PATTERN.test(input.dedicatedAgentId)) return { access: "dedicated" };
  const [authority] = await dbWrite
    .select({
      userId: personalDedicatedUpgradeAuthorities.user_id,
      sourceAgentId: personalDedicatedUpgradeAuthorities.source_agent_id,
    })
    .from(personalDedicatedUpgradeAuthorities)
    .where(
      and(
        eq(personalDedicatedUpgradeAuthorities.dedicated_agent_id, input.dedicatedAgentId),
        eq(personalDedicatedUpgradeAuthorities.organization_id, input.organizationId),
        isNotNull(personalDedicatedUpgradeAuthorities.cutover_token),
      ),
    )
    .limit(1);
  if (!authority) return { access: "dedicated" };
  const { findActivePersonalDedicatedTarget } = await import("./agent-tier-upgrade-target");
  const dedicated = await findActivePersonalDedicatedTarget(
    input.organizationId,
    authority.userId,
    authority.sourceAgentId,
  );
  if (!dedicated || dedicated.id !== input.dedicatedAgentId) return { access: "dedicated" };
  const route = await resolvePersonalDedicatedRoute({
    dedicated,
    organizationId: input.organizationId,
    userId: authority.userId,
    sourceAgentId: authority.sourceAgentId,
    ...(input.effects ? { effects: input.effects } : {}),
  });
  if (route.route === "dedicated") {
    if (route.reconcile) {
      // These callers have no conversation coordinator. The owner-facing
      // direct or connector path must finish the canonical journal import
      // before a cached Dedicated destination can accept another turn.
      return {
        access: "withdrawn",
        status: 503,
        code: "dedicated_reconciling",
        error: "Dedicated Eliza is restoring your recent conversation. Try again shortly.",
        retryable: true,
        retryAfterSeconds: 5,
      };
    }
    return { access: "dedicated" };
  }
  if (route.route === "unavailable") {
    return {
      access: "withdrawn",
      status: 503,
      code: route.code,
      error: route.error,
      retryable: true,
      retryAfterSeconds: route.retryAfterSeconds,
    };
  }
  return {
    access: "withdrawn",
    status: 409,
    code: "personal_dedicated_access_withdrawn",
    error: "This Dedicated Eliza is paused until the owner restores billing.",
    retryable: false,
    accountState: route.delivery.accountState,
  };
}

/**
 * recovery_pending → recovered, the final route commit. Fenced by the exact
 * interval revision and a fresh entitlement read under the account lock; the
 * receipt proves the complete Shared interval reached Dedicated.
 */
export async function completePersonalFallbackRecovery(input: {
  fallback: PersonalDedicatedFallback;
  receipt: { sourceMessageCount: number; inserted: number };
}): Promise<PersonalDedicatedFallback> {
  const { fallback, receipt } = input;
  if (
    !Number.isSafeInteger(receipt.sourceMessageCount) ||
    !Number.isSafeInteger(receipt.inserted) ||
    receipt.sourceMessageCount < 0 ||
    receipt.inserted < 0 ||
    receipt.inserted > receipt.sourceMessageCount
  ) {
    throw new ElizaError("Personal fallback reconciliation receipt is invalid", {
      code: "PERSONAL_DEDICATED_FALLBACK_RECEIPT_INVALID",
      context: { fallbackId: fallback.id },
    });
  }
  return dbWrite.transaction(async (tx) => {
    await tx.execute(
      lockAccount(fallback.organization_id, fallback.user_id, fallback.source_agent_id),
    );
    const plan = classifyDedicatedPlanEntitlement(
      await readPlanSource(tx, fallback.organization_id),
      new Date(),
    );
    if (fallback.reason !== "billing_suspended" && plan.kind !== "entitled") {
      fallbackConflict("Dedicated entitlement is no longer current at route commit", {
        fallbackId: fallback.id,
        entitlement: plan.kind,
      });
    }
    const now = new Date();
    const [recovered] = await tx
      .update(personalDedicatedFallbacks)
      .set({
        state: "recovered",
        recovered_at: now,
        reconciled_message_count: receipt.sourceMessageCount,
        reconciled_inserted_count: receipt.inserted,
        revision: fallback.revision + 1,
        updated_at: now,
      })
      .where(
        and(
          eq(personalDedicatedFallbacks.id, fallback.id),
          eq(personalDedicatedFallbacks.revision, fallback.revision),
          eq(personalDedicatedFallbacks.state, "recovery_pending"),
        ),
      )
      .returning();
    if (!recovered) {
      fallbackConflict("Personal fallback recovery lost its revision fence", {
        fallbackId: fallback.id,
        revision: fallback.revision,
      });
    }
    logger.info("[personal-dedicated-fallback] Dedicated access restored; interval reconciled", {
      organizationId: fallback.organization_id,
      dedicatedAgentId: fallback.dedicated_agent_id,
      generation: recovered.generation,
      reconciledMessages: receipt.sourceMessageCount,
    });
    return recovered;
  });
}

/**
 * One cursor page of the reconciler that runs beside automatic billing resume
 * in the provisioning worker. It converges accounts whose plan lapsed (stop
 * the paid runtime promptly, without waiting for a connector turn) and whose
 * plan returned (restart the same runtime). The final route commit happens on
 * the next personal turn, which owns the conversation coordinator.
 */
export async function reconcilePersonalDedicatedEntitlements(input: {
  limit: number;
  afterAuthorityId?: string;
  effects?: PersonalDedicatedFallbackEffects;
}) {
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
    throw new ElizaError("Personal Dedicated entitlement reconcile requires a positive page size", {
      code: "INVALID_PERSONAL_DEDICATED_RECONCILE_PAGE_SIZE",
      context: { limit: input.limit },
    });
  }
  const authorities = await dbWrite
    .select({
      id: personalDedicatedUpgradeAuthorities.id,
      organizationId: personalDedicatedUpgradeAuthorities.organization_id,
      userId: personalDedicatedUpgradeAuthorities.user_id,
      sourceAgentId: personalDedicatedUpgradeAuthorities.source_agent_id,
    })
    .from(personalDedicatedUpgradeAuthorities)
    .where(
      and(
        isNotNull(personalDedicatedUpgradeAuthorities.cutover_token),
        input.afterAuthorityId
          ? gt(personalDedicatedUpgradeAuthorities.id, input.afterAuthorityId)
          : undefined,
        sql`(EXISTS (
          SELECT 1 FROM ${organizationEntitlements}
          WHERE ${organizationEntitlements.organization_id} = ${personalDedicatedUpgradeAuthorities.organization_id}
            AND ${organizationEntitlements.billing_scope_id} IS NULL
            AND ${organizationEntitlements.source_subscription_id} IS NOT NULL
        ) OR EXISTS (
          SELECT 1 FROM ${personalDedicatedFallbacks}
          WHERE ${personalDedicatedFallbacks.organization_id} = ${personalDedicatedUpgradeAuthorities.organization_id}
            AND ${personalDedicatedFallbacks.user_id} = ${personalDedicatedUpgradeAuthorities.user_id}
            AND ${personalDedicatedFallbacks.source_agent_id} = ${personalDedicatedUpgradeAuthorities.source_agent_id}
            AND ${personalDedicatedFallbacks.state} <> 'recovered'
        ))`,
      ),
    )
    .orderBy(asc(personalDedicatedUpgradeAuthorities.id))
    .limit(input.limit);
  const result = {
    total: authorities.length,
    open: 0,
    failures: [] as Array<{ authorityId: string; error: string }>,
    nextCursor: authorities.length === input.limit ? (authorities.at(-1)?.id ?? null) : null,
  };
  if (authorities.length === 0) return result;
  const { findActivePersonalDedicatedTarget } = await import("./agent-tier-upgrade-target");
  for (const authority of authorities) {
    try {
      const dedicated = await findActivePersonalDedicatedTarget(
        authority.organizationId,
        authority.userId,
        authority.sourceAgentId,
      );
      if (!dedicated || dedicated.deleted_at !== null) continue;
      const row = await syncPersonalDedicatedEntitlement({
        organizationId: authority.organizationId,
        userId: authority.userId,
        sourceAgentId: authority.sourceAgentId,
        dedicated,
        ...(input.effects ? { effects: input.effects } : {}),
      });
      if (row) result.open += 1;
    } catch (error) {
      // error-policy:J1 each failed account is reported; its authority stays
      // discoverable on the next reconciliation page.
      const failure = {
        authorityId: authority.id,
        error: error instanceof Error ? error.message : String(error),
      };
      result.failures.push(failure);
      logger.error("[personal-dedicated-fallback] Entitlement reconcile failed", failure);
    }
  }
  return result;
}
