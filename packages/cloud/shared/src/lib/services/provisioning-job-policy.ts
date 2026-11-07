import { and, eq, getTableColumns, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { dbWrite } from "../../db/helpers";
import { type Job, prepareJobInsertData } from "../../db/repositories/jobs";
import { agentComputeStopIntents } from "../../db/schemas/agent-compute-stop-intents";
import {
  type AgentBillingStatus,
  type AgentExecutionTier,
  type AgentSandboxPoolStatus,
  type AgentSandboxStatus,
  agentSandboxes,
  CONTAINER_BACKED_EXECUTION_TIERS,
} from "../../db/schemas/agent-sandboxes";
import { billingCancelCommands } from "../../db/schemas/billing-cancel-commands";
import { jobExecutionLeases } from "../../db/schemas/job-execution-leases";
import { jobs } from "../../db/schemas/jobs";
import {
  type AdminCanaryImageJobData,
  assertAdminCanaryImageJobData,
  isAdminCanaryImageJobData,
} from "./admin-canary-image";
import {
  configureElizaLifecycleTransaction,
  elizaProvisionAdvisoryLockSql,
} from "./eliza-provision-lock";
import { isPersonalDedicatedReviewedBackupChain } from "./personal-dedicated-adoption-provenance";
import type {
  AgentDeleteJobData,
  AgentProvisionJobData,
  AgentSuspendJobData,
  AgentWakeJobData,
} from "./provisioning-job-types";
import { JOB_TYPES, type ProvisioningJobType } from "./provisioning-job-types";
import { isContainerBackedExecutionTier } from "./sandbox-provider-types";
export const CONTAINER_BACKED_TARGET_REQUIRED_MESSAGE =
  "Agent job requires a container-backed execution tier";

export const PRICED_AGENT_START_JOB_TYPES: readonly string[] = [
  JOB_TYPES.AGENT_PROVISION,
  JOB_TYPES.AGENT_RESUME,
  JOB_TYPES.AGENT_WAKE,
  JOB_TYPES.AGENT_RESTART,
];

export const CONTAINER_BACKED_TARGET_REJECTION_REASON = "agent_job_target_not_container_backed";

export type PersistedAgentSuspendJobData = Omit<AgentSuspendJobData, "authorization"> & {
  authorization?: AgentSuspendJobData["authorization"];
};

export function isAgentProvisionJobData(value: unknown): value is AgentProvisionJobData {
  const restoreDirective =
    typeof value === "object" && value !== null
      ? (value as { restoreDirective?: unknown }).restoreDirective
      : undefined;
  const validRestoreDirective =
    restoreDirective === undefined ||
    (typeof restoreDirective === "object" &&
      restoreDirective !== null &&
      (((restoreDirective as { kind?: unknown }).kind === "fresh-boot" &&
        !("backupId" in restoreDirective)) ||
        ((restoreDirective as { kind?: unknown }).kind === "reviewed-fresh-boot" &&
          typeof (restoreDirective as { selectionId?: unknown }).selectionId === "string") ||
        ((restoreDirective as { kind?: unknown }).kind === "from-backup" &&
          typeof (restoreDirective as { backupId?: unknown }).backupId === "string") ||
        ((restoreDirective as { kind?: unknown }).kind === "from-reviewed-backup" &&
          typeof (restoreDirective as { selectionId?: unknown }).selectionId === "string" &&
          typeof (restoreDirective as { backupId?: unknown }).backupId === "string" &&
          typeof (restoreDirective as { expectedContentHash?: unknown }).expectedContentHash ===
            "string" &&
          /^[a-f0-9]{64}$/.test(
            (restoreDirective as { expectedContentHash: string }).expectedContentHash,
          ) &&
          isPersonalDedicatedReviewedBackupChain(
            (restoreDirective as { expectedBackupChain?: unknown }).expectedBackupChain,
          ))));
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { agentId?: unknown }).agentId === "string" &&
    typeof (value as { organizationId?: unknown }).organizationId === "string" &&
    typeof (value as { userId?: unknown }).userId === "string" &&
    typeof (value as { agentName?: unknown }).agentName === "string" &&
    validRestoreDirective
  );
}

