/**
 * Async Provisioning Job Service
 *
 * Bridges the existing `jobs` table/repository with provisioning operations.
 * Instead of blocking HTTP requests for minutes, callers create a job and
 * return 202 immediately. A cron-based processor picks up pending jobs.
 *
 * Supported job types:
 * - agent_provision: Provision an Agent sandbox (Neon DB + Docker container)
 *
 * Future:
 * - wallet_provision: Server wallet provisioning
 * - agent_restore: Restore from backup
 */

import { and, desc, eq, type SQL, sql } from "drizzle-orm";
import { dbWrite } from "../../db/helpers";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import {
  hydrateJob,
  type Job,
  jobsRepository,
  type NewJob,
  prepareJobInsertData,
} from "../../db/repositories/jobs";
import { agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { jobs } from "../../db/schemas/jobs";
import { assertSafeOutboundUrl } from "../security/outbound-url";
import { logger } from "../utils/logger";
import { withTimeout } from "../utils/with-timeout";
import { dispatchAppDbDeprovisionJob } from "./app-db-deprovision-job-service";
import { dispatchAppDeployJob, readAppDeployJobData } from "./app-deploy-job-service";
import { appsService } from "./apps";
import { dispatchContainerJob, getContainerExecutorDeps } from "./container-job-service";
import { dispatchContainerStopJob } from "./container-stop-job-service";
import { elizaProvisionAdvisoryLockSql } from "./eliza-provision-lock";
import { elizaSandboxService } from "./eliza-sandbox";
import { JOB_TYPES, type ProvisioningJobType } from "./provisioning-job-types";
import {
  isWaifuWebhookTargetUrl,
  resolveWaifuWebhookTarget,
  signWaifuWebhook,
} from "./waifu-webhook";

// ---------------------------------------------------------------------------
// Job data shapes (hydrated from object storage when jobs.data is offloaded)
// ---------------------------------------------------------------------------

export interface AgentProvisionJobData {
  agentId: string;
  organizationId: string;
  userId: string;
  agentName: string;
}

export interface AgentDeleteJobData {
  agentId: string;
  organizationId: string;
  userId: string;
}

export interface AgentSuspendJobData {
  agentId: string;
  organizationId: string;
  userId: string;
}

export interface AgentResumeJobData {
  agentId: string;
  organizationId: string;
  userId: string;
}

export interface AgentSleepJobData {
  agentId: string;
  organizationId: string;
  userId: string;
}

export interface AgentWakeJobData {
  agentId: string;
  organizationId: string;
  userId: string;
}

export interface AgentRestartJobData {
  agentId: string;
  organizationId: string;
  userId: string;
}

export interface AgentUpgradeJobData {
  agentId: string;
  organizationId: string;
  userId: string;
  /** Configured image tag/ref that the reconciler resolved. */
  dockerImage: string;
  /** sha256 the agent is currently on (null if it predates digest tracking). */
  fromDigest: string | null;
  /** sha256 the reconciler resolved from the configured tag at enqueue time. */
  toDigest: string;
}

export interface AgentUpgradeJobResult {
  oldNodeId: string;
  oldContainerName: string;
  newNodeId: string;
  newContainerName: string;
  newDigest: string;
  durationMs: number;
}

export interface AgentLogsJobData {
  agentId: string;
  organizationId: string;
  userId: string;
  tail: number;
}

export interface AgentMessageJobData {
  agentId: string;
  organizationId: string;
  userId: string;
  text: string;
  senderId?: string;
  sessionId?: string;
  roomId?: string;
  /** Per-turn nonce so each chat message enqueues a fresh job (no dedupe). */
  nonce: string;
}

export interface AgentSnapshotJobData {
  agentId: string;
  organizationId: string;
  userId: string;
  snapshotType: "manual" | "auto";
}

// ---------------------------------------------------------------------------
// Job result shapes (stored in jobs.result JSONB)
// ---------------------------------------------------------------------------

export interface AgentProvisionJobResult {
  cloudAgentId: string;
  status: string;
  bridgeUrl?: string;
  healthUrl?: string;
  error?: string;
}

export interface AgentDeleteJobResult {
  cloudAgentId: string;
  containerStopped: boolean;
  rowDeleted: boolean;
  error?: string;
}

export interface AgentSuspendJobResult {
  cloudAgentId: string;
  containerStopped: boolean;
  error?: string;
}

export interface AgentResumeJobResult {
  cloudAgentId: string;
  containerStarted: boolean;
  reprovisioned: boolean;
  error?: string;
}

export interface AgentSleepJobResult {
  cloudAgentId: string;
  containerRemoved: boolean;
  backupId?: string;
  error?: string;
}

export interface AgentWakeJobResult {
  cloudAgentId: string;
  reprovisioned: boolean;
  restoredBackupId?: string;
  error?: string;
}

export interface AgentRestartJobResult {
  cloudAgentId: string;
  containerStopped: boolean;
  containerStarted: boolean;
  bridgeUrl?: string;
  healthUrl?: string;
  error?: string;
}

export interface AgentLogsJobResult {
  cloudAgentId: string;
  status: string;
  tail: number;
  logs?: string;
  message?: string;
  error?: string;
}

export interface AgentMessageJobResult {
  cloudAgentId: string;
  /** Reply text from the agent (empty when the agent produced no reply). */
  text?: string;
  /** Surfaced when the bridge could not produce a reply. */
  reason?: string;
  error?: string;
}

export interface AgentSnapshotJobResult {
  cloudAgentId: string;
  backupId?: string;
  snapshotType?: string;
  sizeBytes?: number;
  createdAt?: string;
  error?: string;
}

function agentProvisionJobDataToRecord(data: AgentProvisionJobData): Record<string, unknown> {
  return { ...data };
}

function agentProvisionJobResultToRecord(result: AgentProvisionJobResult): Record<string, unknown> {
  return { ...result };
}

function agentDeleteJobDataToRecord(data: AgentDeleteJobData): Record<string, unknown> {
  return { ...data };
}

function agentDeleteJobResultToRecord(result: AgentDeleteJobResult): Record<string, unknown> {
  return { ...result };
}

function agentSuspendJobDataToRecord(data: AgentSuspendJobData): Record<string, unknown> {
  return { ...data };
}

function agentSuspendJobResultToRecord(result: AgentSuspendJobResult): Record<string, unknown> {
  return { ...result };
}

function agentResumeJobDataToRecord(data: AgentResumeJobData): Record<string, unknown> {
  return { ...data };
}

function agentResumeJobResultToRecord(result: AgentResumeJobResult): Record<string, unknown> {
  return { ...result };
}

function agentSleepJobDataToRecord(data: AgentSleepJobData): Record<string, unknown> {
  return { ...data };
}

function agentSleepJobResultToRecord(result: AgentSleepJobResult): Record<string, unknown> {
  return { ...result };
}

function agentWakeJobDataToRecord(data: AgentWakeJobData): Record<string, unknown> {
  return { ...data };
}

function agentWakeJobResultToRecord(result: AgentWakeJobResult): Record<string, unknown> {
  return { ...result };
}

function agentRestartJobDataToRecord(data: AgentRestartJobData): Record<string, unknown> {
  return { ...data };
}

function agentRestartJobResultToRecord(result: AgentRestartJobResult): Record<string, unknown> {
  return { ...result };
}

function agentUpgradeJobDataToRecord(data: AgentUpgradeJobData): Record<string, unknown> {
  return { ...data };
}

function agentUpgradeJobResultToRecord(result: AgentUpgradeJobResult): Record<string, unknown> {
  return { ...result };
}

function agentLogsJobDataToRecord(data: AgentLogsJobData): Record<string, unknown> {
  return { ...data };
}

function agentLogsJobResultToRecord(result: AgentLogsJobResult): Record<string, unknown> {
  return { ...result };
}

function agentMessageJobDataToRecord(data: AgentMessageJobData): Record<string, unknown> {
  return { ...data };
}

function agentMessageJobResultToRecord(result: AgentMessageJobResult): Record<string, unknown> {
  return { ...result };
}

function agentSnapshotJobDataToRecord(data: AgentSnapshotJobData): Record<string, unknown> {
  return { ...data };
}

function agentSnapshotJobResultToRecord(result: AgentSnapshotJobResult): Record<string, unknown> {
  return { ...result };
}

function isAgentProvisionJobData(value: unknown): value is AgentProvisionJobData {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { agentId?: unknown }).agentId === "string" &&
    typeof (value as { organizationId?: unknown }).organizationId === "string" &&
    typeof (value as { userId?: unknown }).userId === "string" &&
    typeof (value as { agentName?: unknown }).agentName === "string"
  );
}

