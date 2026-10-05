/**
 * Discovers and re-verifies provider-confirmed billing suspensions that may
 * resume once funded entitlement returns (#30702). Discovery is only a hint:
 * enqueue admission and job execution re-run the same predicate on the primary
 * under the agent lifecycle lock, and recheck funding, before any effect.
 */
import { ElizaError } from "@elizaos/core";
import { and, asc, eq, gt, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES } from "../../lib/services/provisioning-job-types";
import type { DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import { agentComputeStopIntents } from "../schemas/agent-compute-stop-intents";
import { agentSandboxes, CONTAINER_BACKED_EXECUTION_TIERS } from "../schemas/agent-sandboxes";
import { jobs } from "../schemas/jobs";
import { organizations } from "../schemas/organizations";
import { personalDedicatedFallbacks } from "../schemas/personal-dedicated-fallbacks";
import { organizationHasNoActivePaymentReversalHold } from "./payment-reversal-holds";

/** Minimum quiet period before a failed automatic resume for the same stop may be retried. */
export const AUTOMATIC_RESUME_RETRY_BACKOFF_MINUTES = 15;

export interface BillingResumeCandidate {
  intentId: string;
  agentId: string;
  organizationId: string;
  userId: string;
}

/**
 * The organization may admit paid work at all. Account deletion, deactivation,
 * the paid-work fence and a final payment reversal hold always win over an
 * automatic resume.
 */
export function organizationAdmitsPaidWork(): SQL {
  return sql`${organizations.is_active} = true
    AND ${organizations.account_lifecycle_state} = 'active'
    AND ${organizations.account_deletion_request_id} IS NULL
    AND ${organizations.paid_work_fenced_at} IS NULL
    AND ${organizationHasNoActivePaymentReversalHold()}`;
}

/**
 * A billing stop is resumable only while it is still the agent's latest
 * lifecycle decision:
 * - the intent is a provider-confirmed `billing_request` and the newest intent
 *   for the agent, so a later user stop (or any later stop) wins;
 * - the agent is still `stopped`, container-backed, not deleting or deleted,
 *   has no unresolved replacement cleanup and no other owner job;
 * - no other exclusive lifecycle job was requested after the billing stop.
 *   Only this stop's own automatic resume may exist: in flight (reused by
 *   enqueue), or failed and quiesced for the retry backoff;
 * - for automatic resume, no lapsed paid plan currently withdraws the
 *   runtime's personal Dedicated access.
 */
function resumableBillingStop(ownerJobId?: string, requireOrganizationAdmission = true): SQL {
  const intents = agentComputeStopIntents;
  const exclusive = sql.join(
    EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES.map((type) => sql`${type}`),
    sql`, `,
  );
  return and(
    eq(intents.authorization, "billing_request"),
    eq(intents.status, "provider_confirmed"),
    eq(agentSandboxes.status, "stopped"),
    inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
    isNull(agentSandboxes.pool_status),
    isNull(agentSandboxes.deleted_at),
    isNull(agentSandboxes.deletion_attempt_id),
    isNull(agentSandboxes.deletion_started_at),
    isNull(agentSandboxes.replacement_cleanup_sandbox_id),
    ownerJobId
      ? sql`(${agentSandboxes.lifecycle_job_id} IS NULL OR ${agentSandboxes.lifecycle_job_id} = ${ownerJobId})`
      : isNull(agentSandboxes.lifecycle_job_id),
    sql`NOT EXISTS (
      SELECT 1 FROM ${intents} AS later_intent
      WHERE later_intent.organization_id = ${intents.organization_id}
        AND later_intent.agent_id = ${intents.agent_id}
        AND later_intent.id <> ${intents.id}
        AND (later_intent.created_at > ${intents.created_at}
          OR (later_intent.created_at = ${intents.created_at} AND later_intent.id > ${intents.id}))
    )`,
    sql`NOT EXISTS (
      SELECT 1 FROM ${jobs} AS later_job
      WHERE later_job.organization_id = ${intents.organization_id}
        AND later_job.agent_id = ${intents.agent_id}::text
        AND later_job.type IN (${exclusive})
        AND later_job.id IS DISTINCT FROM ${intents.job_id}
        AND later_job.created_at > ${intents.created_at}
        AND NOT (
          later_job.type = 'agent_resume'
          AND later_job.data -> 'automaticResume' ->> 'stopIntentId' = ${intents.id}::text
          AND (
            later_job.status IN ('pending', 'in_progress')
            ${ownerJobId ? sql`OR later_job.id = ${ownerJobId}` : sql``}
            OR (later_job.status = 'failed'
              AND later_job.completed_at IS NOT NULL
              AND later_job.completed_at < NOW() - make_interval(mins => ${AUTOMATIC_RESUME_RETRY_BACKOFF_MINUTES}))
          )
        )
    )`,
    requireOrganizationAdmission ? organizationAdmitsPaidWork() : undefined,
    requireOrganizationAdmission ? noPlanWithdrawnFallback() : undefined,
  ) as SQL;
}

/**
 * A lapsed paid plan withdrew this runtime's Dedicated access (#25146):
 * credits alone cannot restart it until the fallback authority has observed
 * restored entitlement and moved the interval to recovery.
 */
function noPlanWithdrawnFallback(): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${personalDedicatedFallbacks}
    WHERE ${personalDedicatedFallbacks.dedicated_agent_id} = ${agentSandboxes.id}
      AND ${personalDedicatedFallbacks.organization_id} = ${agentSandboxes.organization_id}
      AND ${personalDedicatedFallbacks.state} IN ('fallback_pending', 'shared_active')
      AND ${personalDedicatedFallbacks.reason} <> 'billing_suspended'
  )`;
}

function candidateQuery(executor: typeof dbWrite | DbTransaction, scope: SQL | undefined) {
  return executor
    .select({
      intentId: agentComputeStopIntents.id,
      agentId: agentSandboxes.id,
      organizationId: agentSandboxes.organization_id,
      userId: agentSandboxes.user_id,
    })
    .from(agentComputeStopIntents)
    .innerJoin(
      agentSandboxes,
      and(
        eq(agentSandboxes.id, agentComputeStopIntents.agent_id),
        eq(agentSandboxes.organization_id, agentComputeStopIntents.organization_id),
      ),
    )
    .innerJoin(organizations, eq(organizations.id, agentComputeStopIntents.organization_id))
    .where(scope);
}

/** One cursor page of discoverable suspensions, read from the primary. */
export async function listBillingResumeCandidates(input: {
  limit: number;
  afterIntentId?: string;
}): Promise<BillingResumeCandidate[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
    throw new ElizaError("Billing resume discovery requires a positive page size", {
      code: "INVALID_BILLING_RESUME_PAGE_SIZE",
      context: { limit: input.limit },
    });
  }
  return candidateQuery(
    dbWrite,
    and(
      resumableBillingStop(),
      input.afterIntentId ? gt(agentComputeStopIntents.id, input.afterIntentId) : undefined,
    ),
  )
    .orderBy(asc(agentComputeStopIntents.id))
    .limit(input.limit);
}

/**
 * Re-verifies one candidate inside the caller's transaction. The caller must
 * already hold the agent lifecycle lock. `ownerJobId` admits the automatic
 * resume job that is itself executing.
 */
export async function billingResumeStillAuthorizedInTransaction(
  tx: DbTransaction,
  candidate: BillingResumeCandidate,
  ownerJobId?: string,
): Promise<boolean> {
  const [row] = await candidateQuery(
    tx,
    and(
      resumableBillingStop(ownerJobId),
      eq(agentComputeStopIntents.id, candidate.intentId),
      eq(agentSandboxes.id, candidate.agentId),
      eq(agentSandboxes.organization_id, candidate.organizationId),
      eq(agentSandboxes.user_id, candidate.userId),
    ),
  ).limit(1);
  return row !== undefined;
}

/**
 * The provider-confirmed billing suspension that is still the agent's latest
 * lifecycle decision, regardless of whether the organization is funded now.
 * Dedicated-to-Shared fallback (#25146) uses this as its only withdrawal
 * signal; it never treats transient or unknown state as a suspension.
 */
export async function findConfirmedBillingSuspension(input: {
  agentId: string;
  organizationId: string;
}): Promise<BillingResumeCandidate | undefined> {
  const [row] = await candidateQuery(
    dbWrite,
    and(
      resumableBillingStop(undefined, false),
      eq(agentSandboxes.id, input.agentId),
      eq(agentSandboxes.organization_id, input.organizationId),
    ),
  ).limit(1);
  return row;
}

export interface ConfirmedBillingSuspension extends BillingResumeCandidate {
  providerConfirmedAt: Date;
}

/**
 * One cursor page of provider-confirmed billing suspensions that are still the
 * agent's latest lifecycle decision, whether or not the organization is funded
 * now. The funding-retention clock (#22967) starts from `providerConfirmedAt`.
 */
export async function listConfirmedBillingSuspensions(input: {
  limit: number;
  afterIntentId?: string;
}): Promise<ConfirmedBillingSuspension[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
    throw new ElizaError("Billing suspension discovery requires a positive page size", {
      code: "INVALID_BILLING_SUSPENSION_PAGE_SIZE",
      context: { limit: input.limit },
    });
  }
  const rows = await dbWrite
    .select({
      intentId: agentComputeStopIntents.id,
      agentId: agentSandboxes.id,
      organizationId: agentSandboxes.organization_id,
      userId: agentSandboxes.user_id,
      providerConfirmedAt: agentComputeStopIntents.provider_confirmed_at,
    })
    .from(agentComputeStopIntents)
    .innerJoin(
      agentSandboxes,
      and(
        eq(agentSandboxes.id, agentComputeStopIntents.agent_id),
        eq(agentSandboxes.organization_id, agentComputeStopIntents.organization_id),
      ),
    )
    .innerJoin(organizations, eq(organizations.id, agentComputeStopIntents.organization_id))
    .where(
      and(
        resumableBillingStop(undefined, false),
        input.afterIntentId ? gt(agentComputeStopIntents.id, input.afterIntentId) : undefined,
      ),
    )
    .orderBy(asc(agentComputeStopIntents.id))
    .limit(input.limit);
  return rows.flatMap((row) =>
    row.providerConfirmedAt ? [{ ...row, providerConfirmedAt: row.providerConfirmedAt }] : [],
  );
}