export function isAgentDeleteJobData(value: unknown): value is AgentDeleteJobData {
  const authorization =
    typeof value === "object" && value !== null
      ? (value as { authorization?: unknown }).authorization
      : undefined;
  const stateLossAcknowledged =
    typeof value === "object" && value !== null
      ? (value as { stateLossAcknowledged?: unknown }).stateLossAcknowledged
      : undefined;
  const acknowledgedByUserId =
    typeof value === "object" && value !== null
      ? (value as { stateLossAcknowledgedByUserId?: unknown }).stateLossAcknowledgedByUserId
      : undefined;
  const acknowledgedAt =
    typeof value === "object" && value !== null
      ? (value as { stateLossAcknowledgedAt?: unknown }).stateLossAcknowledgedAt
      : undefined;
  const provenanceAbsent = acknowledgedByUserId === undefined && acknowledgedAt === undefined;
  const provenanceComplete =
    typeof acknowledgedByUserId === "string" &&
    acknowledgedByUserId.length > 0 &&
    typeof acknowledgedAt === "string" &&
    Number.isFinite(Date.parse(acknowledgedAt)) &&
    new Date(acknowledgedAt).toISOString() === acknowledgedAt;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { agentId?: unknown }).agentId === "string" &&
    typeof (value as { organizationId?: unknown }).organizationId === "string" &&
    typeof (value as { userId?: unknown }).userId === "string" &&
    (authorization === undefined ||
      authorization === "user_request" ||
      authorization === "billing_request") &&
    (stateLossAcknowledged === undefined || typeof stateLossAcknowledged === "boolean") &&
    (stateLossAcknowledged === true ? provenanceAbsent || provenanceComplete : provenanceAbsent)
  );
}

export function readAgentProvisionJobData(job: Job): AgentProvisionJobData {
  if (!isAgentProvisionJobData(job.data)) {
    throw new Error(`Invalid agent provision job data for job ${job.id}`);
  }
  return job.data;
}

export function readAgentDeleteJobData(job: Job): AgentDeleteJobData {
  if (!isAgentDeleteJobData(job.data)) {
    throw new Error(`Invalid agent delete job data for job ${job.id}`);
  }
  return job.data;
}

export function isAgentSuspendJobData(value: unknown): value is PersistedAgentSuspendJobData {
  const authorization = (value as { authorization?: unknown } | null)?.authorization;
  const lifecycleRevision = (value as { lifecycleRevision?: unknown } | null)?.lifecycleRevision;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { agentId?: unknown }).agentId === "string" &&
    typeof (value as { organizationId?: unknown }).organizationId === "string" &&
    typeof (value as { userId?: unknown }).userId === "string" &&
    (authorization === undefined ||
      authorization === "user_request" ||
      authorization === "billing_request") &&
    (lifecycleRevision === undefined ||
      (typeof lifecycleRevision === "number" &&
        Number.isSafeInteger(lifecycleRevision) &&
        lifecycleRevision >= 0))
  );
}

export function readAgentSuspendJobData(job: Job): PersistedAgentSuspendJobData {
  if (!isAgentSuspendJobData(job.data)) {
    throw new Error(`Invalid agent suspend job data for job ${job.id}`);
  }
  return job.data;
}

export function isAgentWakeJobData(value: unknown): value is AgentWakeJobData {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { agentId?: unknown }).agentId !== "string" ||
    typeof (value as { organizationId?: unknown }).organizationId !== "string" ||
    typeof (value as { userId?: unknown }).userId !== "string"
  ) {
    return false;
  }
  const { restoreBackupId, forceFreshBoot } = value as {
    restoreBackupId?: unknown;
    forceFreshBoot?: unknown;
  };
  return (
    (restoreBackupId === undefined || typeof restoreBackupId === "string") &&
    (forceFreshBoot === undefined || typeof forceFreshBoot === "boolean")
  );
}

export function readAgentWakeJobData(job: Job): AgentWakeJobData {
  if (!isAgentWakeJobData(job.data)) {
    throw new Error(`Invalid agent wake job data for job ${job.id}`);
  }
  return job.data;
}

export function readAdminCanaryImageJobData(job: Job): AdminCanaryImageJobData {
  if (!isAdminCanaryImageJobData(job.data)) {
    throw new Error(`Invalid admin canary image job data for job ${job.id}`);
  }
  assertAdminCanaryImageJobData(job.data);
  return job.data;
}

export interface EnqueueAgentProvisionResult {
  job: Job;
  created: boolean;
}

export interface EnqueueAgentDeleteResult {
  job: Job;
  created: boolean;
}

