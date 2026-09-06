/**
 * Owns confirmed payment-stop receipts and the authority to resume their agents.
 * Lifecycle locks bind confirmation, queue admission and provider execution to
 * the current grant, funding and worker lease. Later manual stops revoke recovery.
 */
import { ElizaError } from "@elizaos/core";
import { and, asc, eq, gt, inArray, isNotNull, isNull, or, type SQL, sql } from "drizzle-orm";
import {
  configureElizaLifecycleTransaction,
  elizaProvisionAdvisoryLockSql,
} from "../../lib/services/eliza-provision-lock";
import type { DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import { agentComputeStopIntents } from "../schemas/agent-compute-stop-intents";
import { agentSandboxes, CONTAINER_BACKED_EXECUTION_TIERS } from "../schemas/agent-sandboxes";
import { jobExecutionLeases } from "../schemas/job-execution-leases";
import { jobs } from "../schemas/jobs";
import { agentBillingRepository } from "./agent-billing";
import { readPostLockDatabaseNow } from "./primary-database-clock";

/** Discovery is a hint; admission must recheck this authority and current funding under locks. */
export async function listAgentPaymentResumeCandidates(input: {
  limit: number;
  afterIntentId?: string;
}) {
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
    throw new ElizaError("Payment resume discovery requires a positive page size", {
      code: "INVALID_PAYMENT_RESUME_PAGE_SIZE",
      context: { limit: input.limit },
    });
  }
  return paymentResumeCandidateQuery(
    dbWrite,
    input.afterIntentId ? gt(agentComputeStopIntents.id, input.afterIntentId) : undefined,
  )
    .orderBy(asc(agentComputeStopIntents.id))
    .limit(input.limit);
}

function paymentResumeCandidateQuery(executor: typeof dbWrite | DbTransaction, scope?: SQL) {
  return executor
    .select({
      intentId: agentComputeStopIntents.id,
      agentId: agentSandboxes.id,
      organizationId: agentSandboxes.organization_id,
      userId: agentSandboxes.user_id,
      lifecycleRevision: sql<string>`${agentComputeStopIntents.provider_confirmed_lifecycle_revision}::text`,
    })
    .from(agentComputeStopIntents)
    .innerJoin(
      agentSandboxes,
      and(
        eq(agentSandboxes.id, agentComputeStopIntents.agent_id),
        eq(agentSandboxes.organization_id, agentComputeStopIntents.organization_id),
      ),
    )
    .where(
      and(
        eq(agentComputeStopIntents.authorization, "billing_request"),
        eq(agentComputeStopIntents.status, "provider_confirmed"),
        // Exhausting a job must not reset its backoff through a fresh job.
        // Missing terminal timestamps are unknown, not evidence of a due retry.
        sql`NOT EXISTS (SELECT 1 FROM ${jobs} AS failed_resume
          WHERE failed_resume.id = ${agentComputeStopIntents.resume_job_id}
            AND failed_resume.status = 'failed'
            AND (failed_resume.completed_at IS NULL
              OR failed_resume.execution_quiesced_at IS NULL
              OR GREATEST(failed_resume.completed_at, failed_resume.execution_quiesced_at)
                > clock_timestamp() - interval '2 minutes'))`,
        or(
          and(
            eq(agentSandboxes.status, "stopped"),
            eq(
              agentSandboxes.lifecycle_revision,
              agentComputeStopIntents.provider_confirmed_lifecycle_revision,
            ),
            isNull(agentSandboxes.replacement_cleanup_sandbox_id),
            isNull(agentSandboxes.replacement_cleanup_attempt_id),
            isNull(agentSandboxes.replacement_cleanup_container_id),
          ),
          and(
            isNotNull(agentComputeStopIntents.resume_started_at),
            inArray(agentSandboxes.status, [
              "stopped",
              "provisioning",
              "error",
              "disconnected",
              "pending",
            ]),
            isNull(agentSandboxes.lifecycle_job_id),
            isNull(agentSandboxes.lifecycle_execution_generation),
            sql`EXISTS (SELECT 1 FROM ${jobs} AS previous_resume
              WHERE previous_resume.id = ${agentComputeStopIntents.resume_job_id}
                AND previous_resume.type = 'agent_resume'
                AND previous_resume.agent_id = ${agentSandboxes.id}::text
                AND previous_resume.organization_id = ${agentSandboxes.organization_id}
                AND previous_resume.user_id = ${agentSandboxes.user_id}
                AND previous_resume.status = 'failed'
                AND previous_resume.execution_quiesced_at IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM ${jobExecutionLeases} AS previous_lease
                  WHERE previous_lease.job_id = previous_resume.id
                    AND previous_lease.expires_at > clock_timestamp()))`,
          ),
        ),
        inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
        isNull(agentSandboxes.pool_status),
        isNull(agentSandboxes.deletion_attempt_id),
        isNull(agentSandboxes.deletion_started_at),
        isNull(agentSandboxes.deleted_at),
        sql`NOT EXISTS (SELECT 1 FROM agent_compute_stop_intents AS other_stop
        WHERE other_stop.organization_id = ${agentSandboxes.organization_id}
          AND other_stop.agent_id = ${agentSandboxes.id}
          AND (
            other_stop.status IN ('pending', 'dispatching', 'retry', 'terminal_attention')
            OR (other_stop.authorization = 'user_request'
              AND other_stop.lifecycle_revision >= ${agentComputeStopIntents.lifecycle_revision})
          ))`,
        scope,
      ),
    );
}

