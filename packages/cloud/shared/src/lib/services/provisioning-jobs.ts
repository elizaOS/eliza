/**
 * Async Provisioning Job Service
 *
 * Bridges the existing `jobs` table/repository with provisioning operations.
 * Instead of blocking HTTP requests for minutes, callers create a job and
 * return 202 immediately. A cron-based processor picks up pending jobs.
 *
 * Supported job types:
 * - agent_provision: Provision an Agent sandbox (managed DB + Docker container)
 *
 * Future:
 * - wallet_provision: Server wallet provisioning
 * - agent_restore: Restore from backup
 */

import { and, desc, eq, ne, type SQL, sql } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { dbWrite } from "../../db/helpers";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import {
  hydrateJob,
  type Job,
  jobsRepository,
  type NewJob,
  prepareJobInsertData,
} from "../../db/repositories/jobs";
import {
  agentSandboxes,
  UPGRADE_FAILURE_TARGET_MARKER_PREFIX,
} from "../../db/schemas/agent-sandboxes";
import { apps } from "../../db/schemas/apps";
import { containers } from "../../db/schemas/containers";
import { jobs } from "../../db/schemas/jobs";
import { ApiError } from "../api/cloud-worker-errors";
import { assertSafeOutboundUrl } from "../security/outbound-url";
import { safeFetch } from "../security/safe-fetch";
import { logger } from "../utils/logger";
import { isValidUUID } from "../utils/validation";
import { withTimeout } from "../utils/with-timeout";
import { dispatchAppDbDeprovisionJob } from "./app-db-deprovision-job-service";
import { dispatchAppDeployJob, readAppDeployJobData } from "./app-deploy-job-service";
import { appsService } from "./apps";
import { dispatchContainerJob, getContainerExecutorDeps } from "./container-job-service";
import { readContainerProvisionJobData } from "./container-jobs-data";
import { dispatchContainerStopJob } from "./container-stop-job-service";
import { elizaProvisionAdvisoryLockSql } from "./eliza-provision-lock";
import { elizaSandboxService, SNAPSHOT_ENDPOINT_UNSUPPORTED } from "./eliza-sandbox";
import { JOB_TYPES, type ProvisioningJobType } from "./provisioning-job-types";
import {
  isWaifuWebhookTargetUrl,
  resolveWaifuWebhookTarget,
  signWaifuWebhook,
} from "./waifu-webhook";
import {
  WakeRestoreIntegrityError,
  type WakeRestoreIntegrityFailure,
} from "./wake-restore-integrity";

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
  /**
   * Explicit user-selected restore point (an older validated backup) — the
   * escape hatch when the latest backup fails the wake integrity gate. Never
   * set by default; mutually exclusive with `forceFreshBoot`.
   */
  restoreBackupId?: string;
  /**
   * Explicit user acceptance of data loss: wake into an empty container with
   * no restore. Never set by default; mutually exclusive with `restoreBackupId`.
   */
  forceFreshBoot?: boolean;
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

export interface AgentDowngradeJobData {
  agentId: string;
  organizationId: string;
  userId: string;
  /** Configured image tag/ref (must match the agent's `docker_image`). */
  dockerImage: string;
  /** sha256 the agent is currently on — the rollback precondition guard. */
  fromDigest: string;
}

export interface AgentUpgradeJobResult {
  oldNodeId: string;
  oldContainerName: string;
  newNodeId: string;
  newContainerName: string;
  newDigest: string;
  durationMs: number;
}