export interface EnqueueAgentSuspendResult {
  job: Job;
  created: boolean;
}

export interface EnqueueAgentResumeResult {
  job: Job;
  created: boolean;
}

export interface EnqueueAgentSleepResult {
  job: Job;
  created: boolean;
}

export interface EnqueueAgentWakeResult {
  job: Job;
  created: boolean;
  /**
   * The restore params the in-flight job will ACTUALLY apply — the existing
   * job's own data when an active wake was reused, never the caller's request.
   * The wake route echoes these so a reused enqueue cannot misreport a
   * restoreBackupId/forceFreshBoot that was silently not applied (#15603 B6).
   */
  appliedRestoreBackupId: string | null;
  appliedForceFreshBoot: boolean;
}

export interface EnqueueAgentRestartResult {
  job: Job;
  created: boolean;
}

export interface EnqueueAgentDowngradeResult {
  job: Job;
  created: boolean;
}

export interface EnqueueAgentLogsResult {
  job: Job;
  created: boolean;
}

export interface EnqueueAgentSnapshotResult {
  job: Job;
  created: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LifecycleSandboxRow {
  id: string;
  agent_name: string | null;
  created_at: Date;
  execution_tier: AgentExecutionTier;
  status: AgentSandboxStatus;
  updated_at: Date | null;
  claimed_at: Date | null;
  warm_claim_credential_state: "pending" | "attested" | "ready" | "failed" | null;
  warm_claim_attested_at: Date | null;
  warm_claim_source_pool_id: string | null;
  warm_claim_key_fingerprint: string | null;
  warm_claim_attested_environment_revision: number | null;
  environment_revision: number;
  lifecycle_revision: number;
  user_id: string;
  sandbox_id: string | null;
  node_id: string | null;
  container_name: string | null;
  docker_image: string | null;
  image_digest: string | null;
  previous_docker_image: string | null;
  previous_image_digest: string | null;
  replacement_cleanup_sandbox_id: string | null;
  deletion_attempt_id: string | null;
  deletion_started_at: Date | null;
  deleted_at: Date | null;
  billing_status: AgentBillingStatus;
  shutdown_warning_sent_at: Date | null;
  scheduled_shutdown_at: Date | null;
  pool_status: AgentSandboxPoolStatus | null;
}

export function snapshotAuthorityRejection(
  sandbox: Pick<LifecycleSandboxRow, "pool_status" | "deleted_at" | "deletion_attempt_id">,
): string | undefined {
  if (sandbox.pool_status !== null) {
    return "Agent snapshot cannot target pool-owned capacity";
  }
  if (sandbox.deleted_at !== null) {
    return "Agent snapshot cannot target a deleted agent";
  }
  if (sandbox.deletion_attempt_id !== null) {
    return "Agent snapshot cannot start while agent deletion is in progress";
  }
  return undefined;
}

/**
 * Health-check budget a container lifecycle job may legitimately spend
 * waiting for `/api/health`. Mirrors docker-sandbox-provider's
 * `HEALTH_CHECK_TIMEOUT_MS` (360s) WITHOUT importing it — that module drags
 * node-only deps (ssh2) into the Worker bundle. A guarding test
 * (`provision-duration-estimate.test.ts`) asserts the two stay equal.
 */
export const CONTAINER_HEALTH_CHECK_BUDGET_MS = 360_000;

/**
 * User-facing duration estimate for container lifecycle jobs (provision /
 * restart / restore / fresh-boot). The old flat 90s estimate assumed a 60s
 * health check against the real 360s budget, so users were told a healthy
 * in-budget job was "still in progress after 362s" (#22548). Estimate the
 * real worst case: DB assignment + docker pull/run (~30s) + full health
 * budget.
 */
export const CONTAINER_LIFECYCLE_ESTIMATED_DURATION_MS = 30_000 + CONTAINER_HEALTH_CHECK_BUDGET_MS;

export const ADMIN_CANARY_CONFLICTING_JOB_TYPES: ProvisioningJobType[] = [
  JOB_TYPES.AGENT_PROVISION,
  JOB_TYPES.AGENT_DELETE,
  JOB_TYPES.AGENT_SUSPEND,
  JOB_TYPES.AGENT_RESUME,
  JOB_TYPES.AGENT_RESTART,
  JOB_TYPES.AGENT_DOWNGRADE,
  JOB_TYPES.AGENT_SLEEP,
  JOB_TYPES.AGENT_WAKE,
];

export const SHARED_IMAGE_CHANGE_JOB_TYPES: ProvisioningJobType[] = [
  JOB_TYPES.AGENT_UPGRADE,
  JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
];

/**
 * Acquire the lifecycle target before an explicit billing cancellation takes
 * organization/user authority locks. Validation and durable intent/job writes
 * stay in enqueueAgentSuspendOnceInTransaction; its repeated advisory and row
 * locks are transaction-reentrant.
 */
export async function lockAgentSuspendTargetInTx(
  tx: DbTransaction,
  p: { agentId: string; organizationId: string },
): Promise<void> {
  await configureElizaLifecycleTransaction(tx);
  await tx.execute(elizaProvisionAdvisoryLockSql(p.organizationId, p.agentId));
  await tx
    .select({ id: agentSandboxes.id })
    .from(agentSandboxes)
    .where(
      and(eq(agentSandboxes.id, p.agentId), eq(agentSandboxes.organization_id, p.organizationId)),
    )
    .for("update")
    .limit(1);
}

/** Find due agent-stop intents whose exact bound worker job is absent or terminal. */
export async function listRecoverableAgentComputeStopIntents(now: Date, limit = 100) {
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];
  type RecoveryCursor = { nextAttemptAtText: string; id: string };
  const recoverable: Array<typeof agentComputeStopIntents.$inferSelect> = [];
  const pageSize = Math.max(100, Math.min(limit, 500));
  let cursor: RecoveryCursor | null = null;

