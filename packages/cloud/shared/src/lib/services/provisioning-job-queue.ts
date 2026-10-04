/** Worker-facing durable job admission and polling; never dispatches provider effects. */
import { getDedicatedComputePriceAcceptance } from "@elizaos/cloud-sdk/browser-contracts";
import { ElizaError } from "@elizaos/core";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { ensureAgentSandboxSchema } from "../../db/ensure-agent-sandbox-schema";
import { dbWrite } from "../../db/helpers";
import {
  type BillingResumeCandidate,
  billingResumeStillAuthorizedInTransaction,
  listBillingResumeCandidates,
} from "../../db/repositories/agent-billing-resume";
import {
  hydrateJob,
  type Job,
  jobsRepository,
  type NewJob,
  prepareJobInsertData,
} from "../../db/repositories/jobs";
import { agentComputeStopIntents } from "../../db/schemas/agent-compute-stop-intents";
import {
  type AgentExecutionTier,
  agentSandboxes,
  WARM_POOL_ORG_ID,
} from "../../db/schemas/agent-sandboxes";
import { jobs } from "../../db/schemas/jobs";
import { ApiError } from "../api/cloud-worker-errors";
import { assertSafeOutboundUrl } from "../security/outbound-url";
import { logger } from "../utils/logger";
import {
  ADMIN_CANARY_MAX_TARGETS,
  type AdminCanaryImageJobData,
  type AdminCanaryPlannedTarget,
  assertAdminCanaryImageJobData,
  assertRecoverableAdminCanaryImageJobData,
} from "./admin-canary-image";
import { checkAgentCreditGate } from "./agent-billing-gate";
import { holdsCountedNodeSlot, isDeletionContinuation } from "./docker-node-workload-queries";
import {
  configureElizaLifecycleTransaction,
  elizaAdminCanaryRolloutAdvisoryLockSql,
  elizaProvisionAdvisoryLockSql,
} from "./eliza-provision-lock";
import { SNAPSHOT_ENDPOINT_UNSUPPORTED } from "./eliza-sandbox/backup/contracts";
import type { DeleteAuthorization } from "./eliza-sandbox/lifecycle/deletion-contracts";
import { jobErrorText } from "./job-error-text";
import {
  ADMIN_CANARY_CONFLICTING_JOB_TYPES,
  CONTAINER_BACKED_TARGET_REJECTION_REASON,
  CONTAINER_BACKED_TARGET_REQUIRED_MESSAGE,
  CONTAINER_LIFECYCLE_ESTIMATED_DURATION_MS,
  type EnqueueAgentDeleteResult,
  type EnqueueAgentDowngradeResult,
  type EnqueueAgentLogsResult,
  type EnqueueAgentProvisionResult,
  type EnqueueAgentRestartResult,
  type EnqueueAgentResumeResult,
  type EnqueueAgentSleepResult,
  type EnqueueAgentSnapshotResult,
  type EnqueueAgentSuspendResult,
  type EnqueueAgentWakeResult,
  jobRecord,
  type LifecycleSandboxRow,
  PRICED_AGENT_START_JOB_TYPES,
  readAdminCanaryImageJobData,
  readAgentDeleteJobData,
  readAgentProvisionJobData,
  readAgentWakeJobData,
  SHARED_IMAGE_CHANGE_JOB_TYPES,
  snapshotAuthorityRejection,
} from "./provisioning-job-policy";
import type {
  AgentDeleteJobData,
  AgentDowngradeJobData,
  AgentLogsJobData,
  AgentMessageJobData,
  AgentProvisionJobData,
  AgentRestartJobData,
  AgentResumeJobData,
  AgentSleepJobData,
  AgentSnapshotJobData,
  AgentSuspendJobData,
  AgentUpgradeJobData,
  AgentWakeJobData,
  ScheduledBackupFleetReport,
} from "./provisioning-job-types";
import {
  EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES,
  JOB_TYPES,
  type ProvisioningJobType,
  requiresContainerBackedTarget,
} from "./provisioning-job-types";
import { sendProvisioningWorkerAlert } from "./provisioning-worker-health-monitor";
import { isContainerBackedExecutionTier } from "./sandbox-provider-types";
import { hasReadyWarmClaimCredential } from "./warm-claim-key-push";

export type {
  AgentDeleteJobData,
  AgentDeleteJobResult,
  AgentDowngradeJobData,
  AgentDowngradeJobResult,
  AgentLogsJobData,
  AgentLogsJobResult,
  AgentMessageJobData,
  AgentMessageJobResult,
  AgentProvisionJobData,
  AgentProvisionJobResult,
  AgentRestartJobData,
  AgentRestartJobResult,
  AgentResumeJobData,
  AgentResumeJobResult,
  AgentSleepJobData,
  AgentSleepJobResult,
  AgentSnapshotJobData,
  AgentSnapshotJobResult,
  AgentSuspendJobData,
  AgentSuspendJobResult,
  AgentUpgradeJobData,
  AgentUpgradeJobResult,
  AgentWakeJobData,
  AgentWakeJobResult,
  HeartbeatResult,
  ProcessingResult,
  RecoveryResult,
  ScheduledBackupFleetReport,
} from "./provisioning-job-types";

const EMPTY_SCHEDULED_BACKUP_FLEET_REPORT: ScheduledBackupFleetReport = {
  running: 0,
  routeless: 0,
  snapshotUnsupported: 0,
  neverBackedUp: 0,
  staleBackup: 0,
  localState: 0,
  localStateStale: 0,
};

function sameProvisionRestoreDirective(
  left: AgentProvisionJobData["restoreDirective"],
  right: AgentProvisionJobData["restoreDirective"],
): boolean {
  if (left?.kind !== right?.kind) return false;
  if (left?.kind === "from-backup" && right?.kind === "from-backup") {
    return left.backupId === right.backupId;
  }
  if (left?.kind === "from-reviewed-backup" && right?.kind === "from-reviewed-backup") {
    return (
      left.selectionId === right.selectionId &&
      left.backupId === right.backupId &&
      left.expectedContentHash === right.expectedContentHash &&
      JSON.stringify(left.expectedBackupChain) === JSON.stringify(right.expectedBackupChain)
    );
  }
  if (left?.kind === "reviewed-fresh-boot" && right?.kind === "reviewed-fresh-boot") {
    return left.selectionId === right.selectionId;
  }
  return true;
}

interface LifecycleJobOptions<TData extends object> {
  /** Wire value for `jobs.type` (one of JOB_TYPES.*). */
  jobType: ProvisioningJobType;
  /** Typed job data to persist into `jobs.data` JSONB. */
  jobData: TData;
  /** Serializer for `jobData` — usually a one-line `{ ...data }`. */
  toRecord: (data: TData) => Record<string, unknown>;
  agentId: string;
  organizationId: string;
  userId: string;
  webhookUrl?: string;
  /** How many times the daemon may retry on failure. */
  maxAttempts: number;
  /** Used to populate `estimated_completion_at` for UI hints. */
  estimatedDurationMs: number;
  /** Logged as `"agent_xxx"` in the structured log messages. */
  logName: string;
  /** Extra structured-log fields beyond the standard jobId/agentId/orgId. */
  logExtras?: Record<string, unknown>;
  /**
   * Extra predicates that make in-flight reuse match operation-specific
   * inputs, e.g. logs tail length or snapshot type.
   */
  idempotencyPredicates?: SQL[];
  /**
   * Other job types that mutate the same per-agent resource and therefore
   * cannot overlap this job. The lookup runs under the lifecycle advisory
   * lock, making exclusion symmetric regardless of enqueue order.
   */
  mutuallyExclusiveJobTypes?: readonly ProvisioningJobType[];
  /**
   * Called inside the transaction after the sandbox row is fetched and
   * before the existing-job lookup. Throw to abort the enqueue (e.g.
   * provision's lifecycle-revision race check).
   */
  validateSandbox?: (sandbox: LifecycleSandboxRow) => void;
  /**
   * Resolve a durable operation replay before validating the sandbox's
   * current generation. A completed request must remain replayable after its
   * own lifecycle mutation advances that generation.
   */
  resolveReplay?: (tx: DbTransaction, sandbox: LifecycleSandboxRow) => Promise<Job | undefined>;
  deleteAuthorization?: DeleteAuthorization;
  /**
   * Permit an exact conditional delete to own a row whose failed replacement
   * still has a durable cleanup locator. The daemon converges that locator
   * before deleting the serving generation; ordinary lifecycle jobs remain
   * blocked by the unresolved fence.
   */
  allowReplacementCleanup?: boolean;
  /**
   * Called with the hydrated existing job when an active pending/in_progress
   * job of the same type would be reused instead of inserting a new row.
   * Throw to refuse the enqueue — reuse silently DROPS the caller's job data,
   * so operation-changing params (wake's restoreBackupId/forceFreshBoot) must
   * either match the in-flight job or be rejected loudly (#15603 B6).
   */
  validateReuse?: (existing: Job) => void;
  /**
   * Monotonically strengthens durable authority on a reused in-flight job.
   * Runs under the same lifecycle transaction and advisory lock as lookup.
   */
  upgradeReuse?: (tx: DbTransaction, existing: Job) => Promise<Job>;
  /**
   * Called inside the transaction after the "no existing job" check
   * and before the new job is inserted. Used by delete to flip the
   * sandbox row to `deletion_pending` so the UI reflects intent and
   * concurrent mutations bail. Skipped if an existing job is reused.
   * Receives the just-read sandbox row so it can branch on the prior
   * status (e.g. delete resets the failure counter on a fresh, non-delete
   * enqueue but preserves it across recovery re-enqueues).
   */
  beforeInsert?: (
    tx: Parameters<Parameters<typeof dbWrite.transaction>[0]>[0],
    sandbox: LifecycleSandboxRow,
  ) => Promise<void>;
  /** Couples operation-specific durable authority to the inserted job row. */
  afterInsert?: (
    tx: Parameters<Parameters<typeof dbWrite.transaction>[0]>[0],
    sandbox: LifecycleSandboxRow,
    job: typeof jobs.$inferSelect,
  ) => Promise<void>;
}

/**
 * Unreachable loopback bridge that E2E preload historically stamped onto
 * fixture sandboxes (see issue #15737). The preload now seeds fixtures inert
 * (#15755), but the backup scanner still excludes this sentinel as
 * defense-in-depth: any row that reaches `running` with this address has no
 * live state endpoint, so snapshotting it can only `fetch failed` in a loop and
 * flood the failed-jobs log — the exact noise the reachability carve-out exists
 * to prevent.
 */
const UNREACHABLE_BRIDGE_SENTINEL = "http://127.0.0.1:65535";
export class ProvisioningJobQueue {
  /**
   * Common path for the seven `enqueueAgent*Once` methods. Acquires the
   * per-(org,agent) advisory lock, verifies the sandbox exists, runs an
   * optional caller-supplied validation, reuses any in-flight job of
   * the same type (idempotency), or inserts a fresh row.
   *
   * Each public method is now a thin wrapper that supplies the four
   * varying bits: job type, typed data shape, retry/timing budget, and
   * the log breadcrumb fields. Adding a new lifecycle job type is a
   * ~10-line addition instead of ~80.
   */
  protected async enqueueLifecycleJob<TData extends object>(
    opts: LifecycleJobOptions<TData>,
  ): Promise<{ job: Job; created: boolean }> {
    if (opts.webhookUrl) {
      await assertSafeOutboundUrl(opts.webhookUrl);
    }

    return await dbWrite.transaction(async (tx) => this.enqueueLifecycleJobInTx(tx, opts));
  }