export interface AgentDowngradeJobResult {
  oldNodeId: string;
  oldContainerName: string;
  newNodeId: string;
  newContainerName: string;
  /** The `previous_image_digest` the agent was rolled back onto. */
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
  /** True when the wake booted empty via the explicit `forceFreshBoot` opt-in. */
  freshBoot?: boolean;
  /** Structured wake-integrity-gate failure, surfaced to job pollers. */
  integrityFailure?: WakeRestoreIntegrityFailure;
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
  /** True when an auto snapshot was a terminal no-op (agent had no live state). */
  skipped?: boolean;
  /** Human-readable reason for a skip (e.g. "Sandbox is not running"). */
  reason?: string;
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

function agentDowngradeJobDataToRecord(data: AgentDowngradeJobData): Record<string, unknown> {
  return { ...data };
}

function agentDowngradeJobResultToRecord(result: AgentDowngradeJobResult): Record<string, unknown> {
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

function isAgentDowngradeJobData(value: unknown): value is AgentDowngradeJobData {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.agentId === "string" &&
    typeof v.organizationId === "string" &&
    typeof v.userId === "string" &&
    typeof v.dockerImage === "string" &&
    typeof v.fromDigest === "string"
  );
}

export function readAgentDowngradeJobData(job: Job): AgentDowngradeJobData {
  if (!isAgentDowngradeJobData(job.data)) {
    throw new Error(`Invalid agent downgrade job data for job ${job.id}`);
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
   * Called with the hydrated existing job when an active pending/in_progress
   * job of the same type would be reused instead of inserting a new row.
   * Throw to refuse the enqueue — reuse silently DROPS the caller's job data,
   * so operation-changing params (wake's restoreBackupId/forceFreshBoot) must
   * either match the in-flight job or be rejected loudly (#15603 B6).
   */
  validateReuse?: (existing: Job) => void;
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
}

/**
 * Parse a positive-integer millisecond value from an env var, falling back to
 * `fallback` when the var is unset, non-numeric, or non-positive.
 */
function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Hard ceiling on a single job's execution. A slow agent_delete (SSH +
 * headscale network I/O while holding a DB advisory lock) used to run for
 * minutes and starve the whole cycle. Every leaf is independently bounded, so
 * a job hitting this ceiling means something is genuinely wedged.
 *
 * 300s default (env-overridable via `PROVISION_JOB_TIMEOUT_MS`), not 120s: a
 * freshly-pinned agent image cold-pulls in ~2.5 min on the node, and the leaf
 * SSH `docker pull` itself allows up to `PULL_TIMEOUT_MS` = 300s in
 * docker-sandbox-provider. At the old 120s this wrapper aborted the awaiter
 * mid-pull, so the job flipped toward failure even though the pull was still
 * landing the image in the node cache — retry churn + the half-provisioned
 * state behind the tonight outage. Matching the leaf `PULL_TIMEOUT_MS` (300s)
 * means the wrapper never cuts a still-progressing cold pull short. This is the
 * value 0xSolace set on the live box while working the outage; the env override
 * lets ops retune without a redeploy.
 *
 * This is WATCHDOG-SAFE and stays OFF the heartbeat critical path. On the
 * watchdog's critical path the per-job awaiter runs INSIDE the daemon's
 * `runBoundedPhase("cycle")`, itself capped at `PHASE_TIMEOUT_MS` (60s): if a
 * job runs longer, the phase frees the *cycle* awaiter at 60s, advances
 * `lastCycleCompletedAt`, and the heartbeat keeps flowing — REGARDLESS of
 * `PER_JOB_TIMEOUT_MS`. This constant governs only the detached background job
 * promise (the leaf SSH/HTTP I/O keeps running until it resolves or hits this
 * ceiling), NOT the watchdog clock. The watchdog invariant
 * (`WORK_CYCLE_TIMEOUT_MS` 240s + poll 30s < `WATCHDOG_MAX_CYCLE_MS` 300s) does
 * not reference this value at all, so raising it past `WORK_CYCLE_TIMEOUT_MS`
 * cannot violate the invariant — the real ceiling that matters is the leaf
 * `PULL_TIMEOUT_MS` (300s), which this matches.
 */
export const PER_JOB_TIMEOUT_MS = parsePositiveIntEnv(
  process.env.PROVISION_JOB_TIMEOUT_MS,
  300_000,
);

/**
 * Stale-job recovery thresholds, by job type. `recoverStaleJobs` resets a job
 * stuck `in_progress` past this window back to `pending` — the backstop for a
 * crashed worker. The threshold MUST exceed the job's real worst-case
 * wall-clock, or it false-positives a still-running job and re-claims it.
 *
 * The cold-boot job types (provision / resume / wake / restart / upgrade) run
 * the full image-pull + agent-boot path, which legitimately takes up to ~11 min
 * (docker-sandbox-provider `PULL_TIMEOUT_MS` 5m + `HEALTH_CHECK_TIMEOUT_MS` 6m)
 * before `/api/health` answers. At the old flat 5-min threshold a slow cold
 * provision was reset mid-flight, re-claimed, and the second provision collided
 * on the deterministic container name (`agent-<id>`) and force-removed the
 * still-booting container — provision flapping + orphaned containers on the
 * exact cold-start path every new user hits. 15 min clears the worst case with
 * margin; fast ops keep the tight 5-min backstop. (`trySetProvisioning`
 * deliberately admits a `provisioning` row and defers to this as the time gate,
 * so this threshold is the single source of truth for "provision is stuck".)
 */
const DEFAULT_STALE_JOB_THRESHOLD_MS = 5 * 60 * 1000;
const COLD_BOOT_STALE_JOB_THRESHOLD_MS = 15 * 60 * 1000;
const COLD_BOOT_JOB_TYPES: ReadonlySet<ProvisioningJobType> = new Set([
  JOB_TYPES.AGENT_PROVISION,
  JOB_TYPES.AGENT_RESUME,
  JOB_TYPES.AGENT_WAKE,
  JOB_TYPES.AGENT_RESTART,
  JOB_TYPES.AGENT_UPGRADE,
  JOB_TYPES.AGENT_DOWNGRADE,
]);
const PROVISION_TRANSPORT_RETRY_DELAY_MS = 2 * 60 * 1000;

/**
 * Per-job execution timeout for the `withTimeout(executeJob(job), …)` wrap,
 * BY JOB TYPE (#10919).
 *
 * The flat `PER_JOB_TIMEOUT_MS` (300s) matches only the leaf `docker pull`
 * ceiling — NOT a full cold boot, which is image-pull (`PULL_TIMEOUT_MS` 300s) +
 * agent health-check (`HEALTH_CHECK_TIMEOUT_MS` 360s) ≈ up to 11 min. At the flat
 * 300s, a legitimate slow cold provision had its awaiter rejected mid-boot; the
 * catch's `incrementAttempt` flipped the still-running job to `pending`, a later
 * poll re-claimed it (nothing blocks a non-`in_progress` re-claim), and the
 * second provision collided on the deterministic `agent-<id>` name and
 * force-removed the first still-booting container — provision flapping on the
 * exact cold-start path every new dedicated agent hits.
 *
 * Cold-boot job types therefore get the same 15-min budget `recoverStaleJobs`
 * already uses, so the per-job wrap can't fire before a legitimate cold boot
 * finishes (15 min > ~11 min). Fast ops keep the tight 300s. This is the wrap's
 * counterpart to the stale-recovery threshold — both are now cold-boot-aware.
 */
export function resolvePerJobTimeoutMs(jobType: string): number {
  return COLD_BOOT_JOB_TYPES.has(jobType as ProvisioningJobType)
    ? Math.max(PER_JOB_TIMEOUT_MS, COLD_BOOT_STALE_JOB_THRESHOLD_MS)
    : PER_JOB_TIMEOUT_MS;
}

/**
 * Machine-readable trailer appended to `agent_sandboxes.error_message` when an
 * AGENT_UPGRADE exhausts retries on a ROLLBACK-SAFE failure (the old container
 * still serves). Encodes the exhausted TARGET digest so the fleet reconciler
 * can re-arm the agent when a NEWER target digest is published, instead of
 * excluding the row from all future upgrades forever. Kept in error_message to
 * avoid a schema migration (mission constraint) while staying strictly
 * additive: pre-existing rows have no trailer and parse to `null`.
 *
 * Format (single line, trailer at END so the human-readable cause stays first):
 *   `<human message> [upgrade-failed-target:<digest>]`
 * `<digest>` is the resolved sha256 target ref; `unknown` when the exhausted
 * job carried no target digest (defensive). The prefix constant lives in the
 * schema layer (`UPGRADE_FAILURE_TARGET_MARKER_PREFIX`) so the reconciler query
 * can share it without a service↔repository import cycle.
 */
export function buildUpgradeFailureMarker(
  maxAttempts: number,
  cause: string,
  toDigest: string | null,
): string {
  const target = toDigest && toDigest.length > 0 ? toDigest : "unknown";
  return `Upgrade permanently failed after ${maxAttempts} attempts: ${cause} ${UPGRADE_FAILURE_TARGET_MARKER_PREFIX}${target}]`;
}

/**
 * Parse the exhausted TARGET digest out of a rollback-safe upgrade-failure
 * error_message. Returns null when no trailer is present (a non-upgrade error,
 * a pre-existing row, or an `unknown` target), so callers treat "no recorded
 * target" as "do not re-arm on target change" (conservative).
 */
export function parseUpgradeFailureTargetDigest(errorMessage: string | null): string | null {
  if (!errorMessage) return null;
  const start = errorMessage.lastIndexOf(UPGRADE_FAILURE_TARGET_MARKER_PREFIX);
  if (start === -1) return null;
  const from = start + UPGRADE_FAILURE_TARGET_MARKER_PREFIX.length;
  const end = errorMessage.indexOf("]", from);
  if (end === -1) return null;
  const digest = errorMessage.slice(from, end);
  return digest === "unknown" || digest.length === 0 ? null : digest;
}

/**
 * Thrown by `executeAgentUpgrade` when `executeUpgrade` reports a failure,
 * carrying the rollback-safe classification through the worker's generic
 * catch → `incrementAttempt` → `buildPermanentFailureWriteback` path.
 *
 * `rolledBack === true` means the OLD container is still serving (a
 * rollback-safe failure); the permanent-failure writeback must NOT mark the
 * sandbox terminal. `rolledBack === false` means the agent is genuinely not
 * serving on the old container, so the terminal error writeback is correct.
 * `toDigest` is the target the exhausted upgrade was aiming at, recorded so
 * the reconciler can re-arm the agent when a NEWER target digest is published
 * (a rollback-safe exclusion must not be permanent — always-on agents that hit
 * a transient rollback-safe failure must still receive future security
 * patches). See #15357 / lalalune's #15311 review.
 */
export class UpgradeFailedError extends Error {
  readonly rolledBack: boolean;
  readonly toDigest: string;
  constructor(message: string, opts: { rolledBack: boolean; toDigest: string }) {
    super(message);
    this.name = "UpgradeFailedError";
    this.rolledBack = opts.rolledBack;
    this.toDigest = opts.toDigest;
  }
}

class RetryableProvisionTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableProvisionTransportError";
  }
}

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
        const hydrated = await hydrateJob(existing);
        opts.validateReuse?.(hydrated);
        logger.info(`[provisioning-jobs] Reusing active ${opts.logName} job`, {
          jobId: existing.id,
          ...logFields,
        });
        return { job: hydrated, created: false };
      }

      await opts.beforeInsert?.(tx, sandbox);

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
      // DB assignment + Docker pull/run (10-30s) + health check (up to 60s)
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
      beforeInsert: async (tx, sandbox) => {
        // A genuine user-initiated delete (the row is not already in a deletion
        // state) starts the deletion-failure counter fresh — error_count may
        // carry a stale provisioning-error value, and a new delete should get a
        // full set of recovery sweeps before the circuit-breaker abandons it.
        // A recovery re-enqueue (status is already deletion_pending/_failed)
        // PRESERVES the count so reEnqueueFailedDeletions can stop the loop.
        const isRecoveryReEnqueue =
          sandbox.status === "deletion_pending" || sandbox.status === "deletion_failed";
        await tx
          .update(agentSandboxes)
          .set({
            status: "deletion_pending" as const,
            ...(isRecoveryReEnqueue ? {} : { error_count: 0 }),
            updated_at: new Date(),
          })
          .where(eq(agentSandboxes.id, params.agentId));

        // Cancel any OTHER lifecycle jobs still queued for this agent. Delete
        // wins: a pending restart/wake/resume/etc. that runs after the row is
        // flipped to deletion_pending (or deleted) would either re-provision a
        // container we are tearing down or fail noisily. Marking them
        // `cancelled` (a terminal status claimPendingJobs/recoverStaleJobs
        // never touch) drops them cleanly and keeps them auditable. The
        // agent_delete row itself is inserted right after this and is excluded
        // by type, so it is never self-cancelled.
        const cancelled = await tx
          .update(jobs)
          .set({ status: "cancelled", updated_at: new Date() })
          .where(
            and(
              eq(jobs.organization_id, params.organizationId),
              eq(jobs.agent_id, params.agentId),
              ne(jobs.type, JOB_TYPES.AGENT_DELETE),
              sql`${jobs.status} IN ('pending', 'in_progress')`,
            ),
          )
          .returning({ id: jobs.id });
        if (cancelled.length > 0) {
          logger.info("[provisioning-jobs] Cancelled pending jobs superseded by agent_delete", {
            agentId: params.agentId,
            orgId: params.organizationId,
            cancelledCount: cancelled.length,
          });
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
      toRecord: agentWakeJobDataToRecord,
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      maxAttempts: 3,
      // Fresh provision (~60-90s) + state restore.
      estimatedDurationMs: 90_000,
      logName: "agent_wake",
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
      toRecord: agentDowngradeJobDataToRecord,
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
          // Only enqueue agents that are actually reachable. A `running` row with
          // no bridge_url (shared-runtime / web-only agents, or a row whose
          // bridge was cleared) has no live state endpoint to snapshot — the
          // snapshot would just fail with "Sandbox is not running" and burn
          // retries. Requiring bridge_url keeps those out of the queue entirely.
          sql`${agentSandboxes.bridge_url} IS NOT NULL`,
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
      retried: 0,
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

  /**
   * One-shot startup recovery for jobs claimed by a previous worker process.
   * Normal stale recovery deliberately waits longer than a full cold boot; on
   * daemon replacement, rows claimed before this process started cannot still
   * be owned by this process, so the singleton worker may make them retryable
   * immediately instead of leaving agents stuck in `provisioning` until the
   * cold-boot stale threshold expires.
   */
  async recoverInterruptedJobsOnStartup(
    startedBefore: Date,
    jobTypes: readonly ProvisioningJobType[] = Object.values(JOB_TYPES),
  ): Promise<number> {
    let totalRecovered = 0;

    for (const jobType of jobTypes) {
      const recovered = await jobsRepository.recoverInProgressJobsStartedBefore({
        type: jobType,
        startedBefore,
      });
      totalRecovered += recovered;
    }

    return totalRecovered;
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
        // recoverStaleJobs is the backstop. The timeout is BY JOB TYPE
        // (resolvePerJobTimeoutMs): cold-boot types get the full ~11-min boot
        // budget so a slow cold provision is not rejected mid-boot → no
        // premature incrementAttempt → no re-claim → no double-provision (#10919).
        await withTimeout(
          this.executeJob(job),
          resolvePerJobTimeoutMs(job.type),
          `job ${job.type}`,
        );
        result.succeeded++;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        result.errors.push({ jobId: job.id, error: errorMsg });

        if (err instanceof RetryableProvisionTransportError) {
          result.retried++;
          await jobsRepository.retryLaterWithoutIncrementingAttempts(
            job.id,
            errorMsg,
            PROVISION_TRANSPORT_RETRY_DELAY_MS,
          );
          logger.warn("[provisioning-jobs] Requeued retryable provision transport failure", {
            jobId: job.id,
            delayMs: PROVISION_TRANSPORT_RETRY_DELAY_MS,
            error: errorMsg,
          });
          continue;
        }

        result.failed++;

        // When retries are exhausted (permanent failure) the dependent
        // status row must flip too — and it must flip ATOMICALLY with the
        // job-status `failed` write, not in a best-effort follow-up that can
        // silently swallow. A separate write that fails leaves the sandbox
        // stuck in "provisioning" until the 10-min stuck-recovery cron
        // (markStuckProvisioningWithoutActiveJobAsError) catches it. Folding
        // the dependent flip into incrementAttempt's transaction via
        // `onFailedInTx` makes both commit together (or roll back together,
        // so the recovery cron re-runs the whole thing). The cron stays as
        // the backstop, never the primary signal.
        // Rollback-safe classification only exists for AGENT_UPGRADE failures
        // (thrown as UpgradeFailedError). For every other job type this is
        // undefined and the writeback ignores it.
        const upgradeFailure = err instanceof UpgradeFailedError ? err : undefined;
        const onFailedInTx = this.buildPermanentFailureWriteback(job, errorMsg, upgradeFailure);
        const updated = await jobsRepository.incrementAttempt(
          job.id,
          errorMsg,
          job.max_attempts,
          onFailedInTx,
        );

        // app_deploy keeps a post-commit cache invalidation (the apps read
        // cache is invalidated outside the DB transaction); the row flip
        // itself already committed atomically inside onFailedInTx above.
        if (updated?.status === "failed" && job.type === JOB_TYPES.APP_DEPLOY) {
          const { appId } = readAppDeployJobData(job);
          await appsService.invalidateCache(appId);
        }
        // container_provision flips apps.deployment_status with a raw in-tx
        // update (bypassing the appsService cache), so evict the app read cache
        // here too — otherwise the cache-backed deploy-status route keeps
        // reporting `building` until the 5-min TTL. The in-tx writeback already
        // org-scoped the flip; an appId that matched no app is a harmless evict.
        if (updated?.status === "failed" && job.type === JOB_TYPES.CONTAINER_PROVISION) {
          const { containerId } = readContainerProvisionJobData(job);
          const [row] = await dbWrite
            .select({ projectName: containers.project_name })
            .from(containers)
            .where(eq(containers.id, containerId))
            .limit(1);
          const appId = row?.projectName;
          if (appId && isValidUUID(appId)) {
            await appsService.invalidateCache(appId);
          }
        }
      }
    }
  }

  /**
   * Builds the in-transaction dependent-row writeback for a job that has just
   * exhausted its retries. Returned callback runs INSIDE incrementAttempt's
   * transaction (atomic with the job-status `failed` flip). Returns undefined
   * for job types that have no dependent status row to flip.
   */
  private buildPermanentFailureWriteback(
    job: Job,
    errorMsg: string,
    upgradeFailure?: UpgradeFailedError,
  ): ((tx: DbTransaction, failedJob: Job) => Promise<void>) | undefined {
    switch (job.type) {
      // Mark the sandbox "error" so the UI reflects reality instead of staying
      // stuck in "provisioning".
      case JOB_TYPES.AGENT_PROVISION: {
        const { agentId } = readAgentProvisionJobData(job);
        return async (tx) => {
          await tx
            .update(agentSandboxes)
            .set({
              status: "error",
              error_message: `Provisioning permanently failed after ${job.max_attempts} attempts: ${errorMsg}`,
              updated_at: new Date(),
            })
            .where(eq(agentSandboxes.id, agentId));
          logger.warn("[provisioning-jobs] Marked sandbox as error after permanent failure", {
            jobId: job.id,
            agentId,
          });
        };
      }
      // A permanently-exhausted AGENT_UPGRADE is NOT uniformly terminal. Most
      // upgrade failures are ROLLBACK-SAFE (blue provision/health/digest/runtime
      // /snapshot/swap failures) — executeUpgrade never tears down the OLD
      // container before a successful atomic swap, so the agent keeps serving on
      // its previous version. Marking such a row `status:"error"` would (1) make
      // the dedicated proxy reject live traffic (dedicated-agent-proxy.ts) and
      // (2) expose the still-live container to the orphan reconciler
      // (docker-node-workloads.ts) — killing a healthy agent. So:
      //   - rollback-safe (default, and the only genuinely-safe failure class):
      //     keep `status:"running"`, record the failure + the exhausted target
      //     digest in error_message so the reconciler stops re-enqueuing the
      //     SAME doomed target, WITHOUT declaring the live sandbox terminal.
      //     Encoding the target digest lets the reconciler re-arm the agent for
      //     a NEWER target (see listRunningWithDigestOtherThan) so a transient
      //     rollback-safe failure never permanently freezes an always-on agent
      //     out of future security patches.
      //   - genuinely-dead (rolledBack === false, e.g. the agent was already not
      //     running): keep the terminal `status:"error"` writeback, mirroring
      //     AGENT_PROVISION, so the UI reflects reality.
      case JOB_TYPES.AGENT_UPGRADE: {
        const upgradeData = readAgentUpgradeJobData(job);
        const { agentId } = upgradeData;
        // Classification is carried on the thrown UpgradeFailedError. Absent it
        // (defensive: an upgrade that failed via the outer worker path — a
        // withTimeout(...) wrap or an unexpected throw BEFORE executeUpgrade
        // returns success:false — so no UpgradeFailedError is constructed),
        // default to rollback-safe: never error a possibly-live agent on an
        // unknown cause. Fall back to the job's own target digest (always
        // present in the job data) so the re-armable marker still records the
        // EXACT exhausted target — otherwise the reconciler's target-scoped
        // skip would immediately re-enqueue the same doomed target and recreate
        // the retry storm this marker prevents (codex #15357 P2).
        const rolledBack = upgradeFailure?.rolledBack ?? true;
        // Prefer the classification's target, but treat an empty/absent error
        // digest as "not carried" and fall back to the job's own target (always
        // present, validated by readAgentUpgradeJobData) so the re-armable marker
        // ALWAYS records the EXACT exhausted target. A `??` alone would let an
        // empty-string error digest through and degrade the marker to "unknown".
        const errorDigest = upgradeFailure?.toDigest;
        const toDigest =
          errorDigest && errorDigest.length > 0 ? errorDigest : upgradeData.toDigest || null;
        if (!rolledBack) {
          // Genuinely-dead old container: terminal, like AGENT_PROVISION.
          return async (tx) => {
            await tx
              .update(agentSandboxes)
              .set({
                status: "error",
                error_message: `Upgrade permanently failed after ${job.max_attempts} attempts (agent not serving): ${errorMsg}`,
                updated_at: new Date(),
              })
              .where(eq(agentSandboxes.id, agentId));
            logger.warn(
              "[provisioning-jobs] Marked sandbox error after permanent upgrade failure on a non-serving agent",
              { jobId: job.id, agentId },
            );
          };
        }
        // Rollback-safe: keep the agent running, record a re-armable marker.
        return async (tx) => {
          await tx
            .update(agentSandboxes)
            .set({
              error_message: buildUpgradeFailureMarker(job.max_attempts, errorMsg, toDigest),
              updated_at: new Date(),
            })
            .where(and(eq(agentSandboxes.id, agentId), eq(agentSandboxes.status, "running")));
          logger.warn(
            "[provisioning-jobs] Recorded rollback-safe upgrade failure without marking sandbox terminal",
            { jobId: job.id, agentId, failedTargetDigest: toDigest },
          );
        };
      }
      // Apps / Product 2: a permanently failed deploy must flip the app off
      // `building`, or the deploy-status route (which echoes
      // `apps.deployment_status`) reports BUILDING forever — the CLI/dashboard
      // never sees the failure. The read-cache invalidation runs post-commit
      // in the caller (cache work must not live inside a DB transaction).
      // Especially relevant during the lane-migration window, when the agent
      // CP worker (still default=all lanes) claims an APP_DEPLOY it can't run
      // and exhausts retries.
      case JOB_TYPES.APP_DEPLOY: {
        const { appId } = readAppDeployJobData(job);
        return async (tx) => {
          await tx
            .update(apps)
            .set({ deployment_status: "failed", updated_at: new Date() })
            .where(eq(apps.id, appId));
          logger.warn(
            "[provisioning-jobs] Marked app deployment as failed after permanent failure",
            { jobId: job.id, appId },
          );
        };
      }
      // Apps / Product 2: the APP_DEPLOY job above only self-completes after
      // enqueuing the real CONTAINER_PROVISION, so a SUCCESSFUL deploy that then
      // fails to provision its container exhausts retries HERE — and would
      // otherwise strand the app in `building` forever (the success path's
      // markAppDeployed is the only other writer of deployment_status). The
      // app-deploy container is created with `project_name = appId` AND
      // `organization_id = app.organization_id` (app-deploy-runner), so the app
      // id and owning org both live on the container row. Unlike markAppDeployed
      // — which only runs inside the apps container backend — this writeback
      // fires for EVERY CONTAINER_PROVISION job, including plain/coding
      // /v1/containers rows whose `project_name` is a user-supplied slug that can
      // be made to look like a UUID. So we (1) require a real UUID and (2) scope
      // the flip to the container's OWN organization: a user can never name a
      // container after ANOTHER tenant's app id and flip that app to `failed`,
      // because the cross-org WHERE matches zero rows.
      case JOB_TYPES.CONTAINER_PROVISION: {
        const { containerId } = readContainerProvisionJobData(job);
        return async (tx) => {
          const [row] = await tx
            .select({
              projectName: containers.project_name,
              organizationId: containers.organization_id,
            })
            .from(containers)
            .where(eq(containers.id, containerId))
            .limit(1);
          const appId = row?.projectName;
          if (!appId || !isValidUUID(appId)) return;
          await tx
            .update(apps)
            .set({ deployment_status: "failed", updated_at: new Date() })
            .where(and(eq(apps.id, appId), eq(apps.organization_id, row.organizationId)));
          logger.warn(
            "[provisioning-jobs] Marked app deployment as failed after container provision permanent failure",
            { jobId: job.id, containerId, appId },
          );
        };
      }
      // agent_delete: when the daemon gives up, flip the row to
      // `deletion_failed` so ops can see the stuck sandboxes (and the container
      // that probably survived on the core) instead of leaving the row stuck in
      // `deletion_pending` forever.
      case JOB_TYPES.AGENT_DELETE: {
        const { agentId } = readAgentDeleteJobData(job);
        return async (tx) => {
          // Bump error_count so reEnqueueFailedDeletions can circuit-break a
          // permanently-dead node: each exhausted agent_delete adds one, and
          // once the count crosses the re-enqueue threshold the sweep stops
          // re-arming the row and alerts ops instead of looping forever. Once a
          // row reaches deletion_failed the only writer of error_count is this
          // path (markError only touches `error` rows), so the count tracks
          // failed delete sweeps. A fresh user-initiated delete resets it.
          await tx
            .update(agentSandboxes)
            .set({
              status: "deletion_failed",
              error_message: `Deletion permanently failed after ${job.max_attempts} attempts: ${errorMsg}`,
              error_count: sql`${agentSandboxes.error_count} + 1`,
              updated_at: new Date(),
            })
            .where(eq(agentSandboxes.id, agentId));
          logger.warn(
            "[provisioning-jobs] Marked sandbox as deletion_failed after permanent failure",
            { jobId: job.id, agentId },
          );
        };
      }
      default:
        return undefined;
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
      case JOB_TYPES.AGENT_DOWNGRADE:
        await this.executeAgentDowngrade(job);
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
      //
      // Self-mark completed on success so recoverStaleJobs() can't re-sweep a
      // slow-but-successful job back to `pending` (the same foot-gun the
      // AGENT_* arms and APP_DB_DEPROVISION already close): a CONTAINER_PROVISION
      // that crosses PER_JOB_TIMEOUT_MS while the provider is still creating the
      // container would, without a terminal row, get re-claimed and provision a
      // SECOND container. The dispatchers are NOT all idempotent across separate
      // successful runs; a terminal row is the only safe gate.
      case JOB_TYPES.CONTAINER_PROVISION:
      case JOB_TYPES.CONTAINER_DELETE:
      case JOB_TYPES.CONTAINER_RESTART:
      case JOB_TYPES.CONTAINER_UPGRADE:
      case JOB_TYPES.CONTAINER_LOGS:
        await dispatchContainerJob(job, getContainerExecutorDeps());
        await jobsRepository.updateStatus(job.id, "completed", {
          completed_at: new Date(),
        });
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
      //
      // Self-mark completed on success (mirrors the AGENT_* arms). The runner is
      // NOT idempotent across separate successful runs — it ensures the tenant
      // DB, creates a `containers` row, and enqueues a CONTAINER_PROVISION. A
      // slow-but-successful deploy that crosses PER_JOB_TIMEOUT_MS would, without
      // a terminal row, get re-swept by recoverStaleJobs() and double-provision
      // (a second container row + a second CONTAINER_PROVISION). A completed row
      // is the only thing that prevents the re-sweep.
      case JOB_TYPES.APP_DEPLOY:
        await dispatchAppDeployJob(job);
        await jobsRepository.updateStatus(job.id, "completed", {
          completed_at: new Date(),
        });
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

  /**
   * Resolve a lifecycle job whose target agent no longer exists as a terminal
   * no-op instead of retrying to exhaustion. Once the agent row is gone (e.g. a
   * concurrent agent_delete completed first, or a stale in_progress job was
   * recovered after deletion), there is nothing left to suspend/resume/restart
   * /snapshot — throwing would just burn three attempts and land the job in
   * `failed`, masking the real (benign) cause. Returns true when it claimed the
   * job as completed; the caller must return early. Any other failure flows
   * through the normal retry path.
   */
  private async completeIfAgentGone(
    job: Job,
    result: { success: boolean; error?: string },
    agentId: string,
  ): Promise<boolean> {
    if (result.success || result.error !== "Agent not found") return false;
    await jobsRepository.updateStatus(job.id, "completed", {
      result: { cloudAgentId: agentId, skipped: true, reason: "Agent not found" },
      completed_at: new Date(),
    });
    logger.info("[provisioning-jobs] Job completed as no-op — agent no longer exists", {
      jobId: job.id,
      jobType: job.type,
      agentId,
    });
    return true;
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

    if (await this.completeIfAgentGone(job, result, data.agentId)) return;

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

    if (await this.completeIfAgentGone(job, result, data.agentId)) return;

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

    if (await this.completeIfAgentGone(job, result, data.agentId)) return;

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

    const result = await elizaSandboxService.executeWake(data.agentId, data.organizationId, {
      restoreBackupId: data.restoreBackupId,
      forceFreshBoot: data.forceFreshBoot,
    });

    if (await this.completeIfAgentGone(job, result, data.agentId)) return;

    if (!result.success) {
      await jobsRepository.update(job.id, {
        result: agentWakeJobResultToRecord({
          cloudAgentId: data.agentId,
          reprovisioned: result.reprovisioned,
          restoredBackupId: result.restoredBackupId,
          freshBoot: result.freshBoot,
          integrityFailure: result.integrityFailure,
          error: result.error,
        }),
      });
      // Integrity-gate refusals surface as the typed wake error so the job's
      // error_message is the full user-legible explanation (backup, failure
      // kind, escape hatches). AGENT_WAKE has no permanent-failure writeback,
      // so exhausting attempts leaves the sandbox row `sleeping` — state
      // preserved, per the #15603 B6 contract.
      if (result.integrityFailure) {
        throw new WakeRestoreIntegrityError(result.integrityFailure);
      }
      throw new Error(result.error ?? "Unknown agent_wake failure");
    }

    const jobResult: AgentWakeJobResult = {
      cloudAgentId: data.agentId,
      reprovisioned: result.reprovisioned,
      restoredBackupId: result.restoredBackupId,
      freshBoot: result.freshBoot,
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

    if (await this.completeIfAgentGone(job, result, data.agentId)) return;

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

    if (await this.completeIfAgentGone(job, result, data.agentId)) return;

    if (!result.success) {
      // Failures are visible by the row staying on the OLD image_digest; the
      // reconciler will try again on the next cycle. The worker's standard
      // error handling marks the job failed and stores this error message.
      //
      // Carry executeUpgrade's rollback-safe classification through the generic
      // catch → incrementAttempt → buildPermanentFailureWriteback path so the
      // permanent-failure writeback can distinguish a still-serving old
      // container (rollback-safe: keep `running`) from a genuinely-down agent
      // (keep the terminal error writeback). Default UNKNOWN classifications to
      // rollback-safe (`true`): erroring a still-serving agent (proxy rejects
      // live traffic + orphan reconciler reaps it) is strictly worse than
      // leaving a genuinely-dead agent non-terminal (the stuck-recovery cron is
      // the backstop for that case).
      throw new UpgradeFailedError(result.error ?? "Unknown agent_upgrade failure", {
        rolledBack: result.rolledBack ?? true,
        toDigest: data.toDigest,
      });
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

  private async executeAgentDowngrade(job: Job): Promise<void> {
    const data = readAgentDowngradeJobData(job);

    if (data.organizationId !== job.organization_id) {
      throw new Error(
        `Organization ID mismatch: job.data.organizationId (${data.organizationId}) !== job.organization_id (${job.organization_id})`,
      );
    }

    logger.info("[provisioning-jobs] Executing agent_downgrade", {
      jobId: job.id,
      agentId: data.agentId,
      dockerImage: data.dockerImage,
      fromDigest: data.fromDigest,
    });

    const startedAt = Date.now();
    const result = await elizaSandboxService.executeDowngrade(
      data.agentId,
      data.organizationId,
      data.dockerImage,
      data.fromDigest,
    );

    if (await this.completeIfAgentGone(job, result, data.agentId)) return;

    if (!result.success) {
      // Failures leave the agent on its current image (the swap is atomic and
      // only commits after the rollback container is healthy); the worker's
      // standard error handling marks the job failed with this message.
      throw new Error(result.error ?? "Unknown agent_downgrade failure");
    }

    const jobResult: AgentDowngradeJobResult = {
      oldNodeId: result.oldNodeId ?? "",
      oldContainerName: result.oldContainerName ?? "",
      newNodeId: result.newNodeId ?? "",
      newContainerName: result.newContainerName ?? "",
      newDigest: result.newDigest ?? "",
      durationMs: Date.now() - startedAt,
    };

    await jobsRepository.updateStatus(job.id, "completed", {
      result: agentDowngradeJobResultToRecord(jobResult),
      completed_at: new Date(),
    });

    if (job.webhook_url) {
      await this.fireWebhook(job, jobResult);
    }

    logger.info("[provisioning-jobs] agent_downgrade completed", {
      jobId: job.id,
      agentId: data.agentId,
      oldNodeId: jobResult.oldNodeId,
      newNodeId: jobResult.newNodeId,
      newDigest: jobResult.newDigest,
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

    if (await this.completeIfAgentGone(job, result, data.agentId)) return;

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

    if (await this.completeIfAgentGone(job, result, data.agentId)) return;

    // Scheduled (auto) backups run across every non-pool sandbox, but an idle
    // agent (stopped/sleeping/disconnected — no bridge_url) legitimately has no
    // live state to snapshot. Treating that as a hard failure burned three
    // attempts per agent per tick and flooded the failed-jobs view (the bulk of
    // it was "Sandbox is not running"), masking real snapshot failures. For an
    // auto snapshot this is a benign no-op, so mark it completed-as-skipped
    // WITHOUT throwing (no retry). MANUAL snapshots still surface the error —
    // the user explicitly asked for a backup and deserves to know it can't run.
    if (
      !result.success &&
      data.snapshotType === "auto" &&
      (result.error === "Sandbox is not running" || result.error === SNAPSHOT_ENDPOINT_UNSUPPORTED)
    ) {
      await jobsRepository.updateStatus(job.id, "completed", {
        result: agentSnapshotJobResultToRecord({
          cloudAgentId: data.agentId,
          skipped: true,
          reason: result.error,
        }),
        completed_at: new Date(),
      });
      // Neutral message + reason so the V2-image snapshot-capability gap stays
      // observable in logs instead of being mislabeled "agent not running".
      logger.info("[provisioning-jobs] auto snapshot skipped", {
        jobId: job.id,
        agentId: data.agentId,
        reason: result.error,
      });
      return;
    }

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

    if (await this.completeIfAgentGone(job, provResult, data.agentId)) return;

    if (!provResult.success) {
      await jobsRepository.update(job.id, {
        result: agentProvisionJobResultToRecord({
          cloudAgentId: data.agentId,
          status: provResult.sandboxRecord?.status ?? "error",
          error: provResult.error,
        }),
      });
      if (provResult.retryable) {
        throw new RetryableProvisionTransportError(provResult.error);
      }
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

  /**
   * Reconcile `disconnected` always-on (paid) agents back to health. The
   * heartbeat cycle only iterates RUNNING agents, so a `dedicated-always` agent
   * that dropped past the grace window and flipped to `disconnected` would
   * otherwise stay dead forever (the agent-router routes only `running`, so its
   * subdomain 404s and the user's paid agent is unreachable). Each cycle
   * re-probes the bridge: still reachable → flip straight back to `running`;
   * truly down → enqueue a re-provision (idempotent — `enqueueAgentProvisionOnce`
   * dedups an in-flight job, so running this every cycle won't pile up provisions).
   */
  async processDisconnectedRecovery(concurrency = 5): Promise<RecoveryResult> {
    const recoverable = await agentSandboxesRepository.listRecoverable();
    const total = recoverable.length;
    if (total === 0) {
      return { total: 0, recovered: 0, reprovisioned: 0, failed: 0 };
    }

    let recovered = 0;
    let reprovisioned = 0;
    let failed = 0;
    const queue = [...recoverable];
    const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
      while (true) {
        const r = queue.shift();
        if (!r) break;
        try {
          const outcome = await elizaSandboxService.recoverDisconnected(r.id, r.organization_id);
          if (outcome === "recovered") {
            recovered += 1;
            continue;
          }
          if (outcome === "gone") {
            // No longer disconnected (already recovered/deleted) — nothing to do.
            continue;
          }
          // Still unreachable — rebuild it.
          await this.enqueueAgentProvisionOnce({
            agentId: r.id,
            organizationId: r.organization_id,
            userId: r.user_id,
            agentName: r.agent_name ?? r.id,
            expectedUpdatedAt: r.updated_at,
          });
          reprovisioned += 1;
        } catch (error) {
          failed += 1;
          logger.warn("[provisioning-jobs] disconnected recovery failed", {
            agentId: r.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });
    await Promise.all(workers);

    return { total, recovered, reprovisioned, failed };
  }

  /**
   * Reconcile rows WEDGED in `provisioning` whose container is actually healthy
   * — the readiness-probe false-negative split-brain (#15310 failure mode #6).
   *
   * A dedicated agent whose readiness probe returned a transient false-negative
   * (SSH/exec blip) never flips to `running`; its row sits `provisioning`
   * forever while the container serves happily. The Worker-side cleanup cron
   * can only mark such rows `error` (it has no SSH). This daemon-side pass
   * (which CAN reach the node) re-probes each stuck container and flips it to
   * `running` when it re-probes healthy — self-healing the split-brain instead
   * of stranding a live agent or waiting for a human to flip the row.
   *
   * Mirrors `processDisconnectedRecovery`: candidate query (`minAgeMs` grace,
   * no active provision job racing it), bounded concurrency, per-agent probe.
   * It NEVER tears a container down — an `unresolved` probe leaves the row for
   * the next pass (and, as a last resort, the Worker cron's error mark).
   */
  async reconcileStuckProvisioning(params?: {
    minAgeMs?: number;
    maxAgents?: number;
    concurrency?: number;
  }): Promise<{ total: number; recovered: number; unresolved: number; failed: number }> {
    const minAgeMs = params?.minAgeMs ?? 5 * 60 * 1000; // 5m grace beyond normal boot
    const maxAgents = params?.maxAgents ?? 50;
    const concurrency = params?.concurrency ?? 5;
    const cutoff = new Date(Date.now() - minAgeMs);

    const stuck = await agentSandboxesRepository.listStuckProvisioningWithContainer(
      cutoff,
      maxAgents,
    );
    const total = stuck.length;
    if (total === 0) return { total: 0, recovered: 0, unresolved: 0, failed: 0 };

    let recovered = 0;
    let unresolved = 0;
    let failed = 0;
    const queue = [...stuck];
    const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
      while (true) {
        const r = queue.shift();
        if (!r) break;
        try {
          const outcome = await elizaSandboxService.reconcileStuckProvisioning(
            r.id,
            r.organization_id,
          );
          if (outcome === "recovered") recovered += 1;
          else unresolved += 1; // "gone" is a no-op, count with unresolved
        } catch (error) {
          failed += 1;
          logger.warn("[provisioning-jobs] stuck-provisioning reconcile failed", {
            agentId: r.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });
    await Promise.all(workers);

    if (recovered > 0 || failed > 0) {
      logger.info("[provisioning-jobs] stuck-provisioning reconcile pass", {
        total,
        recovered,
        unresolved,
        failed,
      });
    }
    return { total, recovered, unresolved, failed };
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
          error: error instanceof Error ? error.message : String(error),
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

  private async recoverStaleJobs(
    jobTypes: readonly ProvisioningJobType[] = Object.values(JOB_TYPES),
  ): Promise<number> {
    let totalRecovered = 0;

    // Recover stale jobs per type across all organizations. The repository now
    // handles org-agnostic recovery, so we can do this in one pass.
    for (const jobType of jobTypes) {
      const recovered = await jobsRepository.recoverStaleJobs({
        type: jobType,
        staleThresholdMs: COLD_BOOT_JOB_TYPES.has(jobType)
          ? COLD_BOOT_STALE_JOB_THRESHOLD_MS
          : DEFAULT_STALE_JOB_THRESHOLD_MS,
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

      // `safeWebhookUrl` is validated above for the waifu-target comparison;
      // safeFetch re-resolves and pins the connection so the webhook host
      // cannot rebind to a private/mesh address between check and connect.
      const response = await safeFetch(safeWebhookUrl.toString(), {
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

export interface RecoveryResult {
  /** disconnected always-on agents examined this cycle */
  total: number;
  /** flipped back to `running` because the bridge answered again */
  recovered: number;
  /** still unreachable → a re-provision job was enqueued */
  reprovisioned: number;
  /** recovery threw for this agent */
  failed: number;
}

export interface ProcessingResult {
  claimed: number;
  succeeded: number;
  retried: number;
  failed: number;
  errors: Array<{ jobId: string; error: string }>;
}

// Singleton
export const provisioningJobService = new ProvisioningJobService();