  while (recoverable.length < limit) {
    const candidates = await dbWrite
      .select({
        intent: { ...getTableColumns(agentComputeStopIntents) },
        cursorNextAttemptAtText: sql<string>`${agentComputeStopIntents.next_attempt_at}::text`,
        sandbox: {
          userId: agentSandboxes.user_id,
          status: agentSandboxes.status,
          billingStatus: agentSandboxes.billing_status,
          scheduledShutdownAt: agentSandboxes.scheduled_shutdown_at,
          executionTier: agentSandboxes.execution_tier,
          poolStatus: agentSandboxes.pool_status,
          deletionAttemptId: agentSandboxes.deletion_attempt_id,
          deletedAt: agentSandboxes.deleted_at,
          replacementCleanupSandboxId: agentSandboxes.replacement_cleanup_sandbox_id,
        },
        boundJob: {
          id: jobs.id,
          type: jobs.type,
          status: jobs.status,
          organizationId: jobs.organization_id,
          agentId: jobs.agent_id,
          userId: jobs.user_id,
          dataStorage: jobs.data_storage,
          dataKey: jobs.data_key,
          data: jobs.data,
        },
      })
      .from(agentComputeStopIntents)
      .innerJoin(
        agentSandboxes,
        and(
          eq(agentSandboxes.id, agentComputeStopIntents.agent_id),
          eq(agentSandboxes.organization_id, agentComputeStopIntents.organization_id),
          eq(agentSandboxes.lifecycle_revision, agentComputeStopIntents.lifecycle_revision),
        ),
      )
      .leftJoin(jobs, eq(jobs.id, agentComputeStopIntents.job_id))
      .where(
        and(
          inArray(agentComputeStopIntents.status, ["pending", "retry", "terminal_attention"]),
          lte(agentComputeStopIntents.next_attempt_at, now),
          cursor
            ? sql`(${agentComputeStopIntents.next_attempt_at}, ${agentComputeStopIntents.id}) >
              (${cursor.nextAttemptAtText}::timestamptz, ${cursor.id}::uuid)`
            : undefined,
          eq(agentSandboxes.status, "running"),
          isNull(agentSandboxes.pool_status),
          isNull(agentSandboxes.deletion_attempt_id),
          isNull(agentSandboxes.deleted_at),
          isNull(agentSandboxes.replacement_cleanup_sandbox_id),
          inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
          or(
            eq(agentComputeStopIntents.authorization, "user_request"),
            and(
              eq(agentComputeStopIntents.authorization, "billing_request"),
              eq(agentSandboxes.billing_status, "shutdown_pending"),
              isNotNull(agentSandboxes.scheduled_shutdown_at),
              lte(agentSandboxes.scheduled_shutdown_at, now),
            ),
          ),
          or(
            isNull(agentComputeStopIntents.job_id),
            isNull(jobs.id),
            and(
              eq(jobs.status, "failed"),
              eq(jobs.type, JOB_TYPES.AGENT_SUSPEND),
              eq(jobs.organization_id, agentComputeStopIntents.organization_id),
              eq(jobs.data_storage, "inline"),
              isNull(jobs.data_key),
            ),
          ),
        ),
      )
      .orderBy(agentComputeStopIntents.next_attempt_at, agentComputeStopIntents.id)
      .limit(pageSize);

    if (candidates.length === 0) break;
    for (const { intent, sandbox, boundJob } of candidates) {
      let safelyRearmable = !boundJob?.id;
      if (boundJob?.id) {
        try {
          const data = readAgentSuspendJobData({ id: boundJob.id, data: boundJob.data } as Job);
          safelyRearmable =
            boundJob.type === JOB_TYPES.AGENT_SUSPEND &&
            boundJob.status === "failed" &&
            boundJob.organizationId === intent.organization_id &&
            boundJob.userId === sandbox.userId &&
            data.agentId === intent.agent_id &&
            data.organizationId === intent.organization_id &&
            data.userId === sandbox.userId &&
            (data.lifecycleRevision === undefined ||
              data.lifecycleRevision === intent.lifecycle_revision) &&
            data.authorization !== undefined &&
            !(
              intent.authorization === "billing_request" && data.authorization !== "billing_request"
            );
        } catch {
          // error-policy:J3 untrusted-input sanitizing — malformed persisted jobs
          // are excluded from autonomous recovery instead of being treated as valid.
          safelyRearmable = false;
        }
      }
      if (safelyRearmable) recoverable.push(intent);
      if (recoverable.length >= limit) break;
    }
    const last = candidates.at(-1);
    if (!last || candidates.length < pageSize) break;
    cursor = { nextAttemptAtText: last.cursorNextAttemptAtText, id: last.intent.id };
  }
  return recoverable;
}