export interface AgentPaymentResumeAuthority {
  intentId: string;
  agentId: string;
  organizationId: string;
  userId: string;
  lifecycleRevision: string;
}

export interface AgentPaymentResumeExecutionAuthority extends AgentPaymentResumeAuthority {
  jobId: string;
  executionGeneration: string;
  executionOwnerId: string;
}

/** Check a bound grant; only a first claim may establish its started receipt. */
export async function assertPaymentResumeExecutionAuthorityInTransaction(
  tx: DbTransaction,
  input: AgentPaymentResumeAuthority & { jobId: string },
  phase: "claim" | "provider" | "cleanup",
): Promise<void> {
  const [grant] = await tx
    .select({ startedAt: agentComputeStopIntents.resume_started_at })
    .from(agentComputeStopIntents)
    .innerJoin(
      agentSandboxes,
      and(
        eq(agentSandboxes.id, agentComputeStopIntents.agent_id),
        eq(agentSandboxes.organization_id, agentComputeStopIntents.organization_id),
      ),
    )
    .where(
      and(
        eq(agentComputeStopIntents.id, input.intentId),
        eq(agentComputeStopIntents.resume_job_id, input.jobId),
        eq(agentComputeStopIntents.status, "provider_confirmed"),
        eq(agentComputeStopIntents.authorization, "billing_request"),
        sql`${agentComputeStopIntents.provider_confirmed_lifecycle_revision} = ${input.lifecycleRevision}::bigint`,
        eq(agentSandboxes.id, input.agentId),
        eq(agentSandboxes.organization_id, input.organizationId),
        eq(agentSandboxes.user_id, input.userId),
        inArray(agentSandboxes.status, [
          "stopped",
          "provisioning",
          "error",
          "disconnected",
          "running",
          "pending",
        ]),
        inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
        isNull(agentSandboxes.pool_status),
        isNull(agentSandboxes.deleted_at),
        isNull(agentSandboxes.deletion_attempt_id),
        isNull(agentSandboxes.deletion_started_at),
        sql`NOT EXISTS (SELECT 1 FROM agent_compute_stop_intents AS other_stop
        WHERE other_stop.organization_id = ${input.organizationId} AND other_stop.agent_id = ${input.agentId}
          AND (other_stop.status IN ('pending', 'dispatching', 'retry', 'terminal_attention')
            OR (other_stop.authorization = 'user_request'
              AND other_stop.lifecycle_revision >= ${agentComputeStopIntents.lifecycle_revision})))`,
      ),
    )
    .for("update")
    .limit(1);
  if (
    !grant ||
    (phase !== "claim" && grant.startedAt === null) ||
    (grant.startedAt === null && !(await lockAgentPaymentResumeAuthorityInTransaction(tx, input)))
  ) {
    throw new ElizaError("Payment resume execution lost its stop authority", {
      code: "PAYMENT_RESUME_EXECUTION_AUTHORITY_CHANGED",
      context: { jobId: input.jobId, agentId: input.agentId, intentId: input.intentId },
    });
  }
  if (phase === "cleanup") return;
  const now = await readPostLockDatabaseNow(tx);
  const funding = await agentBillingRepository.settlePaymentResumeFundingInTransaction(
    tx,
    input.agentId,
    input.organizationId,
    now,
  );
  if (funding !== "funded") {
    throw new ElizaError("Payment resume execution is not currently funded", {
      code: "PAYMENT_RESUME_EXECUTION_NOT_FUNDED",
      context: { jobId: input.jobId, agentId: input.agentId, reason: funding },
    });
  }
  if (grant.startedAt === null) {
    await tx
      .update(agentComputeStopIntents)
      .set({ resume_started_at: now, updated_at: now })
      .where(
        and(
          eq(agentComputeStopIntents.id, input.intentId),
          eq(agentComputeStopIntents.resume_job_id, input.jobId),
        ),
      );
  }
}