function isAgentDeleteJobData(value: unknown): value is AgentDeleteJobData {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { agentId?: unknown }).agentId === "string" &&
    typeof (value as { organizationId?: unknown }).organizationId === "string" &&
    typeof (value as { userId?: unknown }).userId === "string"
  );
}

function readAgentProvisionJobData(job: Job): AgentProvisionJobData {
  if (!isAgentProvisionJobData(job.data)) {
    throw new Error(`Invalid agent provision job data for job ${job.id}`);
  }
  return job.data;
}

function readAgentDeleteJobData(job: Job): AgentDeleteJobData {
  if (!isAgentDeleteJobData(job.data)) {
    throw new Error(`Invalid agent delete job data for job ${job.id}`);
  }
  return job.data;
}

function isAgentSuspendJobData(value: unknown): value is AgentSuspendJobData {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { agentId?: unknown }).agentId === "string" &&
    typeof (value as { organizationId?: unknown }).organizationId === "string" &&
    typeof (value as { userId?: unknown }).userId === "string"
  );
}

function readAgentSuspendJobData(job: Job): AgentSuspendJobData {
  if (!isAgentSuspendJobData(job.data)) {
    throw new Error(`Invalid agent suspend job data for job ${job.id}`);
  }
  return job.data;
}

function isAgentResumeJobData(value: unknown): value is AgentResumeJobData {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { agentId?: unknown }).agentId === "string" &&
    typeof (value as { organizationId?: unknown }).organizationId === "string" &&
    typeof (value as { userId?: unknown }).userId === "string"
  );
}

function readAgentResumeJobData(job: Job): AgentResumeJobData {
  if (!isAgentResumeJobData(job.data)) {
    throw new Error(`Invalid agent resume job data for job ${job.id}`);
  }
  return job.data;
}

function isAgentSleepJobData(value: unknown): value is AgentSleepJobData {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { agentId?: unknown }).agentId === "string" &&
    typeof (value as { organizationId?: unknown }).organizationId === "string" &&
    typeof (value as { userId?: unknown }).userId === "string"
  );
}

function readAgentSleepJobData(job: Job): AgentSleepJobData {
  if (!isAgentSleepJobData(job.data)) {
    throw new Error(`Invalid agent sleep job data for job ${job.id}`);
  }
  return job.data;
}

function isAgentWakeJobData(value: unknown): value is AgentWakeJobData {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { agentId?: unknown }).agentId === "string" &&
    typeof (value as { organizationId?: unknown }).organizationId === "string" &&
    typeof (value as { userId?: unknown }).userId === "string"
  );
}

function readAgentWakeJobData(job: Job): AgentWakeJobData {
  if (!isAgentWakeJobData(job.data)) {
    throw new Error(`Invalid agent wake job data for job ${job.id}`);
  }
  return job.data;
}

function isAgentRestartJobData(value: unknown): value is AgentRestartJobData {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { agentId?: unknown }).agentId === "string" &&
    typeof (value as { organizationId?: unknown }).organizationId === "string" &&
    typeof (value as { userId?: unknown }).userId === "string"
  );
}

function readAgentRestartJobData(job: Job): AgentRestartJobData {
  if (!isAgentRestartJobData(job.data)) {
    throw new Error(`Invalid agent restart job data for job ${job.id}`);
  }
  return job.data;
}

function isAgentUpgradeJobData(value: unknown): value is AgentUpgradeJobData {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.agentId === "string" &&
    typeof v.organizationId === "string" &&
    typeof v.userId === "string" &&
    typeof v.dockerImage === "string" &&
    (v.fromDigest === null || typeof v.fromDigest === "string") &&
    typeof v.toDigest === "string"
  );
}

export function readAgentUpgradeJobData(job: Job): AgentUpgradeJobData {
  if (!isAgentUpgradeJobData(job.data)) {
    throw new Error(`Invalid agent upgrade job data for job ${job.id}`);
  }
  return job.data;
}

function isAgentLogsJobData(value: unknown): value is AgentLogsJobData {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { agentId?: unknown }).agentId === "string" &&
    typeof (value as { organizationId?: unknown }).organizationId === "string" &&
    typeof (value as { userId?: unknown }).userId === "string" &&
    typeof (value as { tail?: unknown }).tail === "number"
  );
}

function readAgentLogsJobData(job: Job): AgentLogsJobData {
  if (!isAgentLogsJobData(job.data)) {
    throw new Error(`Invalid agent logs job data for job ${job.id}`);
  }
  return job.data;
}

function isAgentMessageJobData(value: unknown): value is AgentMessageJobData {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { agentId?: unknown }).agentId === "string" &&
    typeof (value as { organizationId?: unknown }).organizationId === "string" &&
    typeof (value as { userId?: unknown }).userId === "string" &&
    typeof (value as { text?: unknown }).text === "string" &&
    typeof (value as { nonce?: unknown }).nonce === "string"
  );
}

function readAgentMessageJobData(job: Job): AgentMessageJobData {
  if (!isAgentMessageJobData(job.data)) {
    throw new Error(`Invalid agent message job data for job ${job.id}`);
  }
  return job.data;
}

function isAgentSnapshotJobData(value: unknown): value is AgentSnapshotJobData {
  if (typeof value !== "object" || value === null) return false;
  const snapshotType = (value as { snapshotType?: unknown }).snapshotType;
  return (
    typeof (value as { agentId?: unknown }).agentId === "string" &&
    typeof (value as { organizationId?: unknown }).organizationId === "string" &&
    typeof (value as { userId?: unknown }).userId === "string" &&
    (snapshotType === "manual" || snapshotType === "auto")
  );
}

function readAgentSnapshotJobData(job: Job): AgentSnapshotJobData {
  if (!isAgentSnapshotJobData(job.data)) {
    throw new Error(`Invalid agent snapshot job data for job ${job.id}`);
  }
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
}