  /**
   * Transaction-scoped body of {@link enqueueLifecycleJob} for callers that
   * must couple the enqueue to other writes in ONE transaction (the
   * tier-upgrade single-flight boundary creates the sandbox row and its
   * provision job atomically, #15943). Runs entirely on the caller's `tx`:
   * a sandbox row inserted earlier in the same transaction is visible to the
   * existence check, and a rollback discards the job together with it. The
   * caller must pass any `webhookUrl` through {@link assertSafeOutboundUrl}
   * BEFORE opening the transaction — URL validation resolves DNS and must not
   * run while the transaction (and its advisory locks) are held open.
   */
  protected async enqueueLifecycleJobInTx<TData extends object>(
    tx: DbTransaction,
    opts: LifecycleJobOptions<TData>,
  ): Promise<{ job: Job; created: boolean }> {
    const newJob: NewJob = {
      type: opts.jobType,
      status: "pending",
      data: opts.toRecord(opts.jobData),
      data_storage: "inline",
      organization_id: opts.organizationId,
      user_id: opts.userId,
      webhook_url: opts.webhookUrl,
      max_attempts: opts.maxAttempts,
      estimated_completion_at: new Date(Date.now() + opts.estimatedDurationMs),
    };

    await configureElizaLifecycleTransaction(tx);
    await tx.execute(elizaProvisionAdvisoryLockSql(opts.organizationId, opts.agentId));

    const [sandbox] = await tx
      .select({
        id: agentSandboxes.id,
        agent_name: agentSandboxes.agent_name,
        created_at: agentSandboxes.created_at,
        execution_tier: agentSandboxes.execution_tier,
        status: agentSandboxes.status,
        updated_at: agentSandboxes.updated_at,
        claimed_at: agentSandboxes.claimed_at,
        warm_claim_credential_state: agentSandboxes.warm_claim_credential_state,
        warm_claim_attested_at: agentSandboxes.warm_claim_attested_at,
        warm_claim_source_pool_id: agentSandboxes.warm_claim_source_pool_id,
        warm_claim_key_fingerprint: agentSandboxes.warm_claim_key_fingerprint,
        warm_claim_attested_environment_revision:
          agentSandboxes.warm_claim_attested_environment_revision,
        environment_revision: agentSandboxes.environment_revision,
        lifecycle_revision: agentSandboxes.lifecycle_revision,
        user_id: agentSandboxes.user_id,
        sandbox_id: agentSandboxes.sandbox_id,
        node_id: agentSandboxes.node_id,
        container_name: agentSandboxes.container_name,
        docker_image: agentSandboxes.docker_image,
        image_digest: agentSandboxes.image_digest,
        previous_docker_image: agentSandboxes.previous_docker_image,
        previous_image_digest: agentSandboxes.previous_image_digest,
        replacement_cleanup_sandbox_id: agentSandboxes.replacement_cleanup_sandbox_id,
        deletion_attempt_id: agentSandboxes.deletion_attempt_id,
        deletion_started_at: agentSandboxes.deletion_started_at,
        deleted_at: agentSandboxes.deleted_at,
        billing_status: agentSandboxes.billing_status,
        shutdown_warning_sent_at: agentSandboxes.shutdown_warning_sent_at,
        scheduled_shutdown_at: agentSandboxes.scheduled_shutdown_at,
        pool_status: agentSandboxes.pool_status,
      })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.id, opts.agentId),
          eq(agentSandboxes.organization_id, opts.organizationId),
        ),
      )
      .for("update")
      .limit(1);

    if (!sandbox) {
      // The exact message is load-bearing: several route boundaries map
      // `message === "Agent not found"` to a 404.
      throw new ElizaError("Agent not found", {
        code: "PROVISION_ENQUEUE_AGENT_NOT_FOUND",
        context: {
          agentId: opts.agentId,
          organizationId: opts.organizationId,
          jobType: opts.jobType,
        },
      });
    }

    if (
      requiresContainerBackedTarget(opts.jobType) &&
      !isContainerBackedExecutionTier(sandbox.execution_tier)
    ) {
      throw new ApiError(
        409,
        "session_not_ready",
        `${CONTAINER_BACKED_TARGET_REQUIRED_MESSAGE}: ${opts.jobType}`,
        {
          reason: CONTAINER_BACKED_TARGET_REJECTION_REASON,
          jobType: opts.jobType,
        },
      );
    }

    if (
      EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES.includes(opts.jobType) &&
      sandbox.replacement_cleanup_sandbox_id &&
      !opts.allowReplacementCleanup
    ) {
      throw new ApiError(
        409,
        "session_not_ready",
        `Agent ${opts.agentId} has unresolved replacement cleanup`,
      );
    }
    if (
      EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES.includes(opts.jobType) &&
      opts.jobType !== JOB_TYPES.AGENT_DELETE &&
      (sandbox.deletion_attempt_id ||
        sandbox.status === "deletion_pending" ||
        sandbox.status === "deletion_failed")
    ) {
      throw new ApiError(409, "session_not_ready", `Agent ${opts.agentId} deletion is in progress`);
    }

    const replay = await opts.resolveReplay?.(tx, sandbox);
    if (replay) {
      logger.info(`[provisioning-jobs] Replaying durable ${opts.logName} job`, {
        jobId: replay.id,
        agentId: opts.agentId,
        orgId: opts.organizationId,
        ...(opts.logExtras ?? {}),
      });
      return { job: await hydrateJob(replay), created: false };
    }

    opts.validateSandbox?.(sandbox);

    // Mirrors prepareAgentDelete's admission policy in eliza-sandbox.ts: an
    // unqualified delete of a running dedicated agent fails closed, while
    // shared-runtime rows and unclaimed warm-pool rows stay deletable by
    // cleanup paths. The row lookup above is scoped to opts.organizationId,
    // so that value is the row's organization_id.
    const isUnclaimedWarmPoolEntry =
      opts.organizationId === WARM_POOL_ORG_ID && sandbox.pool_status === "unclaimed";
    if (
      opts.jobType === JOB_TYPES.AGENT_DELETE &&
      sandbox.status === "running" &&
      sandbox.execution_tier !== "shared" &&
      !isUnclaimedWarmPoolEntry &&
      !opts.deleteAuthorization
    ) {
      throw new ApiError(409, "session_not_ready", "Agent is running; suspend it before deletion");
    }

    const configuredConflicts = opts.mutuallyExclusiveJobTypes ?? [];
    const symmetricConflicts =
      opts.jobType !== JOB_TYPES.AGENT_DELETE &&
      EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES.includes(opts.jobType)
        ? EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES
        : [];
    const conflictingTypes = [...new Set([...configuredConflicts, ...symmetricConflicts])].filter(
      (jobType) => jobType !== opts.jobType,
    );
    if (conflictingTypes && conflictingTypes.length > 0) {
      const [conflict] = await tx
        .select({ id: jobs.id, type: jobs.type, status: jobs.status })
        .from(jobs)
        .where(
          and(
            eq(jobs.organization_id, opts.organizationId),
            eq(jobs.agent_id, opts.agentId),
            inArray(jobs.type, [...conflictingTypes]),
            sql`${jobs.status} IN ('pending', 'in_progress')`,
          ),
        )
        .orderBy(desc(jobs.created_at))
        .limit(1);
      if (conflict) {
        throw new ApiError(
          409,
          "session_not_ready",
          `Agent ${opts.agentId} has conflicting ${conflict.type} job ${conflict.id}`,
          {
            conflictingJobId: conflict.id,
            conflictingJobType: conflict.type,
            conflictingJobStatus: conflict.status,
          },
        );
      }
    }

    const [existing] = await tx
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.type, opts.jobType),
          eq(jobs.organization_id, opts.organizationId),
          eq(jobs.agent_id, opts.agentId),
          ...(opts.idempotencyPredicates ?? []),
          sql`${jobs.status} IN ('pending', 'in_progress')`,
        ),
      )
      .orderBy(desc(jobs.created_at))
      .limit(1);

    const logFields = {
      agentId: opts.agentId,
      orgId: opts.organizationId,
      ...(opts.logExtras ?? {}),
    };

    if (existing) {
      const hydrated = await hydrateJob(existing);
      opts.validateReuse?.(hydrated);
      const reused = opts.upgradeReuse ? await opts.upgradeReuse(tx, hydrated) : hydrated;
      logger.info(`[provisioning-jobs] Reusing active ${opts.logName} job`, {
        jobId: existing.id,
        ...logFields,
      });
      return { job: reused, created: false };
    }

    await opts.beforeInsert?.(tx, sandbox);

    // Persist admission-time terms only on new jobs. Reuse and recovery must
    // retain their original terms, never manufacture acceptance of a new price.
    if (PRICED_AGENT_START_JOB_TYPES.includes(opts.jobType)) {
      newJob.data = {
        ...newJob.data,
        admittedComputePrice: getDedicatedComputePriceAcceptance(),
      };
    }

    const [job] = await tx
      .insert(jobs)
      .values(await prepareJobInsertData(newJob))
      .returning();

    await opts.afterInsert?.(tx, sandbox, job);

    logger.info(`[provisioning-jobs] Enqueued ${opts.logName} job`, {
      jobId: job.id,
      ...logFields,
    });

    return { job: await hydrateJob(job), created: true };
  }

  /**
   * Enqueue an Agent sandbox provisioning job.
   * Returns the job record immediately (status=pending).
   */
  async enqueueAgentProvision(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    agentName: string;
    webhookUrl?: string;
  }): Promise<Job> {
    const result = await this.enqueueAgentProvisionOnce(params);
    return result.job;
  }

  async enqueueAgentProvisionOnce(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    agentName: string;
    webhookUrl?: string;
    expectedLifecycleRevision?: number;
    restoreDirective?: AgentProvisionJobData["restoreDirective"];
  }): Promise<EnqueueAgentProvisionResult> {
    return this.enqueueLifecycleJob<AgentProvisionJobData>(
      this.agentProvisionLifecycleOptions(params),
    );
  }

  /**
   * Transaction-scoped variant of {@link enqueueAgentProvisionOnce} for
   * callers that must make the provision job durable ATOMICALLY with other
   * writes in the same transaction — the tier-upgrade single-flight boundary
   * inserts the target sandbox row and this job as one commit, so an enqueue
   * failure can never strand a committed target without a job, and a target
   * referenced by a committed job can never be compensation-deleted (#15943).
   * No webhook support: URL validation resolves DNS and must not run inside an
   * open transaction. The caller must already hold a lock that serializes this
   * agent's creation; the per-(org,agent) provision advisory lock is still
   * acquired here (lock order: caller's org-scoped lock → provision lock).
   */
  async enqueueAgentProvisionOnceInTx(
    tx: DbTransaction,
    params: {
      agentId: string;
      organizationId: string;
      userId: string;
      agentName: string;
      restoreDirective?: AgentProvisionJobData["restoreDirective"];
    },
  ): Promise<EnqueueAgentProvisionResult> {
    return this.enqueueLifecycleJobInTx<AgentProvisionJobData>(
      tx,
      this.agentProvisionLifecycleOptions(params),
    );
  }

  protected agentProvisionLifecycleOptions(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    agentName: string;
    webhookUrl?: string;
    expectedLifecycleRevision?: number;
    restoreDirective?: AgentProvisionJobData["restoreDirective"];
  }): LifecycleJobOptions<AgentProvisionJobData> {
    const expected = params.expectedLifecycleRevision;
    return {
      jobType: JOB_TYPES.AGENT_PROVISION,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
        agentName: params.agentName,
        ...(params.restoreDirective ? { restoreDirective: params.restoreDirective } : {}),
      },
      toRecord: jobRecord<AgentProvisionJobData>,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 3,
      estimatedDurationMs: CONTAINER_LIFECYCLE_ESTIMATED_DURATION_MS,
      logName: "agent_provision",
      validateSandbox:
        expected !== undefined
          ? (sandbox) => {
              if (sandbox.lifecycle_revision !== expected) {
                throw new Error("Agent state changed while starting");
              }
            }
          : undefined,
      // A reviewed adoption pins either one exact backup or an explicit fresh
      // boot. Reusing an ordinary provision job would silently discard that
      // authority and could activate different state, so directive-bearing
      // callers only converge with an identical durable job payload.
      validateReuse: params.restoreDirective
        ? (existing) => {
            const active = readAgentProvisionJobData(existing);
            if (sameProvisionRestoreDirective(active.restoreDirective, params.restoreDirective)) {
              return;
            }
            throw new ApiError(
              409,
              "session_not_ready",
              `Provision job ${existing.id} is already ${existing.status} for this agent with different restore authority`,
              { conflictingJobId: existing.id },
            );
          }
        : undefined,
    };
  }

  /**
   * Mark a sandbox for async deletion. The HTTP DELETE handler calls this
   * synchronously; the heavy work (SSH stop on the core, DB row delete, API
   * key revoke) happens later when the provisioning worker daemon picks up
   * the resulting `agent_delete` job. The sandbox row stays in the table
   * with status `deletion_pending` so the row is auditable and re-enqueue
   * stays idempotent.
   *
   * Returns the queued job (existing if one was already in flight, new
   * otherwise) so the caller can return its id for client-side polling.
   */
  async enqueueAgentDeleteOnce(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    webhookUrl?: string;
    authorization?: DeleteAuthorization;
    stateLossAcknowledged?: boolean;
    expectedIdentity?: {
      agentName: string;
      createdAt: Date | string;
      executionTier: AgentExecutionTier;
    };
  }): Promise<EnqueueAgentDeleteResult> {
    // Stamps `deletion_allocation_counted`, and this runs inside the
    // provisioning worker, whose deploy does not gate on migrate-db. Ensure is
    // memoized, so the DDL runs once per isolate rather than once per enqueue.
    await ensureAgentSandboxSchema();
    const expectedIdentity = params.expectedIdentity;
    const expectedCreatedAt = expectedIdentity ? new Date(expectedIdentity.createdAt) : null;
    if (expectedCreatedAt && !Number.isFinite(expectedCreatedAt.getTime())) {
      throw new ApiError(400, "validation_error", "Expected agent creation timestamp is invalid");
    }
    const requestedAuthority = params.stateLossAcknowledged
      ? {
          stateLossAcknowledged: true as const,
          stateLossAcknowledgedByUserId: params.userId,
          stateLossAcknowledgedAt: new Date().toISOString(),
        }
      : {};
    return this.enqueueLifecycleJob<AgentDeleteJobData>({
      jobType: JOB_TYPES.AGENT_DELETE,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
        authorization: params.authorization,
        ...requestedAuthority,
      },
      toRecord: jobRecord<AgentDeleteJobData>,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      deleteAuthorization: params.authorization,
      allowReplacementCleanup: expectedIdentity !== undefined,
      maxAttempts: 3,
      // SSH stop is fast (~10s graceful + ~5s force kill), DB cascade is
      // sub-second. 30s matches the Docker deletion-stop command timeout.
      estimatedDurationMs: 30_000,
      logName: "agent_delete",
      upgradeReuse: params.stateLossAcknowledged
        ? async (tx, existing) => {
            const existingData = readAgentDeleteJobData(existing);
            if (
              existingData.stateLossAcknowledged === true &&
              existingData.stateLossAcknowledgedByUserId !== undefined
            ) {
              return existing;
            }
            // A legacy acknowledged row without persisted provenance is
            // stamped with the current re-requesting user: the true first
            // acknowledging actor was never recorded, so this best-effort
            // attribution is the earliest authenticated actor we can prove.
            const [upgraded] = await tx
              .update(jobs)
              .set({
                data: jobRecord<AgentDeleteJobData>({
                  ...existingData,
                  ...requestedAuthority,
                }),
                data_storage: "inline",
                data_key: null,
                updated_at: new Date(),
              })
              .where(
                and(eq(jobs.id, existing.id), sql`${jobs.status} IN ('pending', 'in_progress')`),
              )
              .returning();
            if (!upgraded) {
              throw new ApiError(
                409,
                "session_not_ready",
                "Agent deletion changed while recording state-loss authority",
              );
            }
            return hydrateJob(upgraded);
          }
        : undefined,
      validateSandbox: expectedIdentity
        ? (sandbox) => {
            if (
              sandbox.agent_name !== expectedIdentity.agentName ||
              sandbox.created_at.getTime() !== expectedCreatedAt?.getTime() ||
              sandbox.execution_tier !== expectedIdentity.executionTier
            ) {
              throw new ApiError(
                409,
                "session_not_ready",
                "Agent identity changed before deletion",
              );
            }
          }
        : undefined,
      // Flip status so the UI shows "deleting" and concurrent mutations
      // bail. Actual row removal happens in executeAgentDelete once the
      // provider proves the workload is no longer running.
      beforeInsert: async (tx, sandbox) => {
        if (
          sandbox.claimed_at &&
          (sandbox.warm_claim_credential_state === "pending" ||
            sandbox.warm_claim_credential_state === "attested")
        ) {
          throw new ApiError(
            409,
            "session_not_ready",
            "Warm-claim credential handoff is still in progress",
          );
        }
        // A pending row is either unclaimed or was made retryable only after its
        // prior execution acknowledged quiescence.
        const cancelledAt = new Date();
        const cancelled = await tx
          .update(jobs)
          .set({
            status: "cancelled",
            completed_at: cancelledAt,
            updated_at: cancelledAt,
          })
          .where(
            and(
              eq(jobs.organization_id, params.organizationId),
              eq(jobs.agent_id, params.agentId),
              ne(jobs.type, JOB_TYPES.AGENT_DELETE),
              eq(jobs.status, "pending"),
            ),
          )
          .returning({ id: jobs.id });

        // Never overwrite an execution that has not durably acknowledged
        // quiescence, regardless of its queue status.
        const [conflict] = await tx
          .select({
            id: jobs.id,
            type: jobs.type,
            status: jobs.status,
          })
          .from(jobs)
          .where(
            and(
              eq(jobs.organization_id, params.organizationId),
              eq(jobs.agent_id, params.agentId),
              ne(jobs.type, JOB_TYPES.AGENT_DELETE),
              or(
                eq(jobs.status, "in_progress"),
                and(
                  inArray(jobs.type, [...EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES]),
                  isNotNull(jobs.execution_generation),
                  isNull(jobs.execution_quiesced_at),
                  cancelled.length > 0
                    ? notInArray(
                        jobs.id,
                        cancelled.map((job) => job.id),
                      )
                    : undefined,
                ),
              ),
            ),
          )
          .orderBy(desc(jobs.updated_at))
          .limit(1);
        if (conflict) {
          throw new ApiError(
            409,
            "session_not_ready",
            `Agent ${params.agentId} has non-quiescent ${conflict.type} job ${conflict.id}`,
            {
              conflictingJobId: conflict.id,
              conflictingJobType: conflict.type,
              conflictingJobStatus: conflict.status,
            },
          );
        }

        // A genuine user-initiated delete (the row is not already in a deletion
        // state) starts the deletion-failure counter fresh — error_count may
        // carry a stale provisioning-error value, and a new delete should get a
        // full set of recovery sweeps before the circuit-breaker abandons it.
        // A recovery re-enqueue (status is already deletion_pending/_failed)
        // PRESERVES the count so reEnqueueFailedDeletions can stop the loop.
        const isRecoveryReEnqueue =
          Boolean(sandbox.deletion_attempt_id) ||
          sandbox.status === "deletion_pending" ||
          sandbox.status === "deletion_failed";
        // Continuing an earlier deletion keeps the original start time by
        // leaving the column alone. (`deletion_started_at IS NOT NULL` implies
        // isRecoveryReEnqueue via agent_sandboxes_deletion_intent_pair_check.)
        const continuesEarlierDeletion = sandbox.deletion_started_at !== null;
        const deletionAttemptId =
          isRecoveryReEnqueue && sandbox.deletion_attempt_id
            ? sandbox.deletion_attempt_id
            : crypto.randomUUID();
        const identityPredicates =
          expectedIdentity && expectedCreatedAt
            ? [
                eq(agentSandboxes.agent_name, expectedIdentity.agentName),
                sql`${agentSandboxes.created_at} >= ${expectedCreatedAt}
                AND ${agentSandboxes.created_at} < ${new Date(expectedCreatedAt.getTime() + 1)}`,
                eq(agentSandboxes.execution_tier, expectedIdentity.executionTier),
                isNull(agentSandboxes.deleted_at),
                sql`COALESCE(${agentSandboxes.warm_claim_credential_state}, '')
                NOT IN ('pending', 'attested')`,
              ]
            : [];
        const owned = await tx
          .update(agentSandboxes)
          .set({
            status: "deletion_pending" as const,
            deletion_attempt_id: deletionAttemptId,
            ...(continuesEarlierDeletion ? {} : { deletion_started_at: new Date() }),
            ...(isRecoveryReEnqueue
              ? {}
              : {
                  deletion_previous_status: sandbox.status,
                  deletion_previous_billing_status: sandbox.billing_status,
                  deletion_previous_shutdown_warning_sent_at: sandbox.shutdown_warning_sent_at,
                  deletion_previous_scheduled_shutdown_at: sandbox.scheduled_shutdown_at,
                }),
            // Gated on the BROADER continuation signal than the start time is.
            // `continuesEarlierDeletion` only checks `deletion_started_at`, and
            // nothing ties that column to `status`, so a row already sitting in
            // deletion_pending with null intent columns would take the "fresh"
            // branch and re-derive ownership from its OWN deletion status —
            // reading as "still counted" and freeing a slot on every recovery
            // sweep, the exact double-free this column exists to stop (#17185).
            ...(isDeletionContinuation(sandbox)
              ? {}
              : { deletion_allocation_counted: holdsCountedNodeSlot(sandbox) }),
            // Provider ownership is not provider absence. Keep the existing
            // billing clock live until executeAgentDelete proves the workload
            // is gone and removes this row. Failure and timeout writebacks
            // retain the row, so they also retain the charge authority.
            ...(isRecoveryReEnqueue ? {} : { error_count: 0 }),
            updated_at: new Date(),
          })
          .where(
            and(
              eq(agentSandboxes.id, params.agentId),
              eq(agentSandboxes.organization_id, params.organizationId),
              ...identityPredicates,
            ),
          )
          .returning({ id: agentSandboxes.id });
        if (owned.length !== 1) {
          throw new ApiError(409, "session_not_ready", "Agent identity changed before deletion");
        }

        if (cancelled.length > 0) {
          logger.info(
            "[provisioning-jobs] Cancelled quiescent pending jobs superseded by agent_delete",
            {
              agentId: params.agentId,
              orgId: params.organizationId,
              cancelledCount: cancelled.length,
            },
          );
        }
      },
    });
  }

  /**
   * Enqueue an Agent suspend job.
   *
   * Daemon-side execution: SSH `docker stop` on the assigned core, flip
   * `agent_sandboxes.status` to "stopped", clear `bridge_url`/`health_url`,
   * keep `sandbox_id` so the same container can be resumed.
   *
   * The Cloudflare Worker code path (cloud-api PATCH /eliza/agents/[id])
   * cannot SSH the Hetzner cores; this queue-based path moves the actual
   * docker stop off the Worker so the container is reliably stopped instead
   * of silently leaking with a stale DB row.
   */
  async enqueueAgentSuspendOnce(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    authorization: "user_request" | "billing_request";
    expectedLifecycleRevision?: number;
    requireUserOwnedBillingAuthority?: boolean;
    webhookUrl?: string;
  }): Promise<EnqueueAgentSuspendResult> {
    return this.enqueueLifecycleJob<AgentSuspendJobData>(this.agentSuspendLifecycleOptions(params));
  }

  /**
   * Transaction-scoped suspend enqueue for a caller that must commit its own
   * receipt and the exact intent/job binding atomically. Webhooks are excluded
   * because their URL validation performs network work outside transactions.
   */
  async enqueueAgentSuspendOnceInTransaction(
    tx: DbTransaction,
    params: {
      agentId: string;
      organizationId: string;
      userId: string;
      authorization: "user_request" | "billing_request";
      expectedLifecycleRevision?: number;
    },
  ): Promise<EnqueueAgentSuspendResult> {
    return this.enqueueLifecycleJobInTx<AgentSuspendJobData>(
      tx,
      this.agentSuspendLifecycleOptions(params),
    );
  }

  /** Short compatibility alias for other transaction-scoped service helpers. */
  async enqueueAgentSuspendOnceInTx(
    tx: DbTransaction,
    params: {
      agentId: string;
      organizationId: string;
      userId: string;
      authorization: "user_request" | "billing_request";
      expectedLifecycleRevision?: number;
    },
  ): Promise<EnqueueAgentSuspendResult> {
    return this.enqueueAgentSuspendOnceInTransaction(tx, params);
  }

  protected agentSuspendLifecycleOptions(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    authorization: "user_request" | "billing_request";
    webhookUrl?: string;
    expectedLifecycleRevision?: number;
    requireUserOwnedBillingAuthority?: boolean;
  }): LifecycleJobOptions<AgentSuspendJobData> {
    let intentIdToBind: string | undefined;
    const expectedLifecycleRevision = params.expectedLifecycleRevision;
    const validateTarget = (sandbox: LifecycleSandboxRow): void => {
      if (sandbox.pool_status !== null || sandbox.deleted_at !== null) {
        throw new ApiError(404, "resource_not_found", "Agent not found");
      }
      if (
        params.requireUserOwnedBillingAuthority &&
        (!isContainerBackedExecutionTier(sandbox.execution_tier) ||
          sandbox.deletion_attempt_id !== null)
      ) {
        throw new ApiError(
          409,
          "session_not_ready",
          sandbox.deletion_attempt_id
            ? "Managed agent deletion is in progress"
            : "Managed agent billing authority changed",
        );
      }
      if (
        expectedLifecycleRevision !== undefined &&
        sandbox.lifecycle_revision !== expectedLifecycleRevision
      ) {
        throw new ApiError(409, "session_not_ready", "Agent lifecycle changed before suspend", {
          expectedLifecycleRevision,
          currentLifecycleRevision: sandbox.lifecycle_revision,
        });
      }
    };
    return {
      jobType: JOB_TYPES.AGENT_SUSPEND,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
        authorization: params.authorization,
        lifecycleRevision: expectedLifecycleRevision,
      },
      toRecord: jobRecord<AgentSuspendJobData>,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 3,
      estimatedDurationMs: 30_000,
      logName: "agent_suspend",
      idempotencyPredicates:
        params.authorization === "user_request"
          ? [
              sql`${jobs.data}->>'authorization' = 'user_request'`,
              ...(expectedLifecycleRevision === undefined
                ? []
                : [sql`${jobs.data}->>'lifecycleRevision' = ${String(expectedLifecycleRevision)}`]),
            ]
          : [],
      resolveReplay: async (tx, sandbox) => {
        const targetRevision = expectedLifecycleRevision ?? sandbox.lifecycle_revision;
        const [exactIntent] = await tx
          .select()
          .from(agentComputeStopIntents)
          .where(
            and(
              eq(agentComputeStopIntents.organization_id, params.organizationId),
              eq(agentComputeStopIntents.agent_id, params.agentId),
              or(
                eq(agentComputeStopIntents.lifecycle_revision, targetRevision),
                ...(expectedLifecycleRevision === undefined
                  ? []
                  : [
                      sql`EXISTS (
                  SELECT 1 FROM ${jobs}
                  WHERE ${jobs.id} = ${agentComputeStopIntents.job_id}
                    AND ${jobs.organization_id} = ${params.organizationId}
                    AND ${jobs.agent_id} = ${params.agentId}
                    AND ${jobs.type} = 'agent_suspend'
                    AND ${jobs.data}->>'lifecycleRevision' = ${String(expectedLifecycleRevision)}
                )`,
                    ]),
              ),
              eq(agentComputeStopIntents.authorization, "user_request"),
              ...(params.authorization === "billing_request"
                ? [
                    inArray(agentComputeStopIntents.status, [
                      "pending",
                      "dispatching",
                      "retry",
                      "terminal_attention",
                    ]),
                  ]
                : []),
            ),
          )
          .for("update")
          .limit(1);
        if (exactIntent) {
          if (!exactIntent.job_id) {
            throw new Error("Agent user stop intent is not bound to a job");
          }
          const [exactJob] = await tx
            .select()
            .from(jobs)
            .where(
              and(
                eq(jobs.id, exactIntent.job_id),
                eq(jobs.type, JOB_TYPES.AGENT_SUSPEND),
                eq(jobs.organization_id, params.organizationId),
                eq(jobs.agent_id, params.agentId),
              ),
            )
            .for("update")
            .limit(1);
          if (!exactJob) {
            throw new Error("Agent user stop intent references a missing job");
          }
          return exactJob;
        }
        if (params.authorization === "billing_request") return undefined;

        // Exact durable replay deliberately precedes this gate, because
        // the accepted stop may itself have advanced the generation.
        // A first-time request must validate the currently locked row
        // before it can promote any older billing authority.
        validateTarget(sandbox);

        // An unconditional user stop monotonically strengthens a queued
        // billing stop. Reuse the same operation instead of leaving an
        // independent billing job that can be superseded by a top-up.
        const [billingIntent] = await tx
          .select()
          .from(agentComputeStopIntents)
          .where(
            and(
              eq(agentComputeStopIntents.organization_id, params.organizationId),
              eq(agentComputeStopIntents.agent_id, params.agentId),
              eq(agentComputeStopIntents.lifecycle_revision, targetRevision),
              eq(agentComputeStopIntents.authorization, "billing_request"),
              inArray(agentComputeStopIntents.status, [
                "pending",
                "dispatching",
                "retry",
                "terminal_attention",
              ]),
            ),
          )
          .for("update")
          .limit(1);
        if (!billingIntent?.job_id) return undefined;
        const [billingJob] = await tx
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.id, billingIntent.job_id),
              eq(jobs.type, JOB_TYPES.AGENT_SUSPEND),
              eq(jobs.organization_id, params.organizationId),
              eq(jobs.agent_id, params.agentId),
              sql`${jobs.status} IN ('pending', 'in_progress')`,
            ),
          )
          .for("update")
          .limit(1);
        if (!billingJob) return undefined;
        const now = new Date();
        await tx
          .update(agentComputeStopIntents)
          .set({ authorization: "user_request", updated_at: now })
          .where(eq(agentComputeStopIntents.id, billingIntent.id));
        // Do not rewrite the claimed job envelope. An executor may
        // already hold its hydrated snapshot and settlement CAS; the
        // locked intent is the monotonic authority boundary.
        if (billingJob.status === "pending") {
          const [immediate] = await tx
            .update(jobs)
            .set({ scheduled_for: now, updated_at: now })
            .where(and(eq(jobs.id, billingJob.id), eq(jobs.status, "pending")))
            .returning();
          if (!immediate) throw new Error("Promoted user stop lost its pending job");
          return immediate;
        }
        return billingJob;
      },
      validateSandbox: validateTarget,
      beforeInsert: async (tx, sandbox) => {
        const targetRevision = expectedLifecycleRevision ?? sandbox.lifecycle_revision;
        const [activeIntent] = await tx
          .select()
          .from(agentComputeStopIntents)
          .where(
            and(
              eq(agentComputeStopIntents.organization_id, params.organizationId),
              eq(agentComputeStopIntents.agent_id, params.agentId),
              inArray(agentComputeStopIntents.status, [
                "pending",
                "dispatching",
                "retry",
                "terminal_attention",
              ]),
            ),
          )
          .for("update")
          .limit(1);

        if (activeIntent && activeIntent.lifecycle_revision !== targetRevision) {
          const supersededAt = new Date();
          await tx
            .update(agentComputeStopIntents)
            .set({
              status: "superseded",
              last_error: "lifecycle_changed",
              superseded_at: supersededAt,
              updated_at: supersededAt,
            })
            .where(eq(agentComputeStopIntents.id, activeIntent.id));
        }

        if (activeIntent && activeIntent.lifecycle_revision === targetRevision) {
          const now = new Date();
          const authorization =
            activeIntent.authorization === "user_request" ? "user_request" : params.authorization;
          const [rearmed] = await tx
            .update(agentComputeStopIntents)
            .set({
              authorization,
              status: "pending",
              job_id: null,
              attempts: 0,
              last_error: null,
              provider_started_at: null,
              provider_confirmed_at: null,
              superseded_at: null,
              next_attempt_at: now,
              updated_at: now,
            })
            .where(eq(agentComputeStopIntents.id, activeIntent.id))
            .returning({ id: agentComputeStopIntents.id });
          intentIdToBind = rearmed?.id;
        } else {
          const [inserted] = await tx
            .insert(agentComputeStopIntents)
            .values({
              organization_id: params.organizationId,
              agent_id: params.agentId,
              lifecycle_revision: targetRevision,
              authorization: params.authorization,
            })
            .returning({ id: agentComputeStopIntents.id });
          intentIdToBind = inserted?.id;
        }
        if (!intentIdToBind) {
          throw new Error("Agent stop intent was not durably claimed");
        }
      },
      afterInsert: async (tx, _sandbox, job) => {
        if (!intentIdToBind) {
          throw new Error("Agent stop intent binding was lost before job insertion");
        }
        const bound = await tx
          .update(agentComputeStopIntents)
          .set({ job_id: job.id, updated_at: new Date() })
          .where(
            and(
              eq(agentComputeStopIntents.id, intentIdToBind),
              eq(agentComputeStopIntents.status, "pending"),
              isNull(agentComputeStopIntents.job_id),
            ),
          )
          .returning({ id: agentComputeStopIntents.id });
        if (bound.length !== 1) {
          throw new Error("Agent stop intent was not atomically bound to its job");
        }
      },
    };
  }

  /**
   * Enqueue an Agent resume job.
   *
   * Daemon-side execution re-runs `provision()` against the existing
   * sandbox row: this restores `bridge_url` / `health_url` from a fresh
   * sandbox handle and reuses the existing Neon DB (the `sandbox_id` is
   * retained across suspend). A faster `docker start` path will replace
   * the re-provision once `DockerSandboxProvider` exposes a standalone
   * `start()` that returns the handle.
   */
  async enqueueAgentResumeOnce(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    webhookUrl?: string;
  }): Promise<EnqueueAgentResumeResult> {
    return this.enqueueLifecycleJob<AgentResumeJobData>({
      jobType: JOB_TYPES.AGENT_RESUME,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
      },
      toRecord: jobRecord<AgentResumeJobData>,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 3,
      // docker start is ~5s on the fast path; budget the full re-provision
      // path so the UI doesn't show a stuck estimate.
      estimatedDurationMs: CONTAINER_LIFECYCLE_ESTIMATED_DURATION_MS,
      logName: "agent_resume",
      beforeInsert: async (tx) => {
        const supersededAt = new Date();
        await tx
          .update(agentComputeStopIntents)
          .set({ status: "superseded", superseded_at: supersededAt, updated_at: supersededAt })
          .where(
            and(
              eq(agentComputeStopIntents.organization_id, params.organizationId),
              eq(agentComputeStopIntents.agent_id, params.agentId),
              inArray(agentComputeStopIntents.status, [
                "pending",
                "dispatching",
                "retry",
                "terminal_attention",
              ]),
            ),
          );
      },
    });
  }

  /**
   * Enqueue an Agent sleep job (deep, cold suspend).
   *
   * Daemon-side execution: durable backup → stop+remove container → clear the
   * compute identity so the node slot frees (the autoscaler reclaims empty
   * Hetzner boxes). Distinct from `agent_suspend`, which keeps the container.
   */
  async enqueueAgentSleepOnce(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    webhookUrl?: string;
    expectedLifecycleRevision?: number;
  }): Promise<EnqueueAgentSleepResult> {
    return this.enqueueLifecycleJob<AgentSleepJobData>({
      jobType: JOB_TYPES.AGENT_SLEEP,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
      },
      toRecord: jobRecord<AgentSleepJobData>,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 3,
      // snapshot fetch (~15s) + docker stop (~5s) + DB update.
      estimatedDurationMs: 30_000,
      logName: "agent_sleep",
      validateSandbox:
        params.expectedLifecycleRevision !== undefined
          ? (sandbox) => {
              if (
                sandbox.lifecycle_revision !== params.expectedLifecycleRevision ||
                sandbox.status !== "stopped"
              ) {
                throw new ElizaError("Agent state changed before retention sleep", {
                  code: "AGENT_SLEEP_AUTHORITY_CHANGED",
                  context: {
                    agentId: params.agentId,
                    expectedLifecycleRevision: params.expectedLifecycleRevision,
                    actualLifecycleRevision: sandbox.lifecycle_revision,
                  },
                });
              }
            }
          : undefined,
    });
  }

  /**
   * Enqueue an Agent wake job.
   *
   * Daemon-side execution runs the restore-integrity gate, then provisions a
   * fresh container (claiming a warm-pool slot when available) and restores
   * the validated backup. The inverse of `agent_sleep`. `restoreBackupId` /
   * `forceFreshBoot` are the explicit wake-route escape hatches (#15603 B6),
   * never defaults.
   */
  async enqueueAgentWakeOnce(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    webhookUrl?: string;
    expectedLifecycleRevision?: number;
    restoreBackupId?: string;
    forceFreshBoot?: boolean;
  }): Promise<EnqueueAgentWakeResult> {
    const result = await this.enqueueLifecycleJob<AgentWakeJobData>({
      jobType: JOB_TYPES.AGENT_WAKE,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
        ...(params.restoreBackupId ? { restoreBackupId: params.restoreBackupId } : {}),
        ...(params.forceFreshBoot ? { forceFreshBoot: true } : {}),
      },
      toRecord: jobRecord<AgentWakeJobData>,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 3,
      // Fresh provision + state restore.
      estimatedDurationMs: CONTAINER_LIFECYCLE_ESTIMATED_DURATION_MS,
      logName: "agent_wake",
      // Automatic recovery must not outlive the observed stop generation.
      validateSandbox:
        params.expectedLifecycleRevision !== undefined
          ? (sandbox) => {
              if (sandbox.lifecycle_revision !== params.expectedLifecycleRevision)
                throw new ElizaError("Agent state changed while waking", {
                  code: "AGENT_WAKE_AUTHORITY_CHANGED",
                  context: {
                    agentId: params.agentId,
                    organizationId: params.organizationId,
                    expectedLifecycleRevision: params.expectedLifecycleRevision,
                    actualLifecycleRevision: sandbox.lifecycle_revision,
                  },
                });
            }
          : undefined,
      // Reusing an in-flight wake keeps ITS params and drops the caller's. A
      // bare retry ("wake me") may ride whatever is already running, but a
      // request that names a restore point or forces a fresh boot is a
      // DIFFERENT operation — the integrity gate's own failure message tells
      // the user to retry with restoreBackupId, and silently reusing the very
      // job that just failed the gate would discard that choice (#15603 B6).
      validateReuse: (existing) => {
        if (params.restoreBackupId === undefined && !params.forceFreshBoot) return;
        const active = readAgentWakeJobData(existing);
        const sameParams =
          (active.restoreBackupId ?? null) === (params.restoreBackupId ?? null) &&
          (active.forceFreshBoot ?? false) === (params.forceFreshBoot ?? false);
        if (sameParams) return;
        throw new ApiError(
          409,
          "session_not_ready",
          `A wake job (${existing.id}) is already ${existing.status} for this agent with ` +
            "different restore parameters; wait for it to finish (poll " +
            `/api/v1/jobs/${existing.id}) and retry.`,
          {
            conflictingJobId: existing.id,
            activeRestoreBackupId: active.restoreBackupId ?? null,
            activeForceFreshBoot: active.forceFreshBoot ?? false,
            requestedRestoreBackupId: params.restoreBackupId ?? null,
            requestedForceFreshBoot: params.forceFreshBoot ?? false,
          },
        );
      },
    });
    const applied = readAgentWakeJobData(result.job);
    return {
      ...result,
      appliedRestoreBackupId: applied.restoreBackupId ?? null,
      appliedForceFreshBoot: applied.forceFreshBoot ?? false,
    };
  }

  /**
   * Enqueue an Agent restart job.
   *
   * Daemon-side execution: SSH `docker stop` on the existing container
   * if any, then full `provision()` to recreate it. Atomic on the
   * daemon side so two concurrent restarts can't interleave stop+start
   * out of order. Replaces the Worker-side `shutdown()` then
   * `provision()` sequence which silently no-op'd the stop (Workers
   * can't SSH) and left a stale container running alongside the new
   * one.
   */
  async enqueueAgentRestartOnce(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    webhookUrl?: string;
    /** Operator waiver for a persistently failing pre-stop capture (#18228). */
    stateLossAcknowledged?: boolean;
  }): Promise<EnqueueAgentRestartResult> {
    return this.enqueueLifecycleJob<AgentRestartJobData>({
      jobType: JOB_TYPES.AGENT_RESTART,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
        ...(params.stateLossAcknowledged ? { stateLossAcknowledged: true } : {}),
      },
      toRecord: jobRecord<AgentRestartJobData>,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 3,
      // shutdown ~5s + full provision; budget the long path.
      estimatedDurationMs: CONTAINER_LIFECYCLE_ESTIMATED_DURATION_MS,
      logName: "agent_restart",
    });
  }

  /**
   * Retry exact-node retirement records left by an interrupted or unreachable
   * replacement. Rows stay fenced until container and VPN absence plus the
   * capacity release commit together.
   */
  /**
   * Converges provider-confirmed billing suspensions back to running once
   * funded entitlement returns (#30702), independent of any browser request or
   * webhook delivery order. One cursor page per call; the daemon advances the
   * cursor past unfunded accounts so they cannot starve funded ones. A crash
   * between a credit commit and enqueue is repaired by the next page.
   */
  async reconcileBillingSuspendedResumes(input: { limit: number; afterIntentId?: string }) {
    const candidates = await listBillingResumeCandidates(input);
    const result = {
      total: candidates.length,
      queued: 0,
      reused: 0,
      unfunded: 0,
      authorityChanged: 0,
      failures: [] as Array<{ agentId: string; intentId: string; error: string }>,
      nextCursor: candidates.length === input.limit ? (candidates.at(-1)?.intentId ?? null) : null,
    };
    for (const candidate of candidates) {
      try {
        const admission = await this.enqueueAutomaticBillingResume(candidate);
        if (admission.status === "queued") {
          if (admission.created) result.queued += 1;
          else result.reused += 1;
        } else if (admission.status === "unfunded") {
          result.unfunded += 1;
        } else {
          result.authorityChanged += 1;
        }
      } catch (error) {
        // error-policy:J1 each failed admission is reported; its retained
        // billing stop stays discoverable on the next reconciliation page.
        const failure = {
          agentId: candidate.agentId,
          intentId: candidate.intentId,
          error: jobErrorText(error),
        };
        result.failures.push(failure);
        logger.error("[provisioning-jobs] Automatic billing resume admission failed", failure);
      }
    }
    return result;
  }

  /**
   * Admits at most one resume job for a discovered billing suspension. Funding
   * is re-read from the primary before admission, and the stop authority is
   * re-verified under the agent lifecycle lock in the enqueue transaction, so
   * stale discovery, concurrent refills and repeated scans converge on one job.
   */
  async enqueueAutomaticBillingResume(
    candidate: BillingResumeCandidate,
  ): Promise<
    { status: "queued"; job: Job; created: boolean } | { status: "unfunded" | "authority_changed" }
  > {
    const funding = await checkAgentCreditGate(candidate.organizationId);
    if (!funding.allowed) return { status: "unfunded" };
    try {
      const admitted = await this.enqueueLifecycleJob<AgentResumeJobData>({
        jobType: JOB_TYPES.AGENT_RESUME,
        jobData: {
          agentId: candidate.agentId,
          organizationId: candidate.organizationId,
          userId: candidate.userId,
          automaticResume: { stopIntentId: candidate.intentId },
        },
        toRecord: jobRecord<AgentResumeJobData>,
        agentId: candidate.agentId,
        organizationId: candidate.organizationId,
        userId: candidate.userId,
        maxAttempts: 3,
        estimatedDurationMs: CONTAINER_LIFECYCLE_ESTIMATED_DURATION_MS,
        logName: "automatic_billing_resume",
        logExtras: { stopIntentId: candidate.intentId },
        beforeInsert: async (tx) => {
          if (!(await billingResumeStillAuthorizedInTransaction(tx, candidate))) {
            throw new ElizaError("Billing suspension is no longer resumable", {
              code: "AUTOMATIC_BILLING_RESUME_AUTHORITY_CHANGED",
              context: { agentId: candidate.agentId, intentId: candidate.intentId },
            });
          }
        },
      });
      return { status: "queued", ...admitted };
    } catch (error) {
      // error-policy:J1 a superseded or conflicting lifecycle wins; the
      // candidate is skipped, never forced.
      if (
        (error instanceof ElizaError &&
          error.code === "AUTOMATIC_BILLING_RESUME_AUTHORITY_CHANGED") ||
        (error instanceof ApiError && error.status === 409)
      ) {
        return { status: "authority_changed" };
      }
      throw error;
    }
  }

  /**
   * Fleet-upgrade: enqueue a blue/green swap of `agentId` onto `toDigest`.
   * Called by the reconciler when a registry probe sees the configured tag
   * has moved. The handler provisions a new container on the least-loaded
   * node (or autoscales) with the new image, waits for it to be healthy,
   * atomically swaps the agent's bridge_url / node_id / container_name /
   * image_digest, then gracefully stops the old container (30s SIGTERM
   * drain).
   *
   * Idempotency: the reconciler's per-agent `agent_upgrade` lookup dedups
   * before calling this (one pending or in-flight upgrade per agent at a
   * time). `enqueueLifecycleJob` adds a second layer via the
   * `active_provision_agent_idx` style guard.
   */
  async enqueueAgentUpgradeOnce(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    dockerImage: string;
    fromDigest: string | null;
    toDigest: string;
    webhookUrl?: string;
  }): Promise<{ created: boolean; job: Job }> {
    return this.enqueueLifecycleJob<AgentUpgradeJobData>({
      jobType: JOB_TYPES.AGENT_UPGRADE,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
        dockerImage: params.dockerImage,
        fromDigest: params.fromDigest,
        toDigest: params.toDigest,
      },
      toRecord: jobRecord<AgentUpgradeJobData>,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 3,
      // Full provision on a possibly fresh node (~60-90s) + health probe
      // (~30s) + atomic DB swap + 30s graceful stop = ~3 min budget.
      estimatedDurationMs: 180_000,
      logName: "agent_upgrade",
      mutuallyExclusiveJobTypes: SHARED_IMAGE_CHANGE_JOB_TYPES,
      validateSandbox: (sandbox) => {
        if (sandbox.status !== "running") {
          throw new ApiError(409, "session_not_ready", `Agent ${params.agentId} is not running`);
        }
        if (!hasReadyWarmClaimCredential(sandbox)) {
          throw new ApiError(
            409,
            "session_not_ready",
            `Agent ${params.agentId} warm-claim credential handoff is not ready`,
          );
        }
      },
    });
  }

  /**
   * Atomically enqueue one explicit super-admin canary rollout. A single
   * transaction owns the global rollout lock and every target's lifecycle lock,
   * so a bad fifth target cannot leave four accepted jobs behind.
   */
  async enqueueAdminCanaryImageRollout(params: {
    rolloutId: string;
    actorUserId: string;
    decisionAt: string;
    requestId: string;
    planFingerprint: string;
    canonicalRequestHash: string;
    targets: AdminCanaryPlannedTarget[];
  }): Promise<{ jobs: Job[]; created: boolean }> {
    if (params.targets.length < 1 || params.targets.length > ADMIN_CANARY_MAX_TARGETS) {
      throw new ApiError(
        400,
        "validation_error",
        `Canary rollout must contain between 1 and ${ADMIN_CANARY_MAX_TARGETS} targets`,
      );
    }

    const prepared = params.targets.map((target) => {
      const data: AdminCanaryImageJobData = {
        ...target,
        rolloutId: params.rolloutId,
        actorUserId: params.actorUserId,
        userId: params.actorUserId,
        decisionAt: params.decisionAt,
        requestId: params.requestId,
        planFingerprint: params.planFingerprint,
        canonicalRequestHash: params.canonicalRequestHash,
      };
      assertAdminCanaryImageJobData(data);
      return data;
    });
    const uniqueTargets = new Set(
      prepared.map((target) => `${target.organizationId}:${target.agentId}`),
    );
    if (uniqueTargets.size !== prepared.length) {
      throw new ApiError(400, "validation_error", "Canary rollout contains duplicate targets");
    }

    return await dbWrite.transaction(async (tx) => {
      await configureElizaLifecycleTransaction(tx);
      await tx.execute(elizaAdminCanaryRolloutAdvisoryLockSql());

      const replay = await tx
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE),
            eq(jobs.user_id, params.actorUserId),
            sql`${jobs.data}->>'requestId' = ${params.requestId}`,
          ),
        )
        .orderBy(jobs.created_at, jobs.id);
      if (replay.length > 0) {
        for (const job of replay) {
          const data = readAdminCanaryImageJobData(job);
          assertRecoverableAdminCanaryImageJobData(data);
          if (
            data.actorUserId !== params.actorUserId ||
            data.userId !== params.actorUserId ||
            data.requestId !== params.requestId ||
            data.organizationId !== job.organization_id ||
            data.agentId !== job.agent_id
          ) {
            throw new Error(`Admin canary request ${params.requestId} has inconsistent identity`);
          }
          if (
            data.canonicalRequestHash !== params.canonicalRequestHash ||
            data.planFingerprint !== params.planFingerprint
          ) {
            throw new ApiError(
              409,
              "session_not_ready",
              "requestId was already used for a different canary request",
              { requestId: params.requestId },
            );
          }
        }
        return { jobs: replay, created: false };
      }

      const [activeCanary] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(jobs)
        .where(
          and(
            eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE),
            sql`${jobs.status} IN ('pending', 'in_progress')`,
          ),
        );
      if (!activeCanary) {
        throw new Error("Admin canary active-job query returned no aggregate row");
      }
      if (activeCanary.count > 0) {
        throw new ApiError(
          409,
          "session_not_ready",
          "Another admin canary rollout is still pending or running",
        );
      }

      const inserted: Job[] = [];
      const ordered = [...prepared].sort((a, b) =>
        `${a.organizationId}:${a.agentId}`.localeCompare(`${b.organizationId}:${b.agentId}`),
      );
      for (const data of ordered) {
        const result = await this.enqueueLifecycleJobInTx<AdminCanaryImageJobData>(tx, {
          jobType: JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
          jobData: data,
          toRecord: jobRecord<AdminCanaryImageJobData>,
          agentId: data.agentId,
          organizationId: data.organizationId,
          userId: data.actorUserId,
          maxAttempts: 1,
          estimatedDurationMs: 180_000,
          logName: "agent_admin_canary_image",
          mutuallyExclusiveJobTypes: SHARED_IMAGE_CHANGE_JOB_TYPES,
          logExtras: {
            rolloutId: data.rolloutId,
            operation: data.operation,
            actorUserId: data.actorUserId,
            sourceImage: data.sourceImage,
            sourceDigest: data.sourceDigest,
            targetImage: data.targetImage,
            targetDigest: data.targetDigest,
          },
          validateSandbox: (sandbox) => {
            if (
              sandbox.status !== "running" ||
              !sandbox.sandbox_id ||
              !sandbox.node_id ||
              !sandbox.container_name
            ) {
              throw new ApiError(
                409,
                "session_not_ready",
                `Agent ${data.agentId} is not a running dedicated sandbox`,
              );
            }
            if (!hasReadyWarmClaimCredential(sandbox)) {
              throw new ApiError(
                409,
                "session_not_ready",
                `Agent ${data.agentId} warm-claim credential handoff is not ready`,
              );
            }
            if (sandbox.user_id !== data.targetOwnerUserId) {
              throw new ApiError(
                409,
                "session_not_ready",
                `Agent ${data.agentId} owner changed after preview`,
              );
            }
            if (
              !sandbox.docker_image ||
              !sandbox.image_digest ||
              sandbox.docker_image !== data.sourceImage ||
              sandbox.image_digest !== data.sourceDigest
            ) {
              throw new ApiError(
                409,
                "session_not_ready",
                `Agent ${data.agentId} source image changed after preview`,
              );
            }
            if (
              data.operation === "rollback" &&
              (!sandbox.previous_docker_image ||
                !sandbox.previous_image_digest ||
                sandbox.previous_docker_image !== data.targetImage ||
                sandbox.previous_image_digest !== data.targetDigest)
            ) {
              throw new ApiError(
                409,
                "session_not_ready",
                `Agent ${data.agentId} rollback pair changed after preview`,
              );
            }
          },
          validateReuse: (existing) => {
            throw new ApiError(
              409,
              "session_not_ready",
              `Canary image job ${existing.id} is already active for agent ${data.agentId}`,
              { conflictingJobId: existing.id },
            );
          },
          beforeInsert: async (transaction) => {
            const [conflict] = await transaction
              .select({
                id: jobs.id,
                type: jobs.type,
                status: jobs.status,
              })
              .from(jobs)
              .where(
                and(
                  eq(jobs.organization_id, data.organizationId),
                  eq(jobs.agent_id, data.agentId),
                  inArray(jobs.type, ADMIN_CANARY_CONFLICTING_JOB_TYPES),
                  sql`${jobs.status} IN ('pending', 'in_progress')`,
                ),
              )
              .limit(1);
            if (conflict) {
              throw new ApiError(
                409,
                "session_not_ready",
                `Agent ${data.agentId} has conflicting ${conflict.type} job ${conflict.id}`,
                {
                  conflictingJobId: conflict.id,
                  conflictingJobType: conflict.type,
                  conflictingJobStatus: conflict.status,
                },
              );
            }
          },
        });
        if (!result.created) {
          throw new Error(`Admin canary enqueue unexpectedly reused job ${result.job.id}`);
        }
        inserted.push(result.job);
      }
      return { jobs: inserted, created: true };
    });
  }

  /**
   * Enqueue an explicit agent rollback (downgrade) onto the agent's persisted
   * `previous_image_digest`. Unlike upgrade, this is never enqueued by the
   * reconciler — it's an operator/owner action after a bad upgrade. The
   * `pre-upgrade` snapshot is restored before cutover by `executeDowngrade`.
   */
  async enqueueAgentDowngradeOnce(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    dockerImage: string;
    fromDigest: string;
    webhookUrl?: string;
  }): Promise<EnqueueAgentDowngradeResult> {
    return this.enqueueLifecycleJob<AgentDowngradeJobData>({
      jobType: JOB_TYPES.AGENT_DOWNGRADE,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
        dockerImage: params.dockerImage,
        fromDigest: params.fromDigest,
      },
      toRecord: jobRecord<AgentDowngradeJobData>,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 1,
      // Same blue/green budget as upgrade + a pre-cutover snapshot restore.
      estimatedDurationMs: 180_000,
      logName: "agent_downgrade",
      logExtras: { fromDigest: params.fromDigest },
      idempotencyPredicates: [sql`${jobs.data}->>'fromDigest' = ${params.fromDigest}`],
    });
  }

  /**
   * Enqueue an Agent logs read job.
   *
   * Daemon-side execution: SSH `docker logs --tail <N>` on the assigned
   * core and persist the captured stdout/stderr into `jobs.result`.
   * Replaces the Worker-side `fetch(bridge_url + "/logs")` path which
   * returned empty for any non-running container (the bridge HTTP
   * endpoint is gone when the agent is stopped or crashed).
   *
   * In-flight reuse: a second logs request on the same agent while one
   * is still executing returns the existing job rather than spawning a
   * duplicate. Completed jobs are NOT reused — the user asking again
   * after a result has landed wants fresh logs.
   */
  async enqueueAgentLogsOnce(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    tail: number;
    webhookUrl?: string;
  }): Promise<EnqueueAgentLogsResult> {
    return this.enqueueLifecycleJob<AgentLogsJobData>({
      jobType: JOB_TYPES.AGENT_LOGS,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
        tail: params.tail,
      },
      toRecord: jobRecord<AgentLogsJobData>,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 2,
      estimatedDurationMs: 15_000,
      logName: "agent_logs",
      logExtras: { tail: params.tail },
      idempotencyPredicates: [sql`${jobs.data}->>'tail' = ${String(params.tail)}`],
    });
  }

  /**
   * Enqueue a single patron chat turn for daemon-side delivery to the agent
   * bridge. Each turn carries a unique `nonce` used as the idempotency
   * predicate, so every message ALWAYS creates a fresh job (chat turns are
   * never deduped). The caller (the synchronous /api/v1/agents/:id/message
   * route) then polls the job row for the AgentMessageJobResult.
   */
  async enqueueAgentMessage(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    text: string;
    senderId?: string;
    sessionId?: string;
    roomId?: string;
    webhookUrl?: string;
  }): Promise<{ created: boolean; job: Job }> {
    const nonce = crypto.randomUUID();
    return this.enqueueLifecycleJob<AgentMessageJobData>({
      jobType: JOB_TYPES.AGENT_MESSAGE,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
        text: params.text,
        ...(params.senderId ? { senderId: params.senderId } : {}),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(params.roomId ? { roomId: params.roomId } : {}),
        nonce,
      },
      toRecord: jobRecord<AgentMessageJobData>,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 1,
      estimatedDurationMs: 60_000,
      logName: "agent_message",
      // Unique-per-turn predicate guarantees no reuse of an existing job.
      idempotencyPredicates: [sql`${jobs.data}->>'nonce' = ${nonce}`],
    });
  }

  /**
   * Enqueue an Agent snapshot job.
   *
   * Daemon-side execution: pulls runtime state from the bridge URL and
   * persists a row in `agent_sandbox_backups`. Same operation as the
   * Worker-side `snapshot()` path, but run from the daemon so it
   * survives bridge HTTP being unreachable from CF Workers (firewall,
   * SSRF guard) and consistently uses the same network identity for
   * outbound traffic to cores.
   */
  async enqueueAgentSnapshotOnce(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    snapshotType?: "manual" | "auto";
    webhookUrl?: string;
  }): Promise<EnqueueAgentSnapshotResult> {
    const snapshotType = params.snapshotType ?? "manual";
    return this.enqueueLifecycleJob<AgentSnapshotJobData>({
      jobType: JOB_TYPES.AGENT_SNAPSHOT,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
        snapshotType,
      },
      toRecord: jobRecord<AgentSnapshotJobData>,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 2,
      estimatedDurationMs: 45_000,
      logName: "agent_snapshot",
      logExtras: { snapshotType },
      idempotencyPredicates: [sql`${jobs.data}->>'snapshotType' = ${snapshotType}`],
      validateSandbox: (sandbox) => {
        const rejection = snapshotAuthorityRejection(sandbox);
        if (rejection) {
          throw new ApiError(409, "session_not_ready", rejection);
        }
      },
    });
  }

  /**
   * Stamp `last_backup_attempt_at` and set/clear `backup_unsupported_reason`
   * after a snapshot capture attempt (#15783). Best-effort bookkeeping: a
   * marker write failure must not fail (or retry) the snapshot job itself —
   * the markers only tune sweep fairness and staleness measurement, and the
   * next attempt rewrites them.
   */
  protected async recordSnapshotAttemptMarkers(
    agentId: string,
    outcome: "success" | "unsupported" | "other",
  ): Promise<void> {
    try {
      await dbWrite
        .update(agentSandboxes)
        .set({
          last_backup_attempt_at: new Date(),
          // "other" failures (agent not running, transport blip) neither prove
          // nor disprove snapshot capability — leave the marker as it stands.
          ...(outcome === "unsupported"
            ? { backup_unsupported_reason: SNAPSHOT_ENDPOINT_UNSUPPORTED }
            : {}),
          ...(outcome === "success" ? { backup_unsupported_reason: null } : {}),
        })
        .where(eq(agentSandboxes.id, agentId));
    } catch (error) {
      // error-policy:J7 attempt-marker bookkeeping must not kill the snapshot
      // job; the condition it records is re-observed on the next attempt.
      logger.warn("[provisioning-jobs] failed to record snapshot attempt markers", {
        agentId,
        error: jobErrorText(error),
      });
    }
  }

  /**
   * Re-arm stuck `deletion_failed` sandboxes (and orphaned `deletion_pending`
   * rows whose agent_delete job was lost mid-claim) so a delete that failed or
   * was stranded eventually completes.
   *
   * `deletion_failed` is otherwise a dead-end: the agent_delete job exhausted
   * its retries (e.g. the core was down for a deploy), so the row sits forever
   * — visible to ops but never auto-recovered, and any container that survived
   * the failed teardown keeps leaking on its node. This low-frequency sweep
   * finds rows that have been `deletion_failed` longer than `minAgeMs` and
   * enqueues a FRESH agent_delete for each. `enqueueAgentDeleteOnce` is
   * idempotent (it dedups an in-flight delete and re-flips the row to
   * `deletion_pending`), so a node that has since come back will finally drop
   * the container + row. `minAgeMs` keeps this from fighting the live retry
   * loop right after a failure.
   *
   * Circuit-breaker: a permanently-dead node would otherwise be re-armed every
   * sweep forever. Each exhausted agent_delete bumps the sandbox's `error_count`
   * (see the AGENT_DELETE failure handler), so a row that has already been
   * re-enqueued `maxReEnqueues` times is SKIPPED — logged once as
   * `event: "deletion.abandoned_candidate"` for ops to investigate (the
   * container likely needs a manual node-level teardown) rather than looping.
   *
   * Capacity: `deletion_failed`/`deletion_pending` rows do NOT count toward the
   * org's agent ceiling (`QUOTA_COUNTED_STATUSES` in eliza-sandbox.ts), so a
   * stuck delete never blocks the org from creating a replacement. This sweep —
   * together with the orphan-container reconciler, which treats
   * `deletion_failed` as reapable — is what eventually reclaims the container
   * behind that freed slot, so the exclusion cannot compound into unbounded
   * live containers.
   */
  async reEnqueueFailedDeletions(params?: {
    minAgeMs?: number;
    maxAgents?: number;
    maxReEnqueues?: number;
  }): Promise<{
    scanned: number;
    reEnqueued: number;
    failed: number;
    abandoned: number;
  }> {
    const minAgeMs = params?.minAgeMs ?? 30 * 60 * 1000; // 30m
    const maxAgents = params?.maxAgents ?? 50;
    const maxReEnqueues = params?.maxReEnqueues ?? 5;
    const cutoff = new Date(Date.now() - minAgeMs);

    const stuck = await dbWrite
      .select({
        id: agentSandboxes.id,
        organizationId: agentSandboxes.organization_id,
        userId: agentSandboxes.user_id,
        errorCount: agentSandboxes.error_count,
      })
      .from(agentSandboxes)
      .where(
        and(
          // deletion_failed: the agent_delete job exhausted its retries (e.g. a
          // node was down for a deploy). deletion_pending with NO active
          // agent_delete job: the worker CLAIMED the delete job then died before
          // completing it, so recoverStaleJobs marked the JOB failed with no
          // dependent-row writeback (jobs.ts) — stranding the sandbox in
          // deletion_pending forever. Re-arm both; enqueueAgentDeleteOnce is
          // idempotent and re-flips the row to deletion_pending.
          sql`${agentSandboxes.status} IN ('deletion_failed', 'deletion_pending')`,
          sql`${agentSandboxes.updated_at} < ${cutoff}`,
          // REQUIRED now that deletion_pending is in scope: never re-arm a delete
          // that is legitimately in-flight. (deletion_failed rows never have an
          // active job, so this is a no-op for the original case.)
          sql`NOT EXISTS (
            SELECT 1 FROM ${jobs}
            WHERE  ${jobs.agent_id} = ${agentSandboxes.id}::text
            AND    ${jobs.organization_id} = ${agentSandboxes.organization_id}
            AND    ${jobs.type} = ${JOB_TYPES.AGENT_DELETE}
            AND    ${jobs.status} IN ('pending', 'in_progress')
          )`,
        ),
      )
      .limit(maxAgents);

    let reEnqueued = 0;
    let failed = 0;
    let abandoned = 0;
    for (const agent of stuck) {
      // Circuit-breaker: a row that has burned through maxReEnqueues sweeps is a
      // probably-dead node — stop re-arming it and surface it for ops once.
      if ((agent.errorCount ?? 0) >= maxReEnqueues) {
        abandoned += 1;
        logger.warn("[provisioning-jobs] deletion abandoned — exceeded re-enqueue budget", {
          event: "deletion.abandoned_candidate",
          agentId: agent.id,
          orgId: agent.organizationId,
          errorCount: agent.errorCount,
          maxReEnqueues,
        });
        continue;
      }
      try {
        await this.enqueueAgentDeleteOnce({
          agentId: agent.id,
          organizationId: agent.organizationId,
          userId: agent.userId,
        });
        reEnqueued += 1;
      } catch (error) {
        failed += 1;
        logger.warn("[provisioning-jobs] re-enqueue of failed deletion failed", {
          agentId: agent.id,
          error: jobErrorText(error),
        });
      }
    }

    if (stuck.length > 0) {
      logger.info("[provisioning-jobs] Re-enqueued stuck deletions", {
        scanned: stuck.length,
        reEnqueued,
        failed,
        abandoned,
      });
    }
    return { scanned: stuck.length, reEnqueued, failed, abandoned };
  }

  /**
   * Scan running agents and enqueue an `auto` snapshot for any whose last
   * backup is older than `minIntervalMs` (or who have never been backed up).
   * Drives the scheduled-backups cron. Per-agent dedup is handled by the
   * snapshot job's in-flight idempotency, so overlapping ticks are safe.
   * Warm-pool rows (`pool_status IS NOT NULL`) are excluded — they have no
   * user state worth backing up.
   *
   * Fairness (#15783): the due set is ordered oldest-successful-backup-first
   * (never-backed-up rows first), so a due population larger than `maxAgents`
   * degrades to round-robin-by-staleness instead of planner-dependent
   * starvation. Rows marked snapshot-incapable (`backup_unsupported_reason`,
   * set when the agent image 404s POST /api/snapshot) are re-probed only
   * every `unsupportedRecheckMs` instead of consuming the capped window on
   * every tick; `last_backup_at` stays success-only throughout so staleness
   * measurement remains honest.
   *
   * The returned `fleet` block is the Phase 0 measurement: how much of the
   * running non-pool fleet is route-less, snapshot-incapable, never backed
   * up, or stale — and how many LOCAL-STATE agents (whose entire DB lives on
   * one node's disk) currently have no backup younger than the staleness
   * threshold. A non-zero local-state count triggers the ops staleness alert.
   */
  async enqueueScheduledBackups(params?: {
    minIntervalMs?: number;
    maxAgents?: number;
    /** How often a snapshot-incapable row is re-probed. Default 24h. */
    unsupportedRecheckMs?: number;
    /**
     * Age past which a running agent's newest successful backup counts as
     * stale for alerting. Default 4× `minIntervalMs` (24h at the 6h cadence).
     */
    staleAfterMs?: number;
  }): Promise<{
    scanned: number;
    enqueued: number;
    fleet: ScheduledBackupFleetReport;
  }> {
    const minIntervalMs = params?.minIntervalMs ?? 6 * 60 * 60 * 1000; // 6h
    const maxAgents = params?.maxAgents ?? 200;
    const unsupportedRecheckMs = params?.unsupportedRecheckMs ?? 24 * 60 * 60 * 1000;
    const staleAfterMs = params?.staleAfterMs ?? 4 * minIntervalMs;
    const cutoff = new Date(Date.now() - minIntervalMs);
    const unsupportedRecheckCutoff = new Date(Date.now() - unsupportedRecheckMs);
    const staleCutoff = new Date(Date.now() - staleAfterMs);

    const due = await dbWrite
      .select({
        id: agentSandboxes.id,
        organizationId: agentSandboxes.organization_id,
        userId: agentSandboxes.user_id,
      })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.status, "running"),
          sql`${agentSandboxes.pool_status} IS NULL`,
          // Only enqueue agents that are actually reachable. A `running` row with
          // no bridge_url (shared-runtime / web-only agents, or a row whose
          // bridge was cleared) has no live state endpoint to snapshot — the
          // snapshot would just fail with "Sandbox is not running" and burn
          // retries. Requiring bridge_url keeps those out of the queue entirely.
          sql`${agentSandboxes.bridge_url} IS NOT NULL`,
          // Belt-and-suspenders for the E2E fixture sentinel (#15737): even a
          // `running` row with a non-null bridge_url is unreachable when that
          // URL is the loopback sentinel, so it must never be re-enqueued.
          ne(agentSandboxes.bridge_url, UNREACHABLE_BRIDGE_SENTINEL),
          sql`(${agentSandboxes.last_backup_at} IS NULL OR ${agentSandboxes.last_backup_at} < ${cutoff})`,
          // A row whose image proved snapshot-incapable is only re-probed at
          // the slow recheck cadence, so it cannot permanently occupy the
          // capped window (#15783 starvation, worst case 3). An image upgrade
          // is still noticed within one recheck interval, and any successful
          // snapshot clears the marker immediately.
          sql`(${agentSandboxes.backup_unsupported_reason} IS NULL OR ${agentSandboxes.last_backup_attempt_at} IS NULL OR ${agentSandboxes.last_backup_attempt_at} < ${unsupportedRecheckCutoff})`,
        ),
      )
      // Oldest successful backup first; rows that have NEVER been backed up
      // lead. Attempt time tiebreaks so equally-stale rows rotate instead of
      // repeating in planner order.
      .orderBy(
        sql`${agentSandboxes.last_backup_at} ASC NULLS FIRST`,
        sql`${agentSandboxes.last_backup_attempt_at} ASC NULLS FIRST`,
      )
      .limit(maxAgents);

    const [fleet = EMPTY_SCHEDULED_BACKUP_FLEET_REPORT] = (await dbWrite
      .select({
        running: sql<number>`count(*)::int`,
        routeless: sql<number>`count(*) filter (where ${agentSandboxes.bridge_url} IS NULL OR ${agentSandboxes.bridge_url} = ${UNREACHABLE_BRIDGE_SENTINEL})::int`,
        snapshotUnsupported: sql<number>`count(*) filter (where ${agentSandboxes.backup_unsupported_reason} IS NOT NULL)::int`,
        neverBackedUp: sql<number>`count(*) filter (where ${agentSandboxes.last_backup_at} IS NULL)::int`,
        staleBackup: sql<number>`count(*) filter (where ${agentSandboxes.last_backup_at} IS NULL OR ${agentSandboxes.last_backup_at} < ${staleCutoff})::int`,
        localState: sql<number>`count(*) filter (where ${agentSandboxes.environment_vars}->>'ELIZA_AGENT_LOCAL_STATE' = '1')::int`,
        localStateStale: sql<number>`count(*) filter (where ${agentSandboxes.environment_vars}->>'ELIZA_AGENT_LOCAL_STATE' = '1' AND (${agentSandboxes.last_backup_at} IS NULL OR ${agentSandboxes.last_backup_at} < ${staleCutoff}))::int`,
      })
      .from(agentSandboxes)
      .where(
        and(eq(agentSandboxes.status, "running"), sql`${agentSandboxes.pool_status} IS NULL`),
      )) as ScheduledBackupFleetReport[];

    if (fleet.localStateStale > 0) {
      // Local-state agents keep their ENTIRE state (PGlite DB, media, vault)
      // on one node's local disk; a stale backup there is an unbounded-loss
      // exposure, not a cosmetic gap. Loud by design; the fixed dedup key
      // keeps a sustained condition to one PagerDuty incident.
      await sendProvisioningWorkerAlert({
        title: "Local-state agents with stale or missing off-box backups",
        message: `${fleet.localStateStale} running local-state agent(s) have no successful backup within ${Math.round(staleAfterMs / 60_000)} minutes; node loss would exceed the backup RPO (#15783).`,
        details: { ...fleet, staleAfterMs, minIntervalMs },
        dedupKey: "agent-backup-staleness",
      });
    }

    let enqueued = 0;
    for (const agent of due) {
      try {
        await this.enqueueAgentSnapshotOnce({
          agentId: agent.id,
          organizationId: agent.organizationId,
          userId: agent.userId,
          snapshotType: "auto",
        });
        enqueued++;
      } catch (error) {
        logger.warn("[provisioning-jobs] Scheduled backup enqueue failed", {
          agentId: agent.id,
          error: jobErrorText(error),
        });
      }
    }

    logger.info("[provisioning-jobs] Scheduled backups enqueued", {
      scanned: due.length,
      enqueued,
      fleet,
    });
    return { scanned: due.length, enqueued, fleet };
  }

  /**
   * Best-effort kick of the provisioning worker without waiting for its next
   * daemon poll. Callers running inside a Worker must register this promise
   * with `waitUntil`; the durable job and daemon poll remain authoritative.
   */
  async triggerImmediate(env?: {
    CONTAINER_CONTROL_PLANE_TOKEN?: string;
    CONTAINER_CONTROL_PLANE_URL?: string;
    CONTAINER_SIDECAR_URL?: string;
    DATABASE_URL?: string;
    HETZNER_CONTAINER_CONTROL_PLANE_URL?: string;
  }): Promise<void> {
    const controlPlaneBaseUrl =
      env?.CONTAINER_CONTROL_PLANE_URL ??
      env?.CONTAINER_SIDECAR_URL ??
      env?.HETZNER_CONTAINER_CONTROL_PLANE_URL ??
      process.env.CONTAINER_CONTROL_PLANE_URL ??
      process.env.CONTAINER_SIDECAR_URL ??
      process.env.HETZNER_CONTAINER_CONTROL_PLANE_URL;
    const controlPlaneToken =
      env?.CONTAINER_CONTROL_PLANE_TOKEN ?? process.env.CONTAINER_CONTROL_PLANE_TOKEN;
    const databaseUrl = env?.DATABASE_URL ?? process.env.DATABASE_URL;

    if (controlPlaneBaseUrl && controlPlaneToken && databaseUrl) {
      try {
        const target = new URL(controlPlaneBaseUrl);
        target.pathname = "/api/v1/cron/process-provisioning-jobs";
        target.search = "?limit=5";
        const response = await fetch(target, {
          method: "POST",
          headers: {
            "x-container-control-plane-token": controlPlaneToken,
            "x-eliza-cloud-database-url": databaseUrl,
            "user-agent": "agent-provision-trigger/1.0",
          },
          signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok) {
          throw new ElizaError("The provisioning control plane rejected the immediate nudge", {
            code: "PROVISIONING_IMMEDIATE_TRIGGER_REJECTED",
            context: {
              target: "control-plane",
              status: response.status,
            },
          });
        }
        return;
      } catch (err) {
        logger.debug("[provisioning-jobs] direct triggerImmediate failed", {
          error: jobErrorText(err),
        });
        throw err;
      }
    }
  }

  /**
   * Get a job by ID (for status polling).
   */
  async getJob(jobId: string): Promise<Job | undefined> {
    return jobsRepository.findById(jobId);
  }

  /**
   * Get a job by ID scoped to a single organization.
   */
  async getJobForOrg(jobId: string, organizationId: string): Promise<Job | undefined> {
    return jobsRepository.findByIdAndOrg(jobId, organizationId);
  }

  /**
   * Get jobs for an organization, optionally filtered by type.
   */
  async getJobsForOrg(
    organizationId: string,
    type?: ProvisioningJobType,
    limit = 20,
  ): Promise<Job[]> {
    return jobsRepository.findByFilters({
      organizationId,
      type,
      limit,
      orderBy: "desc",
    });
  }

  /** Active agent lifecycle jobs used to restore truthful UI polling after reload. */
  async getActiveAgentLifecycleJobsForOrg(organizationId: string): Promise<Job[]> {
    return jobsRepository.findActiveAgentLifecycleJobsForOrg(organizationId);
  }
}
export const provisioningJobService = new ProvisioningJobQueue();

export {
  CONTAINER_BACKED_TARGET_REJECTION_REASON,
  listRecoverableAgentComputeStopIntents,
  lockAgentSuspendTargetInTx,
  readAdminCanaryImageJobData,
  rearmRecoverableAgentComputeStopIntentOnce,
} from "./provisioning-job-policy";