/** Locks the exact owned agent and verifies the live lease before provider admission or teardown. */
export async function lockPaymentResumeProviderAuthorityInTransaction(
  tx: DbTransaction,
  input: AgentPaymentResumeExecutionAuthority,
  purpose: "provider" | "cleanup",
) {
  await configureElizaLifecycleTransaction(tx);
  await tx.execute(elizaProvisionAdvisoryLockSql(input.organizationId, input.agentId));
  const [agent] = await tx
    .select()
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.id, input.agentId),
        eq(agentSandboxes.organization_id, input.organizationId),
        eq(agentSandboxes.user_id, input.userId),
        eq(agentSandboxes.lifecycle_job_id, input.jobId),
        eq(agentSandboxes.lifecycle_execution_generation, input.executionGeneration),
      ),
    )
    .for("update")
    .limit(1);
  const [execution] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.id, input.jobId),
        eq(jobs.type, "agent_resume"),
        eq(jobs.status, "in_progress"),
        eq(jobs.agent_id, input.agentId),
        eq(jobs.organization_id, input.organizationId),
        eq(jobs.user_id, input.userId),
        eq(jobs.execution_generation, input.executionGeneration),
        isNull(jobs.execution_quiesced_at),
        sql`EXISTS (SELECT 1 FROM ${jobExecutionLeases}
      WHERE job_id = ${input.jobId} AND execution_generation = ${input.executionGeneration}
        AND owner_id = ${input.executionOwnerId} AND expires_at > clock_timestamp())`,
      ),
    )
    .limit(1);
  if (!agent || !execution) {
    throw new ElizaError("Payment resume no longer owns a live provider execution", {
      code: "PAYMENT_RESUME_PROVIDER_LEASE_LOST",
      context: { jobId: input.jobId, agentId: input.agentId },
    });
  }
  await assertPaymentResumeExecutionAuthorityInTransaction(tx, input, purpose);
  return agent;
}

/** Carry a stop job's existing receipt across its locked, bookkeeping-only claim. */
export async function carryConfirmedStopReceiptAcrossClaimInTransaction(
  tx: DbTransaction,
  input: {
    jobId: string;
    agentId: string;
    organizationId: string;
    previousRevision: string;
    claimedRevision: string;
  },
): Promise<void> {
  await tx
    .update(agentComputeStopIntents)
    .set({
      provider_confirmed_lifecycle_revision: sql`${input.claimedRevision}::bigint`,
    })
    .where(
      and(
        eq(agentComputeStopIntents.job_id, input.jobId),
        eq(agentComputeStopIntents.agent_id, input.agentId),
        eq(agentComputeStopIntents.organization_id, input.organizationId),
        eq(agentComputeStopIntents.status, "provider_confirmed"),
        sql`${agentComputeStopIntents.provider_confirmed_lifecycle_revision} = ${input.previousRevision}::bigint`,
        sql`EXISTS (SELECT 1 FROM ${agentSandboxes}
      WHERE id = ${input.agentId} AND organization_id = ${input.organizationId}
        AND lifecycle_job_id = ${input.jobId} AND status = 'stopped'
        AND lifecycle_revision = ${input.claimedRevision}::bigint)`,
      ),
    );
}