export interface EnqueueAgentRestartResult {
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

interface LifecycleSandboxRow {
  id: string;
  status: string;
  updated_at: Date | null;
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
   * Called inside the transaction after the sandbox row is fetched and
   * before the existing-job lookup. Throw to abort the enqueue (e.g.
   * provision's `expectedUpdatedAt` race check).
   */
  validateSandbox?: (sandbox: LifecycleSandboxRow) => void;
  /**
   * Called inside the transaction after the "no existing job" check
   * and before the new job is inserted. Used by delete to flip the
   * sandbox row to `deletion_pending` so the UI reflects intent and
   * concurrent mutations bail. Skipped if an existing job is reused.
   */
  beforeInsert?: (tx: Parameters<Parameters<typeof dbWrite.transaction>[0]>[0]) => Promise<void>;
}

/**
 * Hard ceiling on a single job's execution. A slow agent_delete (SSH +
 * headscale network I/O while holding a DB advisory lock) used to run for
 * minutes and starve the whole cycle. Every leaf is independently bounded, so
 * a job hitting this ceiling means something is genuinely wedged.
 */
const PER_JOB_TIMEOUT_MS = 120_000;

export class ProvisioningJobService {
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
  private async enqueueLifecycleJob<TData extends object>(
    opts: LifecycleJobOptions<TData>,
  ): Promise<{ job: Job; created: boolean }> {
    if (opts.webhookUrl) {
      await assertSafeOutboundUrl(opts.webhookUrl);
    }

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

    return await dbWrite.transaction(async (tx) => {
      await tx.execute(elizaProvisionAdvisoryLockSql(opts.organizationId, opts.agentId));

      const [sandbox] = await tx
        .select({
          id: agentSandboxes.id,
          status: agentSandboxes.status,
          updated_at: agentSandboxes.updated_at,
        })
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.id, opts.agentId),
            eq(agentSandboxes.organization_id, opts.organizationId),
          ),
        )
        .limit(1);

      if (!sandbox) {
        throw new Error("Agent not found");
      }

      opts.validateSandbox?.(sandbox);

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
        logger.info(`[provisioning-jobs] Reusing active ${opts.logName} job`, {
          jobId: existing.id,
          ...logFields,
        });
        return { job: await hydrateJob(existing), created: false };
      }

      await opts.beforeInsert?.(tx);

      const [job] = await tx
        .insert(jobs)
        .values(await prepareJobInsertData(newJob))
        .returning();

      logger.info(`[provisioning-jobs] Enqueued ${opts.logName} job`, {
        jobId: job.id,
        ...logFields,
      });