/** Rearm one exact failed AGENT_SUSPEND job under the canonical lifecycle lock. */
export async function rearmRecoverableAgentComputeStopIntentOnce(p: {
  intentId: string;
  agentId: string;
  organizationId: string;
  lifecycleRevision: number;
  now: Date;
}): Promise<{ id: string; rearmed: boolean }> {
  return await dbWrite.transaction(async (tx) => {
    await configureElizaLifecycleTransaction(tx);
    await tx.execute(elizaProvisionAdvisoryLockSql(p.organizationId, p.agentId));
    const [sandbox] = await tx
      .select({
        userId: agentSandboxes.user_id,
        status: agentSandboxes.status,
        billingStatus: agentSandboxes.billing_status,
        scheduledShutdownAt: agentSandboxes.scheduled_shutdown_at,
        lifecycleRevision: agentSandboxes.lifecycle_revision,
        executionTier: agentSandboxes.execution_tier,
        poolStatus: agentSandboxes.pool_status,
        deletionAttemptId: agentSandboxes.deletion_attempt_id,
        deletedAt: agentSandboxes.deleted_at,
        replacementCleanupSandboxId: agentSandboxes.replacement_cleanup_sandbox_id,
      })
      .from(agentSandboxes)
      .where(
        and(eq(agentSandboxes.id, p.agentId), eq(agentSandboxes.organization_id, p.organizationId)),
      )
      .for("update")
      .limit(1);
    if (
      !sandbox ||
      sandbox.userId === null ||
      sandbox.status !== "running" ||
      sandbox.lifecycleRevision !== p.lifecycleRevision ||
      !isContainerBackedExecutionTier(sandbox.executionTier) ||
      sandbox.poolStatus !== null ||
      sandbox.deletionAttemptId !== null ||
      sandbox.deletedAt !== null ||
      sandbox.replacementCleanupSandboxId !== null
    ) {
      throw new Error("Recoverable agent stop intent lost its live lifecycle fence");
    }

    const [intent] = await tx
      .select()
      .from(agentComputeStopIntents)
      .where(
        and(
          eq(agentComputeStopIntents.id, p.intentId),
          eq(agentComputeStopIntents.organization_id, p.organizationId),
          eq(agentComputeStopIntents.agent_id, p.agentId),
          eq(agentComputeStopIntents.lifecycle_revision, p.lifecycleRevision),
          inArray(agentComputeStopIntents.status, ["pending", "retry", "terminal_attention"]),
          lte(agentComputeStopIntents.next_attempt_at, p.now),
        ),
      )
      .for("update")
      .limit(1);
    if (!intent) throw new Error("Agent stop intent is no longer due for recovery");
    if (
      intent.authorization === "billing_request" &&
      (sandbox.billingStatus !== "shutdown_pending" ||
        !sandbox.scheduledShutdownAt ||
        sandbox.scheduledShutdownAt > p.now)
    ) {
      throw new Error("Billing agent stop recovery lost its shutdown authority");
    }

    const [boundJob] = intent.job_id
      ? await tx.select().from(jobs).where(eq(jobs.id, intent.job_id)).for("update").limit(1)
      : [undefined];
    let jobId: string;
    if (boundJob) {
      const data = readAgentSuspendJobData(boundJob);
      if (
        boundJob.status !== "failed" ||
        boundJob.type !== JOB_TYPES.AGENT_SUSPEND ||
        boundJob.organization_id !== p.organizationId ||
        boundJob.user_id !== sandbox.userId ||
        boundJob.data_storage !== "inline" ||
        boundJob.data_key !== null ||
        data.agentId !== p.agentId ||
        data.organizationId !== p.organizationId ||
        data.userId !== sandbox.userId ||
        (data.lifecycleRevision !== undefined && data.lifecycleRevision !== p.lifecycleRevision) ||
        data.authorization === undefined ||
        (intent.authorization === "billing_request" && data.authorization !== "billing_request")
      ) {
        throw new Error("Failed agent stop job does not match its durable intent");
      }
      await tx.delete(jobExecutionLeases).where(eq(jobExecutionLeases.job_id, boundJob.id));
      const [rearmed] = await tx
        .update(jobs)
        .set({
          status: "pending",
          attempts: 0,
          execution_interruptions: 0,
          retryable_requeues: 0,
          estimated_completion_at: new Date(p.now.getTime() + 30_000),
          scheduled_for: p.now,
          started_at: null,
          execution_generation: null,
          execution_quiesced_at: null,
          completed_at: null,
          updated_at: p.now,
        })
        .where(and(eq(jobs.id, boundJob.id), eq(jobs.status, "failed")))
        .returning({ id: jobs.id });
      if (!rearmed) throw new Error("Failed agent stop job lost its rearm fence");
      jobId = rearmed.id;
    } else {
      const [command] = await tx
        .select({ id: billingCancelCommands.id })
        .from(billingCancelCommands)
        .where(
          and(
            eq(billingCancelCommands.organization_id, p.organizationId),
            eq(billingCancelCommands.resource_type, "agent_sandbox"),
            eq(billingCancelCommands.resource_id, p.agentId),
            eq(billingCancelCommands.expected_lifecycle_revision, p.lifecycleRevision),
          ),
        )
        .limit(1);
      if (command) {
        throw new Error("Immutable billing cancellation command lost its agent stop job");
      }
      const [created] = await tx
        .insert(jobs)
        .values(
          await prepareJobInsertData({
            type: JOB_TYPES.AGENT_SUSPEND,
            status: "pending",
            data: {
              agentId: p.agentId,
              organizationId: p.organizationId,
              userId: sandbox.userId,
              authorization: intent.authorization,
              lifecycleRevision: p.lifecycleRevision,
            },
            data_storage: "inline",
            agent_id: p.agentId,
            organization_id: p.organizationId,
            user_id: sandbox.userId,
            max_attempts: 3,
            estimated_completion_at: new Date(p.now.getTime() + 30_000),
            scheduled_for: p.now,
          }),
        )
        .returning({ id: jobs.id });
      if (!created) throw new Error("Agent stop recovery job insert returned no row");
      jobId = created.id;
    }

    await tx
      .update(agentComputeStopIntents)
      .set(
        intent.provider_confirmed_at
          ? { status: "retry", job_id: jobId, next_attempt_at: p.now, updated_at: p.now }
          : {
              status: "pending",
              job_id: jobId,
              attempts: 0,
              last_error: null,
              provider_started_at: null,
              next_attempt_at: p.now,
              updated_at: p.now,
            },
      )
      .where(eq(agentComputeStopIntents.id, intent.id));
    return { id: jobId, rearmed: true };
  });
}

/** Copy validated typed commands/results into the repository JSON record shape. */
export function jobRecord<T extends object>(value: T): Record<string, unknown> {
  return { ...value } as Record<string, unknown>;
}