/** Release only the owned job binding while preserving its exact confirmed stop receipt. */
export async function releaseAgentLifecycleBindingInTransaction(
  tx: DbTransaction,
  input: {
    jobId: string;
    agentId: string;
    organizationId: string;
    executionGeneration: string;
    preserveConfirmedStop: boolean;
  },
): Promise<void> {
  if (!input.preserveConfirmedStop) {
    await tx
      .update(agentSandboxes)
      .set({ lifecycle_job_id: null, lifecycle_execution_generation: null })
      .where(
        and(
          eq(agentSandboxes.id, input.agentId),
          eq(agentSandboxes.organization_id, input.organizationId),
          eq(agentSandboxes.lifecycle_job_id, input.jobId),
          eq(agentSandboxes.lifecycle_execution_generation, input.executionGeneration),
        ),
      );
    return;
  }
  await tx.execute(sql`
    WITH prior AS MATERIALIZED (
      SELECT id, organization_id, lifecycle_revision
      FROM ${agentSandboxes}
      WHERE id = ${input.agentId} AND organization_id = ${input.organizationId}
        AND lifecycle_job_id = ${input.jobId}
        AND lifecycle_execution_generation = ${input.executionGeneration}
      FOR UPDATE
    ), released AS (
      UPDATE ${agentSandboxes} AS target
      SET lifecycle_job_id = NULL, lifecycle_execution_generation = NULL
      FROM prior
      WHERE target.id = prior.id AND target.organization_id = prior.organization_id
      RETURNING target.id, target.organization_id, target.status, target.lifecycle_revision,
        prior.lifecycle_revision AS previous_revision
    )
    UPDATE ${agentComputeStopIntents} AS intent
    SET provider_confirmed_lifecycle_revision = released.lifecycle_revision
    FROM released
    WHERE intent.agent_id = released.id AND intent.organization_id = released.organization_id
      AND intent.job_id = ${input.jobId} AND intent.status = 'provider_confirmed'
      AND released.status = 'stopped'
      AND intent.provider_confirmed_lifecycle_revision = released.previous_revision
  `);
}

/** Hold the existing lifecycle fence before checking a discovered receipt again. */
export async function lockAgentPaymentResumeAuthorityInTransaction(
  tx: DbTransaction,
  authority: AgentPaymentResumeAuthority,
): Promise<AgentPaymentResumeAuthority | undefined> {
  if (
    !/^(0|[1-9][0-9]*)$/.test(authority.lifecycleRevision) ||
    BigInt(authority.lifecycleRevision) > 9223372036854775807n
  ) {
    throw new ElizaError("Payment resume requires an exact PostgreSQL lifecycle revision", {
      code: "INVALID_PAYMENT_RESUME_REVISION",
      context: { agentId: authority.agentId },
    });
  }
  await configureElizaLifecycleTransaction(tx);
  await tx.execute(elizaProvisionAdvisoryLockSql(authority.organizationId, authority.agentId));
  await tx
    .select({ id: agentSandboxes.id })
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.id, authority.agentId),
        eq(agentSandboxes.organization_id, authority.organizationId),
      ),
    )
    .for("update");
  const [candidate] = await paymentResumeCandidateQuery(
    tx,
    and(
      eq(agentComputeStopIntents.id, authority.intentId),
      eq(agentSandboxes.id, authority.agentId),
      eq(agentSandboxes.organization_id, authority.organizationId),
      eq(agentSandboxes.user_id, authority.userId),
      sql`${agentComputeStopIntents.provider_confirmed_lifecycle_revision} = ${authority.lifecycleRevision}::bigint`,
    ),
  ).limit(1);
  return candidate;
}

export async function confirmAgentComputeStopInTransaction(
  tx: DbTransaction,
  input: {
    intentId: string;
    agentId: string;
    organizationId: string;
    confirmedAt: Date;
    retainedBackupRatePerHour: string | null;
  },
): Promise<void> {
  const stoppedGeneration = sql`(SELECT lifecycle_revision FROM ${agentSandboxes}
    WHERE id = ${input.agentId} AND organization_id = ${input.organizationId}
      AND status = 'stopped')`;
  const [receipt] = await tx
    .update(agentComputeStopIntents)
    .set({
      status: "provider_confirmed",
      provider_confirmed_at: input.confirmedAt,
      provider_confirmed_lifecycle_revision: stoppedGeneration,
      retained_backup_billing: input.retainedBackupRatePerHour !== null,
      retained_backup_rate_per_hour: input.retainedBackupRatePerHour,
      updated_at: input.confirmedAt,
    })
    .where(
      and(
        eq(agentComputeStopIntents.id, input.intentId),
        eq(agentComputeStopIntents.agent_id, input.agentId),
        eq(agentComputeStopIntents.organization_id, input.organizationId),
        inArray(agentComputeStopIntents.status, [
          "pending",
          "dispatching",
          "retry",
          "terminal_attention",
        ]),
        sql`${stoppedGeneration} IS NOT NULL`,
      ),
    )
    .returning({ id: agentComputeStopIntents.id });
  if (!receipt) {
    throw new ElizaError("Agent stop confirmation lost its stopped lifecycle authority", {
      code: "AGENT_STOP_CONFIRMATION_CONFLICT",
      context: {
        intentId: input.intentId,
        agentId: input.agentId,
        organizationId: input.organizationId,
      },
    });
  }
}