      return { job: await hydrateJob(job), created: true };
    });
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
    expectedUpdatedAt?: Date | string | null;
  }): Promise<EnqueueAgentProvisionResult> {
    const expected = params.expectedUpdatedAt;
    return this.enqueueLifecycleJob<AgentProvisionJobData>({
      jobType: JOB_TYPES.AGENT_PROVISION,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
        agentName: params.agentName,
      },
      toRecord: agentProvisionJobDataToRecord,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 3,
      // Neon DB (5-15s) + Docker pull/run (10-30s) + health check (up to 60s)
      estimatedDurationMs: 90_000,
      logName: "agent_provision",
      validateSandbox: expected
        ? (sandbox) => {
            const expectedMs = new Date(expected).getTime();
            const currentMs = sandbox.updated_at
              ? new Date(sandbox.updated_at).getTime()
              : Number.NaN;
            if (
              Number.isFinite(expectedMs) &&
              Number.isFinite(currentMs) &&
              currentMs !== expectedMs
            ) {
              throw new Error("Agent state changed while starting");
            }
          }
        : undefined,
    });
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
  }): Promise<EnqueueAgentDeleteResult> {
    return this.enqueueLifecycleJob<AgentDeleteJobData>({
      jobType: JOB_TYPES.AGENT_DELETE,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
      },
      toRecord: agentDeleteJobDataToRecord,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 3,
      // SSH stop is fast (~10s graceful + ~5s force kill), DB cascade is
      // sub-second. 30s matches docker-sandbox-provider.stop() timeout.
      estimatedDurationMs: 30_000,
      logName: "agent_delete",
      // Flip status so the UI shows "deleting" and concurrent mutations
      // bail. Actual row removal happens in executeAgentDelete once SSH
      // stop() succeeds.
      beforeInsert: async (tx) => {
        await tx
          .update(agentSandboxes)
          .set({
            status: "deletion_pending" as const,
            updated_at: new Date(),
          })
          .where(eq(agentSandboxes.id, params.agentId));
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
    webhookUrl?: string;
  }): Promise<EnqueueAgentSuspendResult> {
    return this.enqueueLifecycleJob<AgentSuspendJobData>({
      jobType: JOB_TYPES.AGENT_SUSPEND,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
      },
      toRecord: agentSuspendJobDataToRecord,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 3,
      estimatedDurationMs: 30_000,
      logName: "agent_suspend",
    });
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
      toRecord: agentResumeJobDataToRecord,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 3,
      // docker start is ~5s on the fast path, full re-provision is ~60s.
      // Budget the long path so the UI doesn't show a stuck estimate.
      estimatedDurationMs: 90_000,
      logName: "agent_resume",
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
  }): Promise<EnqueueAgentSleepResult> {
    return this.enqueueLifecycleJob<AgentSleepJobData>({
      jobType: JOB_TYPES.AGENT_SLEEP,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
      },
      toRecord: agentSleepJobDataToRecord,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 3,
      // snapshot fetch (~15s) + docker stop (~5s) + DB update.
      estimatedDurationMs: 30_000,
      logName: "agent_sleep",
    });
  }

  /**
   * Enqueue an Agent wake job.
   *
   * Daemon-side execution provisions a fresh container (claiming a warm-pool
   * slot when available) and restores the latest backup. The inverse of
   * `agent_sleep`.
   */
  async enqueueAgentWakeOnce(params: {
    agentId: string;
    organizationId: string;
    userId: string;
    webhookUrl?: string;
  }): Promise<EnqueueAgentWakeResult> {
    return this.enqueueLifecycleJob<AgentWakeJobData>({
      jobType: JOB_TYPES.AGENT_WAKE,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
      },
      toRecord: agentWakeJobDataToRecord,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 3,
      // Fresh provision (~60-90s) + state restore.
      estimatedDurationMs: 90_000,
      logName: "agent_wake",
    });
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
  }): Promise<EnqueueAgentRestartResult> {
    return this.enqueueLifecycleJob<AgentRestartJobData>({
      jobType: JOB_TYPES.AGENT_RESTART,
      jobData: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        userId: params.userId,
      },
      toRecord: agentRestartJobDataToRecord,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 3,
      // shutdown ~5s + provision ~60s; budget the long path.
      estimatedDurationMs: 90_000,
      logName: "agent_restart",
    });
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
      toRecord: agentUpgradeJobDataToRecord,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 3,
      // Full provision on a possibly fresh node (~60-90s) + health probe
      // (~30s) + atomic DB swap + 30s graceful stop = ~3 min budget.
      estimatedDurationMs: 180_000,
      logName: "agent_upgrade",
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
      toRecord: agentLogsJobDataToRecord,
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
      toRecord: agentMessageJobDataToRecord,
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
      toRecord: agentSnapshotJobDataToRecord,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 2,
      estimatedDurationMs: 45_000,
      logName: "agent_snapshot",
      logExtras: { snapshotType },
      idempotencyPredicates: [sql`${jobs.data}->>'snapshotType' = ${snapshotType}`],
    });
  }

  /**
   * Scan running agents and enqueue an `auto` snapshot for any whose last
   * backup is older than `minIntervalMs` (or who have never been backed up).
   * Drives the scheduled-backups cron. Per-agent dedup is handled by the
   * snapshot job's in-flight idempotency, so overlapping ticks are safe.
   * Warm-pool rows (`pool_status IS NOT NULL`) are excluded — they have no
   * user state worth backing up.
   */
  async enqueueScheduledBackups(params?: {
    minIntervalMs?: number;
    maxAgents?: number;
  }): Promise<{ scanned: number; enqueued: number }> {
    const minIntervalMs = params?.minIntervalMs ?? 6 * 60 * 60 * 1000; // 6h
    const maxAgents = params?.maxAgents ?? 200;
    const cutoff = new Date(Date.now() - minIntervalMs);

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
          sql`(${agentSandboxes.last_backup_at} IS NULL OR ${agentSandboxes.last_backup_at} < ${cutoff})`,
        ),
      )
      .limit(maxAgents);

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
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info("[provisioning-jobs] Scheduled backups enqueued", {
      scanned: due.length,
      enqueued,
    });
    return { scanned: due.length, enqueued };
  }

  /**
   * Best-effort kick of the provisioning worker without waiting for the
   * next cron tick. Fire-and-forget — the cron is the safety net.
   *
   * The cron endpoint is idempotent (FOR UPDATE SKIP LOCKED) so calling
   * it concurrently with the scheduled invocation is safe.
   */
  async triggerImmediate(env?: {
    CRON_SECRET?: string;
    CONTAINER_CONTROL_PLANE_TOKEN?: string;
    CONTAINER_CONTROL_PLANE_URL?: string;
    CONTAINER_SIDECAR_URL?: string;
    DATABASE_URL?: string;
    HETZNER_CONTAINER_CONTROL_PLANE_URL?: string;
    NEXT_PUBLIC_API_URL?: string;
    NEXT_PUBLIC_APP_URL?: string;
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
        await fetch(target, {
          method: "POST",
          headers: {
            "x-container-control-plane-token": controlPlaneToken,
            "x-eliza-cloud-database-url": databaseUrl,
            "user-agent": "agent-provision-trigger/1.0",
          },
          signal: AbortSignal.timeout(120_000),
        });
        return;
      } catch (err) {
        logger.debug("[provisioning-jobs] direct triggerImmediate failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const cronSecret = env?.CRON_SECRET ?? process.env.CRON_SECRET;
    const baseUrl =
      env?.NEXT_PUBLIC_API_URL ??
      env?.NEXT_PUBLIC_APP_URL ??
      process.env.NEXT_PUBLIC_API_URL ??
      process.env.NEXT_PUBLIC_APP_URL;
    if (!cronSecret || !baseUrl) return;
    try {
      await fetch(`${baseUrl}/api/v1/cron/process-provisioning-jobs?limit=5`, {
        method: "POST",
        headers: {
          "x-cron-secret": cronSecret,
          "user-agent": "agent-provision-trigger/1.0",
        },
        signal: AbortSignal.timeout(3_000),
      });
    } catch (err) {
      logger.debug("[provisioning-jobs] triggerImmediate fire-and-forget failed", {
        error: err instanceof Error ? err.message : String(err),
      });
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

  // ---------------------------------------------------------------------------
  // Processing (called by cron)
  // ---------------------------------------------------------------------------

  /**
   * Claim and process pending provisioning jobs.
   * Designed to be called by a cron route every minute.
   *
   * Uses FOR UPDATE SKIP LOCKED so multiple cron invocations won't
   * double-process the same job.
   *
   * @param batchSize - Max jobs to process per invocation.
   * @param opts.jobTypes - Restrict claiming + stale-recovery to this lane of
   *   job types (e.g. `APPS_JOB_TYPES` for the dedicated apps-control daemon).
   *   Omitted → ALL types (the single-daemon default). Scoping is what lets two
   *   daemons share the `jobs` table without one claiming-and-failing the
   *   other's lane.
   * @returns Summary of processing results.
   */
  async processPendingJobs(
    batchSize = 5,
    opts: { jobTypes?: readonly ProvisioningJobType[] } = {},
  ): Promise<ProcessingResult> {
    const result: ProcessingResult = {
      claimed: 0,
      succeeded: 0,
      failed: 0,
      errors: [],
    };

    const jobTypes = opts.jobTypes ?? Object.values(JOB_TYPES);

    // Process each job type in this daemon's lane
    for (const jobType of jobTypes) {
      await this.processJobType(jobType, batchSize, result);
    }

    // Recover stale jobs (stuck in_progress for >5 minutes), scoped to the same
    // lane so a lane-scoped daemon never resets the OTHER lane's stale rows.
    const recovered = await this.recoverStaleJobs(jobTypes);
    if (recovered > 0) {
      logger.info("[provisioning-jobs] Recovered stale jobs", { recovered });
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async processJobType(
    jobType: string,
    batchSize: number,
    result: ProcessingResult,
  ): Promise<void> {
    // Atomically claim pending jobs using FOR UPDATE SKIP LOCKED.
    // This prevents double-execution when overlapping cron runs race,
    // and respects scheduled_for so exponential backoff actually works.
    const claimedJobs = await jobsRepository.claimPendingJobs({
      type: jobType,
      limit: batchSize,
    });

    for (const job of claimedJobs) {
      result.claimed++;

      try {
        // withTimeout frees the awaiter (this cycle's job slot), not the
        // underlying SSH/headscale I/O — those are themselves bounded. On
        // timeout this throws → the catch below runs incrementAttempt, which
        // flips the row to error/deletion_failed once attempts exhaust;
        // recoverStaleJobs (5-min in_progress threshold) is the backstop.
        await withTimeout(this.executeJob(job), PER_JOB_TIMEOUT_MS, `job ${job.type}`);
        result.succeeded++;
      } catch (err) {
        result.failed++;
        const errorMsg = err instanceof Error ? err.message : String(err);
        result.errors.push({ jobId: job.id, error: errorMsg });

        // Increment attempt; will auto-fail if max_attempts reached
        const updated = await jobsRepository.incrementAttempt(job.id, errorMsg, job.max_attempts);

        // When retries are exhausted (permanent failure), mark the
        // sandbox as "error" immediately so the UI reflects reality
        // instead of staying stuck in "provisioning".
        if (updated?.status === "failed" && job.type === JOB_TYPES.AGENT_PROVISION) {
          const data = readAgentProvisionJobData(job);
          try {
            await agentSandboxesRepository.update(data.agentId, {
              status: "error",
              error_message: `Provisioning permanently failed after ${job.max_attempts} attempts: ${errorMsg}`,
            });
            logger.warn("[provisioning-jobs] Marked sandbox as error after permanent failure", {
              jobId: job.id,
              agentId: data.agentId,
            });
          } catch (sandboxErr) {
            logger.error("[provisioning-jobs] Failed to mark sandbox as error", {
              jobId: job.id,
              agentId: data.agentId,
              error: sandboxErr instanceof Error ? sandboxErr.message : String(sandboxErr),
            });
          }
        }

        // Symmetric handling for app_deploy (Apps / Product 2): a permanently
        // failed deploy must flip the app off `building`, or the deploy-status
        // route (which echoes `apps.deployment_status`) reports BUILDING forever
        // — the CLI/dashboard never sees the failure. Mirrors the createDeployment
        // enqueue-side catch, which only covers the synchronous enqueue, not this
        // async daemon execution. Especially relevant during the lane-migration
        // window, when the agent CP worker (still default=all lanes) claims an
        // APP_DEPLOY it can't run and exhausts retries.
        if (updated?.status === "failed" && job.type === JOB_TYPES.APP_DEPLOY) {
          const { appId } = readAppDeployJobData(job);
          try {
            await appsService.update(appId, { deployment_status: "failed" });
            logger.warn(
              "[provisioning-jobs] Marked app deployment as failed after permanent failure",
              {
                jobId: job.id,
                appId,
              },
            );
          } catch (appErr) {
            logger.error("[provisioning-jobs] Failed to mark app deployment as failed", {
              jobId: job.id,
              appId,
              error: appErr instanceof Error ? appErr.message : String(appErr),
            });
          }
        }

        // Symmetric handling for agent_delete: when the daemon gives up,
        // flip the row to `deletion_failed` so ops can see the stuck
        // sandboxes (and the container that probably survived on the core)
        // instead of leaving the row stuck in `deletion_pending` forever.
        if (updated?.status === "failed" && job.type === JOB_TYPES.AGENT_DELETE) {
          const data = readAgentDeleteJobData(job);
          try {
            await agentSandboxesRepository.update(data.agentId, {
              status: "deletion_failed",
              error_message: `Deletion permanently failed after ${job.max_attempts} attempts: ${errorMsg}`,
            });
            logger.warn(
              "[provisioning-jobs] Marked sandbox as deletion_failed after permanent failure",
              { jobId: job.id, agentId: data.agentId },
            );
          } catch (sandboxErr) {
            logger.error("[provisioning-jobs] Failed to mark sandbox as deletion_failed", {
              jobId: job.id,
              agentId: data.agentId,
              error: sandboxErr instanceof Error ? sandboxErr.message : String(sandboxErr),
            });
          }
        }
      }
    }
  }

  private async executeJob(job: Job): Promise<void> {
    switch (job.type) {
      case JOB_TYPES.AGENT_PROVISION:
        await this.executeAgentProvision(job);
        break;
      case JOB_TYPES.AGENT_DELETE:
        await this.executeAgentDelete(job);
        break;
      case JOB_TYPES.AGENT_SUSPEND:
        await this.executeAgentSuspend(job);
        break;
      case JOB_TYPES.AGENT_RESUME:
        await this.executeAgentResume(job);
        break;
      case JOB_TYPES.AGENT_SLEEP:
        await this.executeAgentSleep(job);
        break;
      case JOB_TYPES.AGENT_WAKE:
        await this.executeAgentWake(job);
        break;
      case JOB_TYPES.AGENT_RESTART:
        await this.executeAgentRestart(job);
        break;
      case JOB_TYPES.AGENT_UPGRADE:
        await this.executeAgentUpgrade(job);
        break;
      case JOB_TYPES.AGENT_LOGS:
        await this.executeAgentLogs(job);
        break;
      case JOB_TYPES.AGENT_MESSAGE:
        await this.executeAgentMessage(job);
        break;
      case JOB_TYPES.AGENT_SNAPSHOT:
        await this.executeAgentSnapshot(job);
        break;
      // Apps lane (Product 2): generic app-container lifecycle. Routed to the
      // standalone container-job-service (kept out of the agent-coupled paths
      // above); the executor backend is wired at boot via setContainerExecutorDeps.
      case JOB_TYPES.CONTAINER_PROVISION:
      case JOB_TYPES.CONTAINER_DELETE:
      case JOB_TYPES.CONTAINER_RESTART:
      case JOB_TYPES.CONTAINER_UPGRADE:
      case JOB_TYPES.CONTAINER_LOGS:
        await dispatchContainerJob(job, getContainerExecutorDeps());
        break;
      // Billing-suspend stop (#8342): the container-billing cron (Worker, no SSH)
      // enqueues this when an org runs out of credit; the daemon runs the real
      // `docker stop` + remove via HetznerContainersClient (volume preserved,
      // node slot freed). Routed direct to its own dispatcher — NOT through
      // dispatchContainerJob (which targets the apps-lane AppContainerProvider
      // by container name); these are 2AM `containers` rows stopped by id+org.
      // Self-marked completed so recoverStaleJobs() can't re-sweep it: the stop
      // is idempotent on a live container, but re-running after the row is gone
      // is pointless churn, and a completed row is the clean terminal state.
      case JOB_TYPES.CONTAINER_STOP: {
        const outcome = await dispatchContainerStopJob(job);
        await jobsRepository.updateStatus(job.id, "completed", {
          result: { stopped: outcome.stopped, reason: outcome.reason ?? null },
          completed_at: new Date(),
        });
        break;
      }
      // Apps lane (Product 2): the node deploy. The Worker enqueues this; the
      // daemon runs the real isolated provision via the injected AppDeployRunner.
      case JOB_TYPES.APP_DEPLOY:
        await dispatchAppDeployJob(job);
        break;
      // Apps lane (Product 2): tear down a deleted app's isolated tenant DB.
      // The Worker enqueues this; the daemon runs the real DROP + slot release
      // via the injected deprovisioner (wired in apps-deploy-backend). (#8342)
      case JOB_TYPES.APP_DB_DEPROVISION: {
        const outcome = await dispatchAppDbDeprovisionJob(job);
        // Mark terminal so recoverStaleJobs() can't re-sweep this job back to
        // `pending` after the stale threshold. A re-run would call
        // deprovisionTenantDbForApp -> releaseSlot() a SECOND time, and
        // releaseSlot's GREATEST(0, database_count - 1) is NOT idempotent
        // across separate successful runs: on a multi-tenant cluster the second
        // decrement frees a phantom slot belonging to another LIVE tenant DB
        // (capacity over-allocation — the inverse of the #8342 leak this very
        // job fixes). Every AGENT_* executor self-marks completed for exactly
        // this reason; the Apps-lane dispatchers historically relied on never
        // being re-swept, which only bites this non-idempotent deprovision path.
        //
        // Follow-up (deeper hardening, separate PR): make releaseSlot itself
        // idempotent by gating it on the DROP actually removing an existing DB
        // (needs a row-returning query seam on TenantDbSqlExecutor). That would
        // also close the micro-window where this updateStatus throws AFTER a
        // successful releaseSlot and the retry re-decrements.
        await jobsRepository.updateStatus(job.id, "completed", {
          result: {
            deprovisioned: outcome.deprovisioned,
            reason: outcome.reason ?? null,
          },
          completed_at: new Date(),
        });
        break;
      }
      default:
        throw new Error(`Unknown job type: ${job.type}`);
    }
  }

  private async executeAgentSuspend(job: Job): Promise<void> {
    const data = readAgentSuspendJobData(job);

    if (data.organizationId !== job.organization_id) {
      throw new Error(
        `Organization ID mismatch: job.data.organizationId (${data.organizationId}) !== job.organization_id (${job.organization_id})`,
      );
    }

    logger.info("[provisioning-jobs] Executing agent_suspend", {
      jobId: job.id,
      agentId: data.agentId,
    });

    const result = await elizaSandboxService.executeSuspend(data.agentId, data.organizationId);

    if (!result.success) {
      await jobsRepository.update(job.id, {
        result: agentSuspendJobResultToRecord({
          cloudAgentId: data.agentId,
          containerStopped: result.containerStopped,
          error: result.error,
        }),
      });
      throw new Error(result.error ?? "Unknown agent_suspend failure");
    }

    const jobResult: AgentSuspendJobResult = {
      cloudAgentId: data.agentId,
      containerStopped: result.containerStopped,
    };

    await jobsRepository.updateStatus(job.id, "completed", {
      result: agentSuspendJobResultToRecord(jobResult),
      completed_at: new Date(),
    });

    if (job.webhook_url) {
      await this.fireWebhook(job, jobResult);
    }

    logger.info("[provisioning-jobs] agent_suspend completed", {
      jobId: job.id,
      agentId: data.agentId,
      containerStopped: result.containerStopped,
    });
  }

  private async executeAgentResume(job: Job): Promise<void> {
    const data = readAgentResumeJobData(job);

    if (data.organizationId !== job.organization_id) {
      throw new Error(
        `Organization ID mismatch: job.data.organizationId (${data.organizationId}) !== job.organization_id (${job.organization_id})`,
      );
    }

    logger.info("[provisioning-jobs] Executing agent_resume", {
      jobId: job.id,
      agentId: data.agentId,
    });

    const result = await elizaSandboxService.executeResume(data.agentId, data.organizationId);

    if (!result.success) {
      await jobsRepository.update(job.id, {
        result: agentResumeJobResultToRecord({
          cloudAgentId: data.agentId,
          containerStarted: result.containerStarted,
          reprovisioned: result.reprovisioned,
          error: result.error,
        }),
      });
      throw new Error(result.error ?? "Unknown agent_resume failure");
    }

    const jobResult: AgentResumeJobResult = {
      cloudAgentId: data.agentId,
      containerStarted: result.containerStarted,
      reprovisioned: result.reprovisioned,
    };

    await jobsRepository.updateStatus(job.id, "completed", {
      result: agentResumeJobResultToRecord(jobResult),
      completed_at: new Date(),
    });

    if (job.webhook_url) {
      await this.fireWebhook(job, jobResult);
    }

    logger.info("[provisioning-jobs] agent_resume completed", {
      jobId: job.id,
      agentId: data.agentId,
      containerStarted: result.containerStarted,
      reprovisioned: result.reprovisioned,
    });
  }

  private async executeAgentSleep(job: Job): Promise<void> {
    const data = readAgentSleepJobData(job);

    if (data.organizationId !== job.organization_id) {
      throw new Error(
        `Organization ID mismatch: job.data.organizationId (${data.organizationId}) !== job.organization_id (${job.organization_id})`,
      );
    }

    logger.info("[provisioning-jobs] Executing agent_sleep", {
      jobId: job.id,
      agentId: data.agentId,
    });

    const result = await elizaSandboxService.executeSleep(data.agentId, data.organizationId);

    if (!result.success) {
      await jobsRepository.update(job.id, {
        result: agentSleepJobResultToRecord({
          cloudAgentId: data.agentId,
          containerRemoved: result.containerRemoved,
          backupId: result.backupId,
          error: result.error,
        }),
      });
      throw new Error(result.error ?? "Unknown agent_sleep failure");
    }

    const jobResult: AgentSleepJobResult = {
      cloudAgentId: data.agentId,
      containerRemoved: result.containerRemoved,
      backupId: result.backupId,
    };

    await jobsRepository.updateStatus(job.id, "completed", {
      result: agentSleepJobResultToRecord(jobResult),
      completed_at: new Date(),
    });

    if (job.webhook_url) {
      await this.fireWebhook(job, jobResult);
    }

    logger.info("[provisioning-jobs] agent_sleep completed", {
      jobId: job.id,
      agentId: data.agentId,
      backupId: result.backupId,
      containerRemoved: result.containerRemoved,
    });
  }

  private async executeAgentWake(job: Job): Promise<void> {
    const data = readAgentWakeJobData(job);

    if (data.organizationId !== job.organization_id) {
      throw new Error(
        `Organization ID mismatch: job.data.organizationId (${data.organizationId}) !== job.organization_id (${job.organization_id})`,
      );
    }

    logger.info("[provisioning-jobs] Executing agent_wake", {
      jobId: job.id,
      agentId: data.agentId,
    });

    const result = await elizaSandboxService.executeWake(data.agentId, data.organizationId);

    if (!result.success) {
      await jobsRepository.update(job.id, {
        result: agentWakeJobResultToRecord({
          cloudAgentId: data.agentId,
          reprovisioned: result.reprovisioned,
          restoredBackupId: result.restoredBackupId,
          error: result.error,
        }),
      });
      throw new Error(result.error ?? "Unknown agent_wake failure");
    }

    const jobResult: AgentWakeJobResult = {
      cloudAgentId: data.agentId,
      reprovisioned: result.reprovisioned,
      restoredBackupId: result.restoredBackupId,
    };

    await jobsRepository.updateStatus(job.id, "completed", {
      result: agentWakeJobResultToRecord(jobResult),
      completed_at: new Date(),
    });

    if (job.webhook_url) {
      await this.fireWebhook(job, jobResult);
    }

    logger.info("[provisioning-jobs] agent_wake completed", {
      jobId: job.id,
      agentId: data.agentId,
      reprovisioned: result.reprovisioned,
      restoredBackupId: result.restoredBackupId,
    });
  }

  private async executeAgentRestart(job: Job): Promise<void> {
    const data = readAgentRestartJobData(job);

    if (data.organizationId !== job.organization_id) {
      throw new Error(
        `Organization ID mismatch: job.data.organizationId (${data.organizationId}) !== job.organization_id (${job.organization_id})`,
      );
    }

    logger.info("[provisioning-jobs] Executing agent_restart", {
      jobId: job.id,
      agentId: data.agentId,
    });

    const result = await elizaSandboxService.executeRestart(data.agentId, data.organizationId);

    if (!result.success) {
      await jobsRepository.update(job.id, {
        result: agentRestartJobResultToRecord({
          cloudAgentId: data.agentId,
          containerStopped: result.containerStopped,
          containerStarted: result.containerStarted,
          error: result.error,
        }),
      });
      throw new Error(result.error ?? "Unknown agent_restart failure");
    }

    const jobResult: AgentRestartJobResult = {
      cloudAgentId: data.agentId,
      containerStopped: result.containerStopped,
      containerStarted: result.containerStarted,
      bridgeUrl: result.bridgeUrl,
      healthUrl: result.healthUrl,
    };

    await jobsRepository.updateStatus(job.id, "completed", {
      result: agentRestartJobResultToRecord(jobResult),
      completed_at: new Date(),
    });

    if (job.webhook_url) {
      await this.fireWebhook(job, jobResult);
    }

    logger.info("[provisioning-jobs] agent_restart completed", {
      jobId: job.id,
      agentId: data.agentId,
      containerStopped: result.containerStopped,
      containerStarted: result.containerStarted,
    });
  }

  private async executeAgentUpgrade(job: Job): Promise<void> {
    const data = readAgentUpgradeJobData(job);

    if (data.organizationId !== job.organization_id) {
      throw new Error(
        `Organization ID mismatch: job.data.organizationId (${data.organizationId}) !== job.organization_id (${job.organization_id})`,
      );
    }

    logger.info("[provisioning-jobs] Executing agent_upgrade", {
      jobId: job.id,
      agentId: data.agentId,
      dockerImage: data.dockerImage,
      fromDigest: data.fromDigest,
      toDigest: data.toDigest,
    });

    const startedAt = Date.now();
    const result = await elizaSandboxService.executeUpgrade(
      data.agentId,
      data.organizationId,
      data.toDigest,
      data.dockerImage,
      data.fromDigest,
    );

    if (!result.success) {
      // Failures are visible by the row staying on the OLD image_digest; the
      // reconciler will try again on the next cycle. The worker's standard
      // error handling marks the job failed and stores this error message.
      throw new Error(result.error ?? "Unknown agent_upgrade failure");
    }

    const jobResult: AgentUpgradeJobResult = {
      oldNodeId: result.oldNodeId ?? "",
      oldContainerName: result.oldContainerName ?? "",
      newNodeId: result.newNodeId ?? "",
      newContainerName: result.newContainerName ?? "",
      newDigest: result.newDigest ?? data.toDigest,
      durationMs: Date.now() - startedAt,
    };

    await jobsRepository.updateStatus(job.id, "completed", {
      result: agentUpgradeJobResultToRecord(jobResult),
      completed_at: new Date(),
    });

    if (job.webhook_url) {
      await this.fireWebhook(job, jobResult);
    }

    logger.info("[provisioning-jobs] agent_upgrade completed", {
      jobId: job.id,
      agentId: data.agentId,
      oldNodeId: jobResult.oldNodeId,
      newNodeId: jobResult.newNodeId,
      durationMs: jobResult.durationMs,
    });
  }

  private async executeAgentLogs(job: Job): Promise<void> {
    const data = readAgentLogsJobData(job);

    if (data.organizationId !== job.organization_id) {
      throw new Error(
        `Organization ID mismatch: job.data.organizationId (${data.organizationId}) !== job.organization_id (${job.organization_id})`,
      );
    }

    logger.info("[provisioning-jobs] Executing agent_logs", {
      jobId: job.id,
      agentId: data.agentId,
      tail: data.tail,
    });

    const result = await elizaSandboxService.executeLogs(
      data.agentId,
      data.organizationId,
      data.tail,
    );

    if (!result.success) {
      await jobsRepository.update(job.id, {
        result: agentLogsJobResultToRecord({
          cloudAgentId: data.agentId,
          status: result.status,
          tail: data.tail,
          message: result.message,
          error: result.error,
        }),
      });
      throw new Error(result.error ?? "Unknown agent_logs failure");
    }

    const jobResult: AgentLogsJobResult = {
      cloudAgentId: data.agentId,
      status: result.status,
      tail: data.tail,
      logs: result.logs,
      message: result.message,
    };

    await jobsRepository.updateStatus(job.id, "completed", {
      result: agentLogsJobResultToRecord(jobResult),
      completed_at: new Date(),
    });

    if (job.webhook_url) {
      await this.fireWebhook(job, jobResult);
    }

    logger.info("[provisioning-jobs] agent_logs completed", {
      jobId: job.id,
      agentId: data.agentId,
      status: result.status,
      bytes: result.logs?.length ?? 0,
    });
  }

  /**
   * Deliver a patron chat turn to the agent's bridge. Runs on the daemon,
   * which (unlike the CF edge worker) can reach the container's raw bridge
   * port, so it just calls elizaSandboxService.bridge('message.send'), which
   * already implements the robust multi-strategy send + no-reply fallback.
   * Stores the reply text on the job result for the route to poll.
   */
  private async executeAgentMessage(job: Job): Promise<void> {
    const data = readAgentMessageJobData(job);

    if (data.organizationId !== job.organization_id) {
      throw new Error(
        `Organization ID mismatch: job.data.organizationId (${data.organizationId}) !== job.organization_id (${job.organization_id})`,
      );
    }

    logger.info("[provisioning-jobs] Executing agent_message", {
      jobId: job.id,
      agentId: data.agentId,
      chars: data.text.length,
    });

    const response = await elizaSandboxService.bridge(data.agentId, data.organizationId, {
      jsonrpc: "2.0",
      method: "message.send",
      params: {
        text: data.text,
        ...(data.senderId ? { userId: data.senderId } : {}),
        ...(data.sessionId ? { sessionId: data.sessionId } : {}),
        ...(data.roomId ? { roomId: data.roomId } : {}),
      },
    });

    if (response.error) {
      await jobsRepository.update(job.id, {
        result: agentMessageJobResultToRecord({
          cloudAgentId: data.agentId,
          error: response.error.message,
        }),
      });
      throw new Error(response.error.message || "agent_message bridge failure");
    }

    const result = (response.result ?? {}) as Record<string, unknown>;
    const jobResult: AgentMessageJobResult = {
      cloudAgentId: data.agentId,
      text: typeof result.text === "string" ? result.text : undefined,
      reason: typeof result.reason === "string" ? result.reason : undefined,
    };

    await jobsRepository.updateStatus(job.id, "completed", {
      result: agentMessageJobResultToRecord(jobResult),
      completed_at: new Date(),
    });

    if (job.webhook_url) {
      await this.fireWebhook(job, jobResult);
    }

    logger.info("[provisioning-jobs] agent_message completed", {
      jobId: job.id,
      agentId: data.agentId,
      replyChars: jobResult.text?.length ?? 0,
    });
  }

  private async executeAgentSnapshot(job: Job): Promise<void> {
    const data = readAgentSnapshotJobData(job);

    if (data.organizationId !== job.organization_id) {
      throw new Error(
        `Organization ID mismatch: job.data.organizationId (${data.organizationId}) !== job.organization_id (${job.organization_id})`,
      );
    }

    logger.info("[provisioning-jobs] Executing agent_snapshot", {
      jobId: job.id,
      agentId: data.agentId,
      snapshotType: data.snapshotType,
    });

    const result = await elizaSandboxService.executeSnapshot(
      data.agentId,
      data.organizationId,
      data.snapshotType,
    );

    if (!result.success) {
      await jobsRepository.update(job.id, {
        result: agentSnapshotJobResultToRecord({
          cloudAgentId: data.agentId,
          error: result.error,
        }),
      });
      throw new Error(result.error ?? "Unknown agent_snapshot failure");
    }

    const jobResult: AgentSnapshotJobResult = {
      cloudAgentId: data.agentId,
      backupId: result.backup?.id,
      snapshotType: result.backup?.snapshot_type ?? data.snapshotType,
      sizeBytes: result.backup?.size_bytes ?? undefined,
      createdAt: result.backup?.created_at
        ? new Date(result.backup.created_at).toISOString()
        : undefined,
    };

    await jobsRepository.updateStatus(job.id, "completed", {
      result: agentSnapshotJobResultToRecord(jobResult),
      completed_at: new Date(),
    });

    if (job.webhook_url) {
      await this.fireWebhook(job, jobResult);
    }

    logger.info("[provisioning-jobs] agent_snapshot completed", {
      jobId: job.id,
      agentId: data.agentId,
      backupId: jobResult.backupId,
      bytes: jobResult.sizeBytes,
    });
  }

  private async executeAgentDelete(job: Job): Promise<void> {
    const data = readAgentDeleteJobData(job);

    if (data.organizationId !== job.organization_id) {
      throw new Error(
        `Organization ID mismatch: job.data.organizationId (${data.organizationId}) !== job.organization_id (${job.organization_id})`,
      );
    }

    logger.info("[provisioning-jobs] Executing agent_delete", {
      jobId: job.id,
      agentId: data.agentId,
    });

    const delResult = await elizaSandboxService.executeDeletion(data.agentId, data.organizationId);

    if (!delResult.success) {
      // Persist a partial result and rethrow so the jobs runner counts an
      // attempt and retries (or marks failed on exhaustion).
      await jobsRepository.update(job.id, {
        result: agentDeleteJobResultToRecord({
          cloudAgentId: data.agentId,
          containerStopped: delResult.containerStopped,
          rowDeleted: false,
          error: delResult.error,
        }),
      });
      throw new Error(delResult.error ?? "Unknown agent_delete failure");
    }

    const jobResult: AgentDeleteJobResult = {
      cloudAgentId: data.agentId,
      containerStopped: delResult.containerStopped,
      rowDeleted: true,
    };

    await jobsRepository.updateStatus(job.id, "completed", {
      result: agentDeleteJobResultToRecord(jobResult),
      completed_at: new Date(),
    });

    if (job.webhook_url) {
      await this.fireWebhook(job, jobResult);
    }

    logger.info("[provisioning-jobs] agent_delete completed", {
      jobId: job.id,
      agentId: data.agentId,
      containerStopped: delResult.containerStopped,
    });
  }

  private async executeAgentProvision(job: Job): Promise<void> {
    const data = readAgentProvisionJobData(job);

    // Cross-check: the org ID stored in the JSONB payload must match the
    // first-class organization_id column. A mismatch indicates either a bug
    // in the enqueue path or data tampering.
    if (data.organizationId !== job.organization_id) {
      throw new Error(
        `Organization ID mismatch: job.data.organizationId (${data.organizationId}) !== job.organization_id (${job.organization_id})`,
      );
    }

    logger.info("[provisioning-jobs] Executing agent_provision", {
      jobId: job.id,
      agentId: data.agentId,
    });

    const provResult = await elizaSandboxService.provision(data.agentId, data.organizationId);

    if (!provResult.success) {
      await jobsRepository.update(job.id, {
        result: agentProvisionJobResultToRecord({
          cloudAgentId: data.agentId,
          status: provResult.sandboxRecord?.status ?? "error",
          error: provResult.error,
        }),
      });
      throw new Error(provResult.error);
    }

    const jobResult: AgentProvisionJobResult = {
      cloudAgentId: data.agentId,
      status: provResult.sandboxRecord.status,
      bridgeUrl: provResult.bridgeUrl,
      healthUrl: provResult.healthUrl,
    };

    await jobsRepository.updateStatus(job.id, "completed", {
      result: agentProvisionJobResultToRecord(jobResult),
      completed_at: new Date(),
    });

    if (job.webhook_url) {
      await this.fireWebhook(job, jobResult);
    }

    logger.info("[provisioning-jobs] agent_provision completed", {
      jobId: job.id,
      agentId: data.agentId,
      status: provResult.sandboxRecord.status,
    });
  }

  /**
   * Drive heartbeats for every running sandbox. The on-prem worker calls this
   * each cycle so last_heartbeat_at stays fresh and unreachable agents flip
   * to disconnected. Heartbeats are HTTP fetches over the Headscale tunnel,
   * so this only runs from the Node sidecar (not from the Cloudflare Worker).
   */
  async processRunningHeartbeats(concurrency = 5): Promise<HeartbeatResult> {
    const running = await agentSandboxesRepository.listRunning();
    const total = running.length;
    if (total === 0) return { total: 0, succeeded: 0, failed: 0 };

    let succeeded = 0;
    let failed = 0;
    const queue = [...running];
    const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
      while (true) {
        const r = queue.shift();
        if (!r) break;
        const ok = await elizaSandboxService
          .heartbeat(r.id, r.organization_id)
          .catch((error: unknown) => {
            logger.warn("[provisioning-jobs] heartbeat threw", {
              agentId: r.id,
              error: error instanceof Error ? error.message : String(error),
            });
            return false;
          });
        if (ok) succeeded += 1;
        else failed += 1;
      }
    });
    await Promise.all(workers);

    return { total, succeeded, failed };
  }

  private async recoverStaleJobs(
    jobTypes: readonly ProvisioningJobType[] = Object.values(JOB_TYPES),
  ): Promise<number> {
    let totalRecovered = 0;

    // Recover stale jobs per type across all organizations. The repository now
    // handles org-agnostic recovery, so we can do this in one pass.
    for (const jobType of jobTypes) {
      const recovered = await jobsRepository.recoverStaleJobs({
        type: jobType,
        staleThresholdMs: 5 * 60 * 1000, // 5 minutes
        maxAttempts: 3,
      });
      totalRecovered += recovered;
    }

    return totalRecovered;
  }

  private async fireWebhook(
    job: Job,
    result:
      | AgentProvisionJobResult
      | AgentDeleteJobResult
      | AgentSuspendJobResult
      | AgentResumeJobResult
      | AgentRestartJobResult
      | AgentLogsJobResult
      | AgentSnapshotJobResult
      | AgentUpgradeJobResult,
  ): Promise<void> {
    if (!job.webhook_url) return;

    try {
      const safeWebhookUrl = await assertSafeOutboundUrl(job.webhook_url);

      // Only the waifu receiver gets the signed waifu envelope. Other webhook
      // consumers keep the original unsigned payload shape and never see the
      // shared HMAC signature, so we cannot break or leak anything to a
      // non-waifu callback URL.
      const completedAt = new Date().toISOString();
      const waifuTarget = resolveWaifuWebhookTarget();
      const isWaifuTarget =
        waifuTarget != null && isWaifuWebhookTargetUrl(safeWebhookUrl, waifuTarget);

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      let rawBody: string;

      if (isWaifuTarget && waifuTarget) {
        // Match the waifu signed-webhook envelope so the receiver accepts the
        // delivery instead of rejecting it as unsigned. Waifu verifies an
        // HMAC-SHA256 over `${timestamp}.${rawBody}` and requires a stable
        // idempotencyKey. Without this the provision-complete callback was
        // silently 401'd by waifu.
        const agentId =
          "cloudAgentId" in result && typeof result.cloudAgentId === "string"
            ? result.cloudAgentId
            : null;
        rawBody = JSON.stringify({
          event: "job.completed",
          timestamp: completedAt,
          agentId,
          idempotencyKey: `job:${job.id}`,
          data: {
            jobId: job.id,
            type: job.type,
            status: "completed",
            result,
            completedAt,
          },
        });
        headers["X-Waifu-Webhook-Signature"] = signWaifuWebhook(
          rawBody,
          completedAt,
          waifuTarget.secret,
        );
      } else {
        // Preserve the original payload shape for non-waifu consumers.
        rawBody = JSON.stringify({
          event: "job.completed",
          jobId: job.id,
          type: job.type,
          status: "completed",
          result,
          completedAt,
        });
      }

      const response = await fetch(safeWebhookUrl, {
        method: "POST",
        headers,
        body: rawBody,
        signal: AbortSignal.timeout(10_000),
      });

      await jobsRepository.update(job.id, {
        webhook_status: response.ok ? "delivered" : `failed_${response.status}`,
      });

      if (!response.ok) {
        logger.warn("[provisioning-jobs] Webhook delivery failed", {
          jobId: job.id,
          webhookUrl: safeWebhookUrl.toString(),
          status: response.status,
        });
      }
    } catch (err) {
      logger.error("[provisioning-jobs] Webhook delivery error", {
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      });

      await jobsRepository.update(job.id, {
        webhook_status: "error",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeartbeatResult {
  total: number;
  succeeded: number;
  failed: number;
}

export interface ProcessingResult {
  claimed: number;
  succeeded: number;
  failed: number;
  errors: Array<{ jobId: string; error: string }>;
}

// Singleton
export const provisioningJobService = new ProvisioningJobService();
