/** Node provisioning execution, durable leases, recovery and effect settlement. */
import { getDedicatedComputePriceAcceptance } from "@elizaos/cloud-sdk/browser-contracts";
import { ElizaError } from "@elizaos/core";
import { and, desc, eq, inArray, isNotNull, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import type { DbTransaction } from "../db/client";
import { dbWrite } from "../db/helpers";
import {
  type BillingResumeCandidate,
  billingResumeStillAuthorizedInTransaction,
} from "../db/repositories/agent-billing-resume";
import { updateAgentLifecycleExecutionFence } from "../db/repositories/agent-lifecycle-execution-fence";
import { agentSandboxesRepository } from "../db/repositories/agent-sandboxes";
import {
  cutoverResumeWindowAllows,
  hydrateJob,
  type Job,
  type JobRecoveryFailure,
  type JobRecoverySweepResult,
  jobsRepository,
  msWindowTimestampMatch,
  type RecoveryFailureWritebackBuilder,
  StaleJobExecutionError,
} from "../db/repositories/jobs";
import { agentComputeStopIntents } from "../db/schemas/agent-compute-stop-intents";
import {
  agentSandboxes,
  UPGRADE_FAILURE_TARGET_MARKER_PREFIX,
} from "../db/schemas/agent-sandboxes";
import { apps } from "../db/schemas/apps";
import { containers } from "../db/schemas/containers";
import { jobExecutionLeases } from "../db/schemas/job-execution-leases";
import { jobs } from "../db/schemas/jobs";
import { ApiError } from "../lib/api/cloud-worker-errors";
import { assertSafeOutboundUrl } from "../lib/security/outbound-url";
import { safeFetch } from "../lib/security/safe-fetch";
import { AccountLifecycleFencedError } from "../lib/services/account-lifecycle-authority";
import {
  ADMIN_CANARY_MAX_RUNNING_JOBS,
  type AdminCanaryImageJobResult,
  isPendingAdminCanaryCutoverAudit,
} from "../lib/services/admin-canary-image";
import { checkAgentCreditGate } from "../lib/services/agent-billing-gate";
import {
  executeAgentComputeLeaseJob,
  readAgentComputeLeaseJobData,
} from "../lib/services/agent-compute-lease-jobs";
import {
  AppCacheInvalidationRetryError,
  dispatchAppCacheInvalidationJob,
  enqueueAppCacheInvalidation,
  formatAppCacheInvalidationError,
} from "../lib/services/app-cache-invalidation-job";
import { dispatchAppDbDeprovisionJob } from "../lib/services/app-db-deprovision-job-service";
import { dispatchAppDeployJob, readAppDeployJobData } from "../lib/services/app-deploy-job-service";
import {
  APP_DEPLOYMENT_GENERATION_KEY,
  deploymentGenerationFromMetadata,
} from "../lib/services/app-deployment-generation";
import {
  dispatchContainerJob,
  getContainerExecutorDeps,
} from "../lib/services/container-job-service";
import { readContainerProvisionJobData } from "../lib/services/container-jobs-data";
import { dispatchContainerStopJob } from "../lib/services/container-stop-job-service";
import {
  configureElizaLifecycleTransaction,
  elizaProvisionAdvisoryLockSql,
} from "../lib/services/eliza-provision-lock";
import {
  AdminCanaryCleanupExpectationError,
  assertReviewedFreshBootAuthority,
  assertReviewedProvisionRestoreAuthority,
  elizaSandboxService,
  SNAPSHOT_ENDPOINT_UNSUPPORTED,
} from "../lib/services/eliza-sandbox";
import {
  finalizeJobErrorText,
  jobErrorSummary,
  jobErrorText,
} from "../lib/services/job-error-text";
import {
  acquireProviderAdmission,
  type ProviderAdmissionAuthority,
  releaseProviderAdmission,
} from "../lib/services/provider-admission";
import {
  executeProvisioningWithAccountLifecycleAdmission,
  prepareProvisioningWithAccountLifecycleFence,
} from "../lib/services/provisioning-account-lifecycle-fence";
import {
  ADMIN_CANARY_CONFLICTING_JOB_TYPES,
  CONTAINER_BACKED_TARGET_REQUIRED_MESSAGE,
  CONTAINER_LIFECYCLE_ESTIMATED_DURATION_MS,
  jobRecord,
  PRICED_AGENT_START_JOB_TYPES,
  readAdminCanaryImageJobData,
  readAgentDeleteJobData,
  readAgentProvisionJobData,
  readAgentSuspendJobData,
  readAgentWakeJobData,
  SHARED_IMAGE_CHANGE_JOB_TYPES,
  snapshotAuthorityRejection,
} from "../lib/services/provisioning-job-policy";
import { ProvisioningJobQueue } from "../lib/services/provisioning-job-queue";
import type {
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
  AgentWakeJobResult,
  HeartbeatResult,
  ProcessingResult,
  RecoveryResult,
} from "../lib/services/provisioning-job-types";
import {
  AGENT_JOB_TYPES,
  COLD_BOOT_JOB_TYPES,
  COLD_BOOT_STALE_JOB_THRESHOLD_MS,
  DEFAULT_STALE_JOB_THRESHOLD_MS,
  EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES,
  JOB_TYPES,
  type ProvisioningJobType,
  requiresContainerBackedTarget,
} from "../lib/services/provisioning-job-types";
import { usesLocalDockerSandboxProvider } from "../lib/services/sandbox-provider";
import { isContainerBackedExecutionTier } from "../lib/services/sandbox-provider-types";
import {
  isWaifuWebhookTargetUrl,
  resolveWaifuWebhookTarget,
  signWaifuWebhook,
} from "../lib/services/waifu-webhook";
import { WakeRestoreIntegrityError } from "../lib/services/wake-restore-integrity";
import { logger } from "../lib/utils/logger";
import { isValidUUID } from "../lib/utils/validation";
import { OperationTimeoutError, withTimeout } from "../lib/utils/with-timeout";

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
} from "../lib/services/provisioning-job-types";

/** Match a known failure type without trusting a thrown Proxy's prototype trap. */
function safeErrorKind<T extends Error>(
  value: unknown,
  errorClass: abstract new (...args: never[]) => T,
): value is T {
  try {
    return value instanceof errorClass;
  } catch {
    // error-policy:J3 hostile thrown value; treat it as an ordinary failure so
    // the job still reaches its durable retry/failure transition.
    return false;
  }
}

/** Domain rejection that must terminate the exact claim without ordinary retry handling. */
class RejectedAgentExecutionError extends ElizaError {
  override readonly name = "RejectedAgentExecutionError";

  constructor(
    message: string,
    context: {
      jobId: string;
      jobType: string;
      columnAgentId: string | null;
      columnOrganizationId: string;
      payloadAgentId?: string | null;
      payloadOrganizationId?: string | null;
      executionTier?: string;
      cause?: string;
    },
  ) {
    super(message, {
      code: "PROVISIONING_JOB_TARGET_REJECTED",
      context,
      severity: "fatal",
    });
  }
}

const REPLACEMENT_CLEANUP_ONLY_PREFIX = "Replacement cleanup is still pending: ";

const REPLACEMENT_CLEANUP_CAUSE_SEPARATOR = "; replacement cleanup remains pending: ";

/** Keep the first startup failure when later free retries only re-attempt cleanup. */
function preserveProvisionFailureAcrossCleanupRetry(
  priorResult: unknown,
  currentError: string,
): string {
  if (!currentError.startsWith(REPLACEMENT_CLEANUP_ONLY_PREFIX)) return currentError;
  if (!priorResult || typeof priorResult !== "object" || Array.isArray(priorResult)) {
    return currentError;
  }
  const priorError = (priorResult as { error?: unknown }).error;
  if (
    typeof priorError !== "string" ||
    priorError.length === 0 ||
    priorError.startsWith(REPLACEMENT_CLEANUP_ONLY_PREFIX)
  ) {
    return currentError;
  }
  const separatorIndex = priorError.indexOf(REPLACEMENT_CLEANUP_CAUSE_SEPARATOR);
  const primaryError = separatorIndex >= 0 ? priorError.slice(0, separatorIndex) : priorError;
  return `${primaryError}${REPLACEMENT_CLEANUP_CAUSE_SEPARATOR}${currentError.slice(
    REPLACEMENT_CLEANUP_ONLY_PREFIX.length,
  )}`;
}

/**
 * Reads the free-requeue tally off a persisted agent_delete result. The stored
 * value is untrusted JSON, so anything that is not a non-negative integer reads
 * as zero rather than as a fabricated budget.
 */
function readAgentDeleteCaptureRetryCount(result: unknown): number {
  if (!result || typeof result !== "object") return 0;
  const value = (result as { captureRetryCount?: unknown }).captureRetryCount;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function jobAuditTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function agentDeleteAuthorityResult(
  data: AgentDeleteJobData,
): Pick<
  AgentDeleteJobResult,
  "stateLossAcknowledged" | "stateLossAcknowledgedByUserId" | "stateLossAcknowledgedAt"
> {
  if (!hasCompleteAgentDeleteAuthority(data)) return {};
  return {
    stateLossAcknowledged: true,
    stateLossAcknowledgedByUserId: data.stateLossAcknowledgedByUserId,
    stateLossAcknowledgedAt: data.stateLossAcknowledgedAt,
  };
}

function hasCompleteAgentDeleteAuthority(
  data: AgentDeleteJobData | undefined,
): data is AgentDeleteJobData & {
  stateLossAcknowledged: true;
  stateLossAcknowledgedByUserId: string;
  stateLossAcknowledgedAt: string;
} {
  if (
    data?.stateLossAcknowledged !== true ||
    typeof data.stateLossAcknowledgedByUserId !== "string" ||
    data.stateLossAcknowledgedByUserId.length === 0 ||
    typeof data.stateLossAcknowledgedAt !== "string"
  ) {
    return false;
  }
  const timestamp = Date.parse(data.stateLossAcknowledgedAt);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === data.stateLossAcknowledgedAt
  );
}

/** CAS the three authority fields together so settlement cannot miss an upgrade. */
function agentDeleteAuthorityFence(data: AgentDeleteJobData): SQL {
  return sql`
    COALESCE(${jobs.data}->>'stateLossAcknowledged', '') = ${
      data.stateLossAcknowledged === undefined ? "" : String(data.stateLossAcknowledged)
    }
    AND COALESCE(${jobs.data}->>'stateLossAcknowledgedByUserId', '') = ${
      data.stateLossAcknowledgedByUserId ?? ""
    }
    AND COALESCE(${jobs.data}->>'stateLossAcknowledgedAt', '') = ${
      data.stateLossAcknowledgedAt ?? ""
    }
  `;
}

/**
 * Revalidate the immutable payload authority selected before the asynchronous
 * worker may cross into provider compute. The backup row is deliberately read
 * at execution time: a verifier downgrade, reassignment, deletion, or digest
 * change after quote/adoption must fail without calling the sandbox provider.
 */
export async function resolveReviewedProvisionRestoreDirectiveForExecution(
  data: AgentProvisionJobData,
): Promise<AgentProvisionJobData["restoreDirective"]> {
  const directive = data.restoreDirective;
  if (directive?.kind === "from-reviewed-backup") {
    await assertReviewedProvisionRestoreAuthority(data.agentId, directive);
  } else if (directive?.kind === "reviewed-fresh-boot") {
    await assertReviewedFreshBootAuthority(data.agentId, directive);
  } else {
    return directive;
  }
  return directive;
}

interface ResolvedAgentSuspendAuthority {
  authorization: AgentSuspendJobData["authorization"];
  lifecycleRevision?: number;
  intentBound: boolean;
}

/**
 * Resolve modern jobs from their exact durable intent. Legacy user-request
 * jobs predate intent binding, so their inline authorization remains a
 * compatibility fallback only.
 */
async function resolveAgentSuspendAuthority(job: Job): Promise<ResolvedAgentSuspendAuthority> {
  const data = readAgentSuspendJobData(job);
  const [boundIntent] = await dbWrite
    .select({
      authorization: agentComputeStopIntents.authorization,
      lifecycleRevision: agentComputeStopIntents.lifecycle_revision,
    })
    .from(agentComputeStopIntents)
    .where(
      and(
        eq(agentComputeStopIntents.organization_id, job.organization_id),
        eq(agentComputeStopIntents.agent_id, data.agentId),
        eq(agentComputeStopIntents.job_id, job.id),
      ),
    )
    .limit(1);
  if (boundIntent) {
    return {
      authorization: boundIntent.authorization,
      lifecycleRevision: boundIntent.lifecycleRevision,
      intentBound: true,
    };
  }
  return {
    authorization: data.authorization ?? "user_request",
    lifecycleRevision: data.lifecycleRevision,
    intentBound: false,
  };
}

/** Resolve pre-authority suspend jobs without changing the public helper contract. */
export async function resolveAgentSuspendAuthorization(
  job: Job,
): Promise<AgentSuspendJobData["authorization"]> {
  return (await resolveAgentSuspendAuthority(job)).authorization;
}

function isAgentResumeJobData(value: unknown): value is AgentResumeJobData {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { agentId?: unknown }).agentId !== "string" ||
    typeof (value as { organizationId?: unknown }).organizationId !== "string" ||
    typeof (value as { userId?: unknown }).userId !== "string"
  )
    return false;
  const automatic = (value as { automaticResume?: unknown }).automaticResume;
  return (
    automatic === undefined ||
    (typeof automatic === "object" &&
      automatic !== null &&
      typeof (automatic as { stopIntentId?: unknown }).stopIntentId === "string" &&
      isValidUUID((automatic as { stopIntentId: string }).stopIntentId))
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

function isAgentRestartJobData(value: unknown): value is AgentRestartJobData {
  const stateLossAcknowledged = (value as { stateLossAcknowledged?: unknown })
    ?.stateLossAcknowledged;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { agentId?: unknown }).agentId === "string" &&
    typeof (value as { organizationId?: unknown }).organizationId === "string" &&
    typeof (value as { userId?: unknown }).userId === "string" &&
    (stateLossAcknowledged === undefined || typeof stateLossAcknowledged === "boolean")
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

export interface WarmClaimCredentialReconcileResult {
  legacyFound: number;
  strandedFound: number;
  recoveryEnqueued: number;
  recoveryInFlight: number;
  recoveryDeferred: number;
  cleanupFound: number;
  cleanupCompleted: number;
  cleanupFailed: number;
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
 * Stale-job thresholds, by job type. Generated provisioning attempts remain
 * owned until their executor acknowledges quiescence; daemon startup recovery
 * handles process replacement. These thresholds still govern legacy claims
 * and size the execution watchdog, so they must exceed real worst-case runtime.
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
/** Re-schedule delay for snapshot jobs claimed while the lane gate is off
 *  (#16639) — long enough not to spin, short enough to drain promptly once
 *  operators enable the lane. */
const SNAPSHOT_GATE_RETRY_DELAY_MS = 10 * 60 * 1000;

const PROVISION_TRANSPORT_RETRY_DELAY_MS = 2 * 60 * 1000;

/** Retryable provider/transport outcomes allowed before the logical job is
 * settled terminally without restarting its ordinary-attempt ladder. */
const PROVISION_TRANSPORT_MAX_FREE_RETRIES = 5;

/** How many times a transient pre-deletion capture may requeue WITHOUT
 *  consuming the delete's attempt budget. At the transport retry delay above
 *  this is ~20 minutes of tolerance for a capture outage; past it the failure
 *  escalates to an attempt-consuming one so a user-requested delete cannot
 *  become an immortal (still billed) agent. */
const PRE_DELETE_CAPTURE_MAX_FREE_RETRIES = 10;

const WARM_CLAIM_RECOVERY_ORPHAN_GRACE_MS = 2 * 60 * 1000;

const EXECUTION_LEASE_MS = 60_000;

const EXECUTION_LEASE_HEARTBEAT_MS = 15_000;

const SETTLEMENT_RETRY_BASE_MS = 250;

const SETTLEMENT_RETRY_MAX_MS = 5_000;

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
 * Cold-boot job types therefore get the same 15-min budget used for legacy
 * stale claims, so the per-job wrap can't fire before a legitimate cold boot
 * finishes (15 min > ~11 min). Fast ops keep the tight 300s.
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
  readonly retrySnapshot: Job;
  readonly maxRequeues: number;
  readonly durableErrorText?: string;

  constructor(
    message: string,
    retrySnapshot: Job,
    maxRequeues: number,
    options?: { cause?: unknown; durableErrorText?: string },
  ) {
    super(message, options);
    this.name = "RetryableProvisionTransportError";
    this.retrySnapshot = retrySnapshot;
    this.maxRequeues = maxRequeues;
    this.durableErrorText = options?.durableErrorText;
  }
}

/**
 * A pre-deletion capture stayed transient past its free-requeue budget. The
 * free requeue exists so a momentary capture outage does not burn the delete's
 * finite attempts, but an outage that never clears would requeue forever and
 * keep a user-requested delete alive (and billed) indefinitely. Past the cap
 * the failure escalates to an ordinary attempt-consuming failure, so the job
 * ends in `deletion_failed` where the stuck-delete reconciler and ops can see
 * it — fail closed, never a fabricated success.
 */
class PreDeleteCaptureExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreDeleteCaptureExhaustedError";
  }
}

/**
 * A delete failed from an unacknowledged worker snapshot. Its terminal write
 * must be fenced against a concurrent false-to-true authority upgrade so the
 * API cannot durably accept state loss and then have this stale attempt win.
 */
class UnacknowledgedAgentDeleteError extends Error {
  readonly retrySnapshot: Job;

  constructor(message: string, retrySnapshot: Job) {
    super(message);
    this.name = "UnacknowledgedAgentDeleteError";
    this.retrySnapshot = retrySnapshot;
  }
}

class RetryableReplacementCleanupError extends Error {
  readonly retrySnapshot: Job;
  readonly maxRequeues = PROVISION_TRANSPORT_MAX_FREE_RETRIES;

  constructor(message: string, retrySnapshot: Job, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RetryableReplacementCleanupError";
    this.retrySnapshot = retrySnapshot;
  }
}

class AdminCanaryCleanupCommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminCanaryCleanupCommitError";
  }
}

const ACCOUNT_LIFECYCLE_FENCED_AGENT_JOB_TYPES: readonly ProvisioningJobType[] = [
  JOB_TYPES.AGENT_PROVISION,
  JOB_TYPES.AGENT_RESUME,
  JOB_TYPES.AGENT_WAKE,
  JOB_TYPES.AGENT_RESTART,
  JOB_TYPES.AGENT_UPGRADE,
  JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
  JOB_TYPES.AGENT_DOWNGRADE,
  JOB_TYPES.AGENT_LOGS,
  JOB_TYPES.AGENT_MESSAGE,
  JOB_TYPES.AGENT_SNAPSHOT,
];

/**
 * Job types whose permanent failure has to settle a dependent status row. This
 * list and the arms of `buildPermanentFailureWriteback` are ONE mapping; the
 * exhaustiveness check in that switch fails the build if they drift apart.
 * Recovery consults it per TYPE because resolving a writeback first hydrates
 * the job's blob-offloaded payload, and a type owning no dependent row would
 * pay those object-store reads only to be handed `undefined` — which would
 * also make the stale sweep hydrate for lanes it deliberately leaves gated.
 */
const DEPENDENT_ROW_JOB_TYPES = [
  JOB_TYPES.AGENT_PROVISION,
  JOB_TYPES.AGENT_RESTART,
  JOB_TYPES.AGENT_UPGRADE,
  JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
  JOB_TYPES.APP_DEPLOY,
  JOB_TYPES.CONTAINER_PROVISION,
  JOB_TYPES.AGENT_DELETE,
] as const satisfies readonly ProvisioningJobType[];

type DependentRowJobType = (typeof DEPENDENT_ROW_JOB_TYPES)[number];

function ownsDependentRow(jobType: string): jobType is DependentRowJobType {
  return (DEPENDENT_ROW_JOB_TYPES as readonly string[]).includes(jobType);
}

export interface ProvisioningRecoverySummary {
  scanned: number;
  retried: number;
  permanentlyFailed: number;
  unchanged: number;
  failures: JobRecoveryFailure[];
}

export class ProvisioningRecoveryDegradedError extends ElizaError {
  override readonly name = "ProvisioningRecoveryDegradedError";
  readonly summary: ProvisioningRecoverySummary;

  constructor(phase: "stale" | "startup", summary: ProvisioningRecoverySummary) {
    const causes = summary.failures.map(({ cause }) => cause);
    super(`Provisioning ${phase} recovery completed with ${summary.failures.length} failure(s)`, {
      code: "PROVISIONING_RECOVERY_DEGRADED",
      cause: new AggregateError(causes, `Provisioning ${phase} recovery failures`),
      context: {
        phase,
        scanned: summary.scanned,
        retried: summary.retried,
        permanentlyFailed: summary.permanentlyFailed,
        unchanged: summary.unchanged,
        failures: summary.failures.map(({ jobId, jobType, cause }) => ({
          jobId,
          jobType,
          error: jobErrorText(cause),
        })),
      },
      severity: "ephemeral",
    });
    this.summary = summary;
  }
}

function emptyRecoverySummary(): ProvisioningRecoverySummary {
  return { scanned: 0, retried: 0, permanentlyFailed: 0, unchanged: 0, failures: [] };
}

function addRecoveryResult(
  summary: ProvisioningRecoverySummary,
  result: JobRecoverySweepResult,
): void {
  summary.scanned += result.scanned;
  summary.retried += result.retried;
  summary.permanentlyFailed += result.permanentlyFailed;
  summary.unchanged += result.unchanged;
  summary.failures.push(...result.failures);
}

function assertRecoveryHealthy(
  phase: "stale" | "startup",
  summary: ProvisioningRecoverySummary,
): void {
  if (summary.failures.length === 0) return;
  logger.error(`[provisioning-jobs] ${phase} recovery finished degraded`, {
    scanned: summary.scanned,
    retried: summary.retried,
    permanentlyFailed: summary.permanentlyFailed,
    unchanged: summary.unchanged,
    failures: summary.failures.map(({ jobId, jobType, cause }) => ({
      jobId,
      jobType,
      error: jobErrorText(cause),
    })),
  });
  throw new ProvisioningRecoveryDegradedError(phase, summary);
}
export class ProvisioningJobService extends ProvisioningJobQueue {
  /**
   * Converges personal Dedicated access on the organization's current paid
   * plan entitlement (#25146), one cursor page per call. The fallback
   * authority admits its stop/resume effects back through this queue.
   */
  async reconcilePersonalDedicatedEntitlements(input: {
    limit: number;
    afterAuthorityId?: string;
  }) {
    // Lazy: the fallback authority itself enqueues through this service.
    const { reconcilePersonalDedicatedEntitlements } = await import(
      "../lib/services/personal-dedicated-fallback"
    );
    return reconcilePersonalDedicatedEntitlements(input);
  }

  private readonly executionOverride?: (job: Job) => Promise<void>;

  private readonly executionTimeoutMs: (jobType: string) => number;

  private readonly executionOwnerId: string;

  private readonly executionLeaseMs: number;

  private readonly executionLeaseHeartbeatMs: number;

  private readonly settlementRetryBaseMs: number;

  private readonly acquireProviderAdmission: typeof acquireProviderAdmission;

  private readonly releaseProviderAdmission: typeof releaseProviderAdmission;

  constructor(options?: {
    executeJob?: (job: Job) => Promise<void>;
    executionTimeoutMs?: (jobType: string) => number;
    executionOwnerId?: string;
    executionLeaseMs?: number;
    executionLeaseHeartbeatMs?: number;
    settlementRetryBaseMs?: number;
    acquireProviderAdmission?: typeof acquireProviderAdmission;
    releaseProviderAdmission?: typeof releaseProviderAdmission;
  }) {
    super();
    this.executionOverride = options?.executeJob;
    this.executionTimeoutMs = options?.executionTimeoutMs ?? resolvePerJobTimeoutMs;
    this.executionOwnerId = options?.executionOwnerId ?? crypto.randomUUID();
    this.executionLeaseMs = options?.executionLeaseMs ?? EXECUTION_LEASE_MS;
    this.executionLeaseHeartbeatMs =
      options?.executionLeaseHeartbeatMs ?? EXECUTION_LEASE_HEARTBEAT_MS;
    this.settlementRetryBaseMs = options?.settlementRetryBaseMs ?? SETTLEMENT_RETRY_BASE_MS;
    this.acquireProviderAdmission = options?.acquireProviderAdmission ?? acquireProviderAdmission;
    this.releaseProviderAdmission = options?.releaseProviderAdmission ?? releaseProviderAdmission;
    if (
      this.executionLeaseMs < 1 ||
      this.executionLeaseHeartbeatMs < 1 ||
      this.executionLeaseHeartbeatMs >= this.executionLeaseMs
    ) {
      throw new Error("Execution lease heartbeat must be positive and shorter than the lease");
    }
  }

  /**
   * Keep durable suspend-authority resolution behind the service boundary so
   * dispatch harnesses can replace that one read per test without swapping the
   * process-wide DB helper module used by composed PGlite suites.
   */
  private async resolveAgentSuspendAuthority(job: Job): Promise<ResolvedAgentSuspendAuthority> {
    return resolveAgentSuspendAuthority(job);
  }

  /**
   * Rolling migration and failure cleanup for the durable warm-claim fence.
   * Legacy rows are never backfilled ready: each is lifecycle-locked, moved to
   * pending, and restarted through the real remint/live-attest path. Failed
   * handoffs retain their cleanup record until both credential owners revoke.
   */
  async reconcileWarmClaimCredentialFences(limit = 5): Promise<WarmClaimCredentialReconcileResult> {
    const boundedLimit = Math.max(1, Math.min(25, Math.trunc(limit)));
    const cleanupCandidates =
      await agentSandboxesRepository.listFailedWarmClaimCredentialCleanupCandidates(boundedLimit);
    let cleanupCompleted = 0;
    let cleanupFailed = 0;
    for (const candidate of cleanupCandidates) {
      try {
        if (
          await elizaSandboxService.cleanupFailedWarmClaimCredentialHandoff(
            candidate.id,
            candidate.organization_id,
          )
        ) {
          cleanupCompleted += 1;
        }
      } catch (error) {
        // error-policy:J7 Each failed row remains durably selectable for the
        // next daemon pass; report it without starving unrelated cleanups.
        cleanupFailed += 1;
        logger.error("[provisioning-jobs] Warm-claim credential cleanup failed", {
          agentId: candidate.id,
          orgId: candidate.organization_id,
          error: jobErrorText(error),
        });
      }
    }

    const legacyCandidates =
      await agentSandboxesRepository.listLegacyWarmClaimRecoveryCandidates(boundedLimit);
    let recoveryEnqueued = 0;
    let recoveryInFlight = 0;
    let recoveryDeferred = 0;
    for (const candidate of legacyCandidates) {
      try {
        const result = await this.enqueueLifecycleJob<AgentRestartJobData>({
          jobType: JOB_TYPES.AGENT_RESTART,
          jobData: {
            agentId: candidate.id,
            organizationId: candidate.organization_id,
            userId: candidate.user_id,
          },
          toRecord: jobRecord<AgentRestartJobData>,
          agentId: candidate.id,
          organizationId: candidate.organization_id,
          userId: candidate.user_id,
          maxAttempts: 3,
          estimatedDurationMs: CONTAINER_LIFECYCLE_ESTIMATED_DURATION_MS,
          logName: "legacy_warm_claim_recovery",
          mutuallyExclusiveJobTypes: [
            ...ADMIN_CANARY_CONFLICTING_JOB_TYPES,
            ...SHARED_IMAGE_CHANGE_JOB_TYPES,
          ],
          validateSandbox: (sandbox) => {
            if (
              !["running", "provisioning", "stopped", "error"].includes(sandbox.status) ||
              !sandbox.claimed_at ||
              sandbox.warm_claim_credential_state !== null ||
              sandbox.user_id !== candidate.user_id
            ) {
              throw new ApiError(
                409,
                "session_not_ready",
                `Agent ${candidate.id} is no longer a legacy warm-claim candidate`,
              );
            }
          },
          beforeInsert: async (tx) => {
            const prepared = await tx.execute<{ id: string }>(sql`
              UPDATE ${agentSandboxes}
              SET
                status = 'provisioning',
                warm_claim_credential_state = 'pending',
                warm_claim_source_pool_id = NULL,
                warm_claim_key_fingerprint = NULL,
                warm_claim_attested_at = NULL,
                warm_claim_attested_environment_revision = NULL,
                warm_claim_cleanup_completed_at = NULL,
                error_message = 'Legacy warm claim requires credential and image re-attestation',
                updated_at = NOW()
              WHERE id = ${candidate.id}
                AND organization_id = ${candidate.organization_id}
                AND user_id = ${candidate.user_id}
                AND status IN ('running', 'provisioning', 'stopped', 'error')
                AND claimed_at IS NOT NULL
                AND warm_claim_credential_state IS NULL
              RETURNING id
            `);
            if (prepared.rows.length !== 1) {
              throw new ApiError(
                409,
                "session_not_ready",
                `Agent ${candidate.id} changed before legacy warm-claim recovery enqueue`,
              );
            }
          },
        });
        if (result.created) recoveryEnqueued += 1;
        else recoveryInFlight += 1;
      } catch (error) {
        // error-policy:J1 per-candidate recovery boundary — a concurrent
        // ownership change becomes an explicit deferred count; other failures surface.
        if (error instanceof ApiError && error.status === 409) {
          recoveryDeferred += 1;
          continue;
        }
        throw error;
      }
    }

    const strandedCutoff = new Date(Date.now() - WARM_CLAIM_RECOVERY_ORPHAN_GRACE_MS);
    const strandedLimit = boundedLimit - legacyCandidates.length;
    const strandedCandidates =
      strandedLimit > 0
        ? await agentSandboxesRepository.listStrandedWarmClaimRecoveryCandidates(
            strandedCutoff,
            strandedLimit,
          )
        : [];
    for (const candidate of strandedCandidates) {
      try {
        const result = await this.enqueueLifecycleJob<AgentRestartJobData>({
          jobType: JOB_TYPES.AGENT_RESTART,
          jobData: {
            agentId: candidate.id,
            organizationId: candidate.organization_id,
            userId: candidate.user_id,
          },
          toRecord: jobRecord<AgentRestartJobData>,
          agentId: candidate.id,
          organizationId: candidate.organization_id,
          userId: candidate.user_id,
          maxAttempts: 3,
          estimatedDurationMs: CONTAINER_LIFECYCLE_ESTIMATED_DURATION_MS,
          logName: "stranded_warm_claim_recovery",
          mutuallyExclusiveJobTypes: [
            ...ADMIN_CANARY_CONFLICTING_JOB_TYPES,
            ...SHARED_IMAGE_CHANGE_JOB_TYPES,
          ],
          validateSandbox: (sandbox) => {
            if (
              !sandbox.claimed_at ||
              (sandbox.warm_claim_credential_state !== "pending" &&
                sandbox.warm_claim_credential_state !== "attested") ||
              sandbox.user_id !== candidate.user_id ||
              !sandbox.updated_at ||
              sandbox.updated_at >= strandedCutoff
            ) {
              throw new ApiError(
                409,
                "session_not_ready",
                `Agent ${candidate.id} is no longer a stranded warm-claim recovery`,
              );
            }
          },
          beforeInsert: async (tx) => {
            const prepared = await tx.execute<{ id: string }>(sql`
              UPDATE ${agentSandboxes}
              SET
                status = 'provisioning',
                error_message = 'Warm-claim credential recovery restart was re-enqueued',
                updated_at = NOW()
              WHERE id = ${candidate.id}
                AND organization_id = ${candidate.organization_id}
                AND user_id = ${candidate.user_id}
                AND claimed_at IS NOT NULL
                AND warm_claim_credential_state IN ('pending', 'attested')
                AND deleted_at IS NULL
              RETURNING id
            `);
            if (prepared.rows.length !== 1) {
              throw new ApiError(
                409,
                "session_not_ready",
                `Agent ${candidate.id} changed before stranded warm-claim recovery enqueue`,
              );
            }
          },
        });
        if (result.created) recoveryEnqueued += 1;
        else recoveryInFlight += 1;
      } catch (error) {
        // error-policy:J1 per-candidate recovery boundary — a concurrent
        // ownership change becomes an explicit deferred count; other failures surface.
        if (error instanceof ApiError && error.status === 409) {
          recoveryDeferred += 1;
          continue;
        }
        throw error;
      }
    }

    return {
      legacyFound: legacyCandidates.length,
      strandedFound: strandedCandidates.length,
      recoveryEnqueued,
      recoveryInFlight,
      recoveryDeferred,
      cleanupFound: cleanupCandidates.length,
      cleanupCompleted,
      cleanupFailed,
    };
  }

  async reconcileReplacementCleanupFences(limit = 5) {
    const boundedLimit = Math.max(1, Math.min(25, Math.trunc(limit)));
    return elizaSandboxService.reconcileReplacementCleanupFences(boundedLimit);
  }

  // ---------------------------------------------------------------------------
  // Processing (called by cron)
  // ---------------------------------------------------------------------------

  private startExecutionLeaseHeartbeat(job: Job): () => void {
    let renewalInFlight = false;
    const timer = setInterval(() => {
      if (renewalInFlight) return;
      renewalInFlight = true;
      void jobsRepository
        .renewExecutionLease(job, this.executionOwnerId, this.leaseDurationForJobType(job.type))
        .then((outcome) => {
          if (outcome !== "renewed") {
            clearInterval(timer);
            if (outcome === "lost") {
              logger.warn("[provisioning-jobs] Execution lease ownership was lost", {
                jobId: job.id,
                executionGeneration: job.execution_generation,
                executionOwnerId: this.executionOwnerId,
              });
            } else {
              logger.debug("[provisioning-jobs] Lease heartbeat stopped after settlement", {
                jobId: job.id,
              });
            }
          }
        })
        .catch((error) => {
          // error-policy:J7 lease diagnostics must not terminate the worker;
          // mutation guards and settlement CAS fail closed if renewal cannot recover.
          logger.warn("[provisioning-jobs] Execution lease renewal failed; retrying", {
            jobId: job.id,
            executionGeneration: job.execution_generation,
            executionOwnerId: this.executionOwnerId,
            error: jobErrorText(error),
          });
        })
        .finally(() => {
          renewalInFlight = false;
        });
    }, this.executionLeaseHeartbeatMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private async waitForSettlementRetry(attempt: number): Promise<void> {
    const delay = Math.min(
      SETTLEMENT_RETRY_MAX_MS,
      this.settlementRetryBaseMs * 2 ** Math.min(attempt - 1, 8),
    );
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      timer.unref?.();
    });
  }

  private async retryOwnedWrite<T>(
    job: Job,
    operation: string,
    write: () => Promise<T>,
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await write();
      } catch (error) {
        if (error instanceof StaleJobExecutionError) {
          const renewed = await jobsRepository.renewExecutionLease(
            job,
            this.executionOwnerId,
            this.leaseDurationForJobType(job.type),
          );
          if (renewed !== "renewed") throw error;
          continue;
        }
        attempt++;
        logger.warn("[provisioning-jobs] Owned execution write failed; retrying", {
          jobId: job.id,
          executionGeneration: job.execution_generation,
          executionOwnerId: this.executionOwnerId,
          operation,
          attempt,
          error: jobErrorText(error),
        });
        await this.waitForSettlementRetry(attempt);
      }
    }
  }

  private async assertExecutionMutationLease(job: Job): Promise<void> {
    try {
      await jobsRepository.assertExecutionLease(job, this.executionOwnerId);
    } catch (error) {
      if (
        !(error instanceof StaleJobExecutionError) ||
        (await jobsRepository.renewExecutionLease(
          job,
          this.executionOwnerId,
          this.leaseDurationForJobType(job.type),
        )) !== "renewed"
      ) {
        throw error;
      }
      await jobsRepository.assertExecutionLease(job, this.executionOwnerId);
    }
  }

  private leaseDurationForJobType(jobType: string): number {
    // A provider mutation already in flight cannot be remotely cancelled, so
    // takeover remains barred through the full local execution timeout. Regular
    // heartbeats extend this window for legitimately detached work.
    //
    // A crashed worker's claim remains protected for this duration plus the
    // 30-second takeover grace. The 16-minute cold-boot window prevents a
    // replacement from reclaiming work that may still be mutating a provider.
    return Math.max(
      this.executionLeaseMs,
      this.executionTimeoutMs(jobType) + 2 * this.executionLeaseHeartbeatMs,
    );
  }

  private async updateClaimedExecution(job: Job, updates: Partial<Job>): Promise<Job> {
    return await this.retryOwnedWrite(job, "update", () =>
      jobsRepository.updateForExecution(job, updates, this.executionOwnerId),
    );
  }

  private async settleClaimedExecution(
    job: Job,
    status: "completed" | "cancelled",
    updates?: Partial<Job>,
  ): Promise<void> {
    const settledUpdates =
      status === "completed"
        ? {
            ...updates,
            // A retry that succeeds must not retain the prior attempt's error
            // beside a completed receipt. Keep the payload metadata canonical
            // too, including when the failed attempt externalized its error.
            error: null,
            error_storage: "inline" as const,
            error_key: null,
          }
        : updates;
    await this.retryOwnedWrite(job, "settle", () =>
      jobsRepository.settleExecution(job, status, settledUpdates, this.executionOwnerId),
    );
  }

  /**
   * Settles a successful delete from the authority snapshot protected by the
   * same lifecycle lock as acknowledgement upgrades. A lost data fence loops
   * only while this exact execution generation still owns its renewable lease.
   */
  private async settleCompletedAgentDelete(
    job: Job,
    claimedData: AgentDeleteJobData,
    result: { containerStopped: boolean; rowDeleted: boolean },
  ): Promise<AgentDeleteJobResult> {
    while (true) {
      const current = await jobsRepository.findByIdForWrite(job.id);
      if (
        current?.status !== "in_progress" ||
        current.execution_generation !== job.execution_generation
      ) {
        throw new StaleJobExecutionError(job.id);
      }
      const currentData = readAgentDeleteJobData(current);
      const authorityData = hasCompleteAgentDeleteAuthority(currentData)
        ? currentData
        : hasCompleteAgentDeleteAuthority(claimedData)
          ? claimedData
          : currentData;
      const jobResult: AgentDeleteJobResult = {
        cloudAgentId: claimedData.agentId,
        containerStopped: result.containerStopped,
        rowDeleted: result.rowDeleted,
        ...agentDeleteAuthorityResult(authorityData),
      };
      const settled = await jobsRepository.settleExecution(
        job,
        "completed",
        {
          result: jobRecord<AgentDeleteJobResult>(jobResult),
          completed_at: new Date(),
          error: null,
          error_storage: "inline",
          error_key: null,
        },
        this.executionOwnerId,
        agentDeleteAuthorityFence(currentData),
      );
      if (settled) return jobResult;
      await this.assertExecutionMutationLease(job);
    }
  }

  /**
   * Requeues the exact active delete after a concurrent request strengthened
   * its durable state-loss authority. The fresh row is used as the retry CAS
   * token, and the result records the actual first acknowledging actor before
   * the execution lease is released.
   */
  private async requeueDeleteWithUpgradedAuthority(
    claimedJob: Job,
    error: string,
  ): Promise<Job | undefined> {
    const current = await jobsRepository.findByIdForWrite(claimedJob.id);
    if (
      current?.status !== "in_progress" ||
      current.execution_generation !== claimedJob.execution_generation
    ) {
      return undefined;
    }
    const currentData = readAgentDeleteJobData(current);
    if (!hasCompleteAgentDeleteAuthority(currentData)) return undefined;

    const priorResult = current.result && typeof current.result === "object" ? current.result : {};
    const authoritySnapshot = await this.retryOwnedWrite(
      claimedJob,
      "record-delete-authority",
      () =>
        jobsRepository.updateForExecution(
          current,
          {
            result: {
              ...priorResult,
              ...agentDeleteAuthorityResult(currentData),
            },
          },
          this.executionOwnerId,
        ),
    );
    return await this.retryOwnedWrite(claimedJob, "retry-upgraded-delete-authority", () =>
      jobsRepository.retryLaterWithoutIncrementingAttempts(
        authoritySnapshot,
        error,
        0,
        this.executionOwnerId,
      ),
    );
  }

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

    // Process each job type in this daemon's lane. The memory-intensive
    // snapshot lane is gated out of CLAIMING (fail-closed, #16639) and, when
    // enabled, forced sequential (batch 1) so phases settle before another
    // payload is allocated. The stale sweep below deliberately keeps the
    // full lane list: flipping a stuck in_progress row back to pending is a
    // DB-only operation with no hydration, and gated rows simply wait as
    // pending until operators enable the lane.
    for (const jobType of this.filterSnapshotLane(jobTypes, "claim")) {
      const laneBatch = jobType === JOB_TYPES.AGENT_SNAPSHOT ? 1 : batchSize;
      await this.processJobType(jobType, laneBatch, result);
    }

    // Recover legacy or already-quiesced stale claims, scoped to the same lane
    // so a lane-scoped daemon never resets the OTHER lane's rows. Generated
    // active attempts stay owned until settlement or daemon startup recovery.
    const recovery = await this.recoverStaleJobs(jobTypes);
    if (recovery.retried > 0 || recovery.permanentlyFailed > 0) {
      logger.info("[provisioning-jobs] Recovered stale jobs", {
        retried: recovery.retried,
        permanentlyFailed: recovery.permanentlyFailed,
      });
    }

    return result;
  }

  /**
   * Fail-closed gate for the memory-intensive `agent_snapshot` lane (#16639).
   * The lane is DISABLED unless `ELIZA_SNAPSHOT_JOBS_ENABLED` is exactly
   * "true": production repeatedly exhausted the worker heap hydrating
   * snapshots, and disabling backup verification did not disable hydration.
   * Claim and startup recovery both honor the gate, so a restart cannot
   * resurrect snapshot jobs before operators re-enable them; every other
   * lifecycle lane stays independently operable.
   */
  static snapshotJobsEnabled(): boolean {
    return process.env.ELIZA_SNAPSHOT_JOBS_ENABLED === "true";
  }

  private snapshotGateLogged = false;

  private filterSnapshotLane(
    jobTypes: readonly ProvisioningJobType[],
    where: string,
  ): readonly ProvisioningJobType[] {
    if (ProvisioningJobService.snapshotJobsEnabled()) return jobTypes;
    const filtered = jobTypes.filter((t) => t !== JOB_TYPES.AGENT_SNAPSHOT);
    if (filtered.length !== jobTypes.length && !this.snapshotGateLogged) {
      this.snapshotGateLogged = true;
      logger.warn(
        `[provisioning-jobs] agent_snapshot lane disabled (${where}): set ELIZA_SNAPSHOT_JOBS_ENABLED=true to enable`,
      );
    }
    return filtered;
  }

  /**
   * One-shot scan for pre-start claims whose renewable owner lease has expired.
   * A deployment may overlap two live workers, so process start time narrows the
   * scan but never authorizes revocation by itself.
   */
  async recoverInterruptedJobsOnStartup(
    startedBefore: Date,
    jobTypes: readonly ProvisioningJobType[] = Object.values(JOB_TYPES),
  ): Promise<ProvisioningRecoverySummary> {
    const summary = emptyRecoverySummary();

    for (const jobType of this.filterSnapshotLane(jobTypes, "startup-recovery")) {
      const result = await jobsRepository.recoverInProgressJobsStartedBefore({
        type: jobType,
        startedBefore,
        buildFailureWriteback: this.dependentRowWritebackBuilder(jobType),
      });
      addRecoveryResult(summary, result);
    }

    assertRecoveryHealthy("startup", summary);
    return summary;
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
    const isSharedImageChange = SHARED_IMAGE_CHANGE_JOB_TYPES.includes(
      jobType as ProvisioningJobType,
    );
    const claimedJobs = isSharedImageChange
      ? await jobsRepository.claimPendingJobsWithinSharedRunningLimit({
          type: jobType,
          sharedTypes: SHARED_IMAGE_CHANGE_JOB_TYPES,
          maxRunning: ADMIN_CANARY_MAX_RUNNING_JOBS,
          limit: batchSize,
          executionOwnerId: this.executionOwnerId,
          executionLeaseMs: this.leaseDurationForJobType(jobType),
        })
      : await jobsRepository.claimPendingJobs({
          type: jobType,
          limit: batchSize,
          executionOwnerId: this.executionOwnerId,
          executionLeaseMs: this.leaseDurationForJobType(jobType),
        });

    for (const job of claimedJobs) {
      result.claimed++;
      const stopLeaseHeartbeat = this.startExecutionLeaseHeartbeat(job);
      const execution = this.executeJob(job);

      try {
        await withTimeout(execution, this.executionTimeoutMs(job.type), `job ${job.type}`);
        result.succeeded++;
        stopLeaseHeartbeat();
      } catch (err) {
        if (safeErrorKind(err, OperationTimeoutError)) {
          const errorMsg = err.message;
          result.failed++;
          result.errors.push({ jobId: job.id, error: errorMsg });
          logger.warn(
            "[provisioning-jobs] Execution timed out; retaining ownership until quiescent",
            {
              jobId: job.id,
              executionGeneration: job.execution_generation,
              timeoutMs: err.timeoutMs,
            },
          );
          // error-policy:J5 the detached result and terminal supervisor rejection
          // stay observed until settlement commits or a successor wins takeover.
          void execution
            .then(
              () => stopLeaseHeartbeat(),
              async (executionError) => {
                try {
                  if (await this.handleExecutionFailure(job, executionError)) {
                    await this.releaseProviderAdmissionAfterRecordedFailure(job);
                  }
                } finally {
                  stopLeaseHeartbeat();
                }
              },
            )
            .catch((settlementError) => {
              logger.warn("[provisioning-jobs] Detached settlement supervisor stopped", {
                jobId: job.id,
                executionGeneration: job.execution_generation,
                error: jobErrorText(settlementError),
              });
            });
          continue;
        }
        try {
          if (await this.handleExecutionFailure(job, err, result)) {
            await this.releaseProviderAdmissionAfterRecordedFailure(job);
          }
        } finally {
          stopLeaseHeartbeat();
        }
      }
    }
  }

  private async handleExecutionFailure(
    job: Job,
    err: unknown,
    result?: ProcessingResult,
  ): Promise<boolean> {
    const appCacheError = safeErrorKind(err, AppCacheInvalidationRetryError) ? err : undefined;
    const retryableTransportError = safeErrorKind(err, RetryableProvisionTransportError)
      ? err
      : safeErrorKind(err, RetryableReplacementCleanupError)
        ? err
        : undefined;
    // This is the value that reaches the `jobs.error` column, so it is the one
    // that has to carry a stack — the 16 conversions below it are log lines.
    const errorMsg = appCacheError
      ? finalizeJobErrorText(formatAppCacheInvalidationError(appCacheError))
      : retryableTransportError instanceof RetryableProvisionTransportError &&
          retryableTransportError.durableErrorText !== undefined
        ? retryableTransportError.durableErrorText
        : jobErrorText(err);
    result?.errors.push({ jobId: job.id, error: errorMsg });

    if (safeErrorKind(err, RejectedAgentExecutionError)) {
      const outcome = await this.retryOwnedWrite(job, "reject-agent-execution", () =>
        jobsRepository.rejectClaimedExecution(job, errorMsg, this.executionOwnerId),
      );
      if (outcome === "rejected" || outcome === "already-terminal") {
        if (result) result.failed++;
        logger.warn("[provisioning-jobs] Rejected invalid agent execution before dispatch", {
          jobId: job.id,
          jobType: job.type,
          outcome,
          error: errorMsg,
        });
      } else {
        logger.info("[provisioning-jobs] Invalid agent execution lost its exact claim", {
          jobId: job.id,
          jobType: job.type,
          outcome,
          error: errorMsg,
        });
      }
      return outcome === "rejected" || outcome === "already-terminal";
    }

    if (retryableTransportError) {
      const retrySnapshot = retryableTransportError.retrySnapshot;
      const onExhaustedInTx = this.buildPermanentFailureWriteback(retrySnapshot, errorMsg);
      let transition = await this.retryOwnedWrite(job, "retry-later", () =>
        jobsRepository.retryLaterWithoutIncrementingAttempts(
          retrySnapshot,
          errorMsg,
          PROVISION_TRANSPORT_RETRY_DELAY_MS,
          this.executionOwnerId,
          { maxRequeues: retryableTransportError.maxRequeues, onExhaustedInTx },
        ),
      );
      if (
        !transition &&
        retrySnapshot.type === JOB_TYPES.AGENT_DELETE &&
        readAgentDeleteJobData(retrySnapshot).stateLossAcknowledged !== true
      ) {
        transition = await this.requeueDeleteWithUpgradedAuthority(retrySnapshot, errorMsg);
      }
      if (transition?.status === "pending") {
        if (result) result.retried++;
        logger.warn("[provisioning-jobs] Requeued retryable provision transport failure", {
          jobId: job.id,
          delayMs: PROVISION_TRANSPORT_RETRY_DELAY_MS,
          requeues: transition.retryable_requeues,
          maxRequeues: retryableTransportError.maxRequeues,
          error: errorMsg,
        });
      } else if (transition?.status === "failed") {
        if (result) result.failed++;
        logger.error("[provisioning-jobs] Retryable failure exhausted its requeue budget", {
          jobId: job.id,
          requeues: transition.retryable_requeues,
          maxRequeues: retryableTransportError.maxRequeues,
          error: errorMsg,
        });
      } else {
        logger.info("[provisioning-jobs] Retryable failure lost its exact job-state claim", {
          jobId: job.id,
          error: errorMsg,
        });
      }
      return transition !== undefined;
    }

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
    const upgradeFailure = safeErrorKind(err, UpgradeFailedError) ? err : undefined;
    const unacknowledgedDeleteFailure = safeErrorKind(err, UnacknowledgedAgentDeleteError)
      ? err
      : undefined;
    const onFailedInTx = this.buildPermanentFailureWriteback(job, errorMsg, upgradeFailure);
    const updated = await this.retryOwnedWrite(job, "increment-attempt", () =>
      jobsRepository.incrementAttempt(
        job.id,
        errorMsg,
        job.max_attempts,
        onFailedInTx,
        job.execution_generation ?? undefined,
        this.executionOwnerId,
        unacknowledgedDeleteFailure
          ? sql`NOT (
              COALESCE(${jobs.data}->>'stateLossAcknowledged', 'false') = 'true'
              AND NULLIF(${jobs.data}->>'stateLossAcknowledgedByUserId', '') IS NOT NULL
              AND NULLIF(${jobs.data}->>'stateLossAcknowledgedAt', '') IS NOT NULL
            )`
          : undefined,
      ),
    );
    if (!updated && unacknowledgedDeleteFailure) {
      const transition = await this.requeueDeleteWithUpgradedAuthority(
        unacknowledgedDeleteFailure.retrySnapshot,
        errorMsg,
      );
      if (transition?.status === "pending") {
        if (result) result.retried++;
        logger.warn(
          "[provisioning-jobs] Requeued delete after in-flight state-loss authority upgrade",
          {
            jobId: job.id,
            executionGeneration: job.execution_generation,
            acknowledgingUserId: readAgentDeleteJobData(transition).stateLossAcknowledgedByUserId,
          },
        );
        return true;
      }
    }
    if (result) result.failed++;
    if (appCacheError) {
      const context = {
        jobId: job.id,
        attempts: updated?.attempts ?? job.attempts,
        maxAttempts: job.max_attempts,
        error: errorMsg,
      };
      if (updated?.status === "failed") {
        logger.error(
          "[provisioning-jobs] App cache invalidation exhausted its retry budget",
          context,
        );
      } else {
        logger.warn("[provisioning-jobs] App cache invalidation failed; retry scheduled", context);
      }
    }
    return updated !== undefined;
  }

  /**
   * Builds the in-transaction dependent-row writeback for a job that has just
   * exhausted its retries. Returned callback runs INSIDE incrementAttempt's
   * transaction (atomic with the job-status `failed` flip). Returns undefined
   * for job types outside `DEPENDENT_ROW_JOB_TYPES`, which own no such row.
   */
  private buildPermanentFailureWriteback(
    job: Job,
    errorMsg: string,
    upgradeFailure?: UpgradeFailedError,
  ): ((tx: DbTransaction, failedJob: Job) => Promise<void>) | undefined {
    if (!ownsDependentRow(job.type)) return undefined;
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
      case JOB_TYPES.AGENT_RESTART: {
        const { agentId, organizationId } = readAgentRestartJobData(job);
        return async (tx) => {
          const [failedWarmClaim] = await tx
            .update(agentSandboxes)
            .set({
              status: "error",
              warm_claim_credential_state: "failed",
              warm_claim_cleanup_completed_at: null,
              error_message: `Warm-claim credential recovery permanently failed after ${job.max_attempts} attempts: ${errorMsg}`,
              updated_at: new Date(),
            })
            .where(
              and(
                eq(agentSandboxes.id, agentId),
                eq(agentSandboxes.organization_id, organizationId),
                isNotNull(agentSandboxes.claimed_at),
                sql`${agentSandboxes.warm_claim_credential_state} IN ('pending', 'attested')`,
                sql`${agentSandboxes.deleted_at} IS NULL`,
              ),
            )
            .returning({ id: agentSandboxes.id });
          if (failedWarmClaim) {
            logger.warn(
              "[provisioning-jobs] Marked exhausted warm-claim handoff failed for durable credential cleanup",
              { jobId: job.id, agentId, organizationId },
            );
          }
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
      case JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE: {
        const data = readAdminCanaryImageJobData(job);
        return async (tx) => {
          const finishedAt = new Date();
          const result: AdminCanaryImageJobResult = {
            success: false,
            jobId: job.id,
            operation: data.operation,
            rolloutId: data.rolloutId,
            actorUserId: data.actorUserId,
            decisionAt: data.decisionAt,
            agentId: data.agentId,
            organizationId: data.organizationId,
            targetOwnerUserId: data.targetOwnerUserId,
            sourceImage: data.sourceImage,
            sourceDigest: data.sourceDigest,
            targetImage: data.targetImage,
            targetDigest: data.targetDigest,
            startedAt: jobAuditTimestamp(job.started_at ?? job.updated_at),
            finishedAt: finishedAt.toISOString(),
            error: errorMsg,
          };
          await tx
            .update(jobs)
            .set({
              result: jobRecord<AdminCanaryImageJobResult>(result),
              result_storage: "inline",
              completed_at: finishedAt,
              updated_at: finishedAt,
            })
            .where(eq(jobs.id, job.id));
          logger.warn("[provisioning-jobs] Persisted failed admin canary image audit", {
            jobId: job.id,
            rolloutId: data.rolloutId,
            agentId: data.agentId,
            operation: data.operation,
          });
        };
      }
      // Apps / Product 2: a permanently failed deploy must flip the app off
      // `building`, or the deploy-status route (which echoes
      // `apps.deployment_status`) reports BUILDING forever — the CLI/dashboard
      // never sees the failure. A durable cache task is inserted in the same
      // transaction; its cache deletion runs later outside the transaction.
      // Especially relevant during the lane-migration window, when the agent
      // CP worker (still default=all lanes) claims an APP_DEPLOY it can't run
      // and exhausts retries.
      case JOB_TYPES.APP_DEPLOY: {
        const { appId, deploymentGeneration } = readAppDeployJobData(job);
        return async (tx, failedJob) => {
          const [failedApp] = await tx
            .update(apps)
            .set({ deployment_status: "failed", updated_at: new Date() })
            .where(
              and(
                eq(apps.id, appId),
                eq(apps.organization_id, failedJob.organization_id),
                sql`${apps.metadata}->>${APP_DEPLOYMENT_GENERATION_KEY} = ${deploymentGeneration}`,
              ),
            )
            .returning({ id: apps.id, api_key_id: apps.api_key_id, slug: apps.slug });
          if (failedApp) {
            await enqueueAppCacheInvalidation(tx, failedJob, failedApp);
            logger.warn(
              "[provisioning-jobs] Marked app deployment as failed after permanent failure",
              { jobId: job.id, appId },
            );
          }
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
        const { containerId, deploymentGeneration: jobGeneration } =
          readContainerProvisionJobData(job);
        return async (tx, failedJob) => {
          const [row] = await tx
            .select({
              projectName: containers.project_name,
              organizationId: containers.organization_id,
              metadata: containers.metadata,
            })
            .from(containers)
            .where(
              and(
                eq(containers.id, containerId),
                eq(containers.organization_id, failedJob.organization_id),
              ),
            )
            .limit(1);
          const appId = row?.projectName;
          if (!appId || !isValidUUID(appId)) return;
          const rowGeneration = deploymentGenerationFromMetadata(row.metadata);
          if (jobGeneration && jobGeneration !== rowGeneration) return;
          const deploymentGeneration = jobGeneration ?? rowGeneration;
          const generationFilter = deploymentGeneration
            ? sql`${apps.metadata}->>${APP_DEPLOYMENT_GENERATION_KEY} = ${deploymentGeneration}`
            : sql`${apps.metadata}->>${APP_DEPLOYMENT_GENERATION_KEY} IS NULL`;
          const [failedApp] = await tx
            .update(apps)
            .set({ deployment_status: "failed", updated_at: new Date() })
            .where(
              and(
                eq(apps.id, appId),
                eq(apps.organization_id, row.organizationId),
                generationFilter,
              ),
            )
            .returning({ id: apps.id, api_key_id: apps.api_key_id, slug: apps.slug });
          if (failedApp) {
            await enqueueAppCacheInvalidation(tx, failedJob, failedApp);
            logger.warn(
              "[provisioning-jobs] Marked app deployment as failed after container provision permanent failure",
              { jobId: job.id, containerId, appId },
            );
          }
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
      default: {
        // The guard above already excluded every non-dependent type, so a new
        // arm added to DEPENDENT_ROW_JOB_TYPES without a case here fails to
        // compile rather than silently skipping its dependent row.
        const unhandled: never = job.type;
        throw new Error(`No permanent-failure writeback for job type ${String(unhandled)}`);
      }
    }
  }

  /**
   * Resolves the writeback builder for one job TYPE, before the sweep has a job
   * in hand. A type owning no dependent row gets no builder at all: the
   * repository must hydrate a job's blob-offloaded payload before it can call
   * one, and the object store has no timeout.
   */
  private dependentRowWritebackBuilder(
    jobType: string,
  ): RecoveryFailureWritebackBuilder | undefined {
    if (!ownsDependentRow(jobType)) return undefined;
    return (hydratedJob, error) => this.buildPermanentFailureWriteback(hydratedJob, error);
  }

  /** Parse and cross-check the duplicated agent identity before any handler runs. */
  private assertAgentJobIdentity(
    job: Job,
  ): { agentId: string; organizationId: string } | undefined {
    if (!AGENT_JOB_TYPES.includes(job.type as ProvisioningJobType)) return undefined;

    const raw = job.data && typeof job.data === "object" ? job.data : undefined;
    let identity: { agentId: string; organizationId: string };
    try {
      switch (job.type) {
        case JOB_TYPES.AGENT_COMPUTE_LEASE:
          identity = readAgentComputeLeaseJobData(job);
          break;
        case JOB_TYPES.AGENT_PROVISION:
          identity = readAgentProvisionJobData(job);
          break;
        case JOB_TYPES.AGENT_DELETE:
          identity = readAgentDeleteJobData(job);
          break;
        case JOB_TYPES.AGENT_SUSPEND:
          identity = readAgentSuspendJobData(job);
          break;
        case JOB_TYPES.AGENT_RESUME:
          identity = readAgentResumeJobData(job);
          break;
        case JOB_TYPES.AGENT_SLEEP:
          identity = readAgentSleepJobData(job);
          break;
        case JOB_TYPES.AGENT_WAKE:
          identity = readAgentWakeJobData(job);
          break;
        case JOB_TYPES.AGENT_RESTART:
          identity = readAgentRestartJobData(job);
          break;
        case JOB_TYPES.AGENT_UPGRADE:
          identity = readAgentUpgradeJobData(job);
          break;
        case JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE:
          identity = readAdminCanaryImageJobData(job);
          break;
        case JOB_TYPES.AGENT_DOWNGRADE:
          identity = readAgentDowngradeJobData(job);
          break;
        case JOB_TYPES.AGENT_LOGS:
          identity = readAgentLogsJobData(job);
          break;
        case JOB_TYPES.AGENT_MESSAGE:
          identity = readAgentMessageJobData(job);
          break;
        case JOB_TYPES.AGENT_SNAPSHOT:
          identity = readAgentSnapshotJobData(job);
          break;
        default:
          throw new Error(`No identity parser for agent job type ${job.type}`);
      }
    } catch (cause) {
      // error-policy:J3 an unparseable job payload becomes an explicit terminal
      // rejection, never a fake-valid identity. The cause is carried as a
      // string rather than the Error so a malformed payload cannot smuggle a
      // value into the persisted failure row.
      throw new RejectedAgentExecutionError(`Invalid agent job payload for job ${job.id}`, {
        jobId: job.id,
        jobType: job.type,
        columnAgentId: job.agent_id,
        columnOrganizationId: job.organization_id,
        payloadAgentId: typeof raw?.agentId === "string" ? raw.agentId : null,
        payloadOrganizationId: typeof raw?.organizationId === "string" ? raw.organizationId : null,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }

    if (
      identity.agentId.trim().length === 0 ||
      identity.organizationId.trim().length === 0 ||
      identity.agentId !== job.agent_id ||
      identity.organizationId !== job.organization_id
    ) {
      throw new RejectedAgentExecutionError(
        `Agent job identity does not match indexed columns for job ${job.id}`,
        {
          jobId: job.id,
          jobType: job.type,
          columnAgentId: job.agent_id,
          columnOrganizationId: job.organization_id,
          payloadAgentId: identity.agentId,
          payloadOrganizationId: identity.organizationId,
        },
      );
    }
    return identity;
  }

  private async assertNoConflictingLifecycleExecution(job: Job): Promise<void> {
    const identity = this.assertAgentJobIdentity(job);
    if (!identity) return;
    if (!job.execution_generation) {
      throw new Error(`Claimed lifecycle job ${job.id} has no execution generation`);
    }
    await this.assertExecutionMutationLease(job);
    const prepare = async (): Promise<void> => {
      await dbWrite.transaction(async (tx) => {
        await configureElizaLifecycleTransaction(tx);
        // PGlite's TCP bridge does not release transaction-scoped advisory
        // locks reliably at commit. Local Docker retains the exact job,
        // generation, lease, conflict, and sandbox-row fences below.
        if (!usesLocalDockerSandboxProvider()) {
          await tx.execute(
            elizaProvisionAdvisoryLockSql(identity.organizationId, identity.agentId),
          );
        }
        const [currentJob] = await tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            and(
              eq(jobs.id, job.id),
              eq(jobs.status, "in_progress"),
              sql`${jobs.execution_generation} IS NOT DISTINCT FROM ${job.execution_generation}`,
              isNull(jobs.execution_quiesced_at),
              sql`EXISTS (
              SELECT 1
              FROM ${jobExecutionLeases}
              WHERE ${jobExecutionLeases.job_id} = ${job.id}
                AND ${jobExecutionLeases.execution_generation} = ${job.execution_generation}
                AND ${jobExecutionLeases.owner_id} = ${this.executionOwnerId}
                AND ${jobExecutionLeases.expires_at} > NOW()
            )`,
            ),
          )
          .limit(1);
        if (!currentJob) {
          throw new Error(`Lifecycle execution generation is no longer current: ${job.id}`);
        }

        const [sandboxAuthority] = await tx
          .select({
            executionTier: agentSandboxes.execution_tier,
            pool_status: agentSandboxes.pool_status,
            deleted_at: agentSandboxes.deleted_at,
            deletion_attempt_id: agentSandboxes.deletion_attempt_id,
          })
          .from(agentSandboxes)
          .where(
            and(
              eq(agentSandboxes.id, identity.agentId),
              eq(agentSandboxes.organization_id, identity.organizationId),
            ),
          )
          .for("update")
          .limit(1);
        if (
          requiresContainerBackedTarget(job.type) &&
          (!sandboxAuthority || !isContainerBackedExecutionTier(sandboxAuthority.executionTier))
        ) {
          throw new RejectedAgentExecutionError(
            `${CONTAINER_BACKED_TARGET_REQUIRED_MESSAGE}: ${job.type}`,
            {
              jobId: job.id,
              jobType: job.type,
              columnAgentId: job.agent_id,
              columnOrganizationId: job.organization_id,
              payloadAgentId: identity.agentId,
              payloadOrganizationId: identity.organizationId,
              executionTier: sandboxAuthority?.executionTier ?? "missing",
            },
          );
        }

        if (job.type === JOB_TYPES.AGENT_SNAPSHOT && sandboxAuthority) {
          const rejection = snapshotAuthorityRejection(sandboxAuthority);
          if (rejection) {
            throw new RejectedAgentExecutionError(rejection, {
              jobId: job.id,
              jobType: job.type,
              columnAgentId: job.agent_id,
              columnOrganizationId: job.organization_id,
              payloadAgentId: identity.agentId,
              payloadOrganizationId: identity.organizationId,
              executionTier: sandboxAuthority.executionTier,
            });
          }
        }

        if (!EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES.includes(job.type as ProvisioningJobType)) return;

        const [conflict] = await tx
          .select({ id: jobs.id, type: jobs.type, status: jobs.status })
          .from(jobs)
          .where(
            and(
              eq(jobs.organization_id, job.organization_id),
              eq(jobs.agent_id, identity.agentId),
              inArray(jobs.type, EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES),
              ne(jobs.id, job.id),
              sql`${jobs.status} IN ('pending', 'in_progress')`,
              // A manual suspend may be a durable follow-up to an already claimed
              // billing suspend. Both executions serialize on the sandbox row in
              // executeSuspend; treating them as a conflict would strand the
              // unconditional follow-up behind the stale hydrated billing job.
              or(ne(jobs.type, job.type), ne(jobs.type, JOB_TYPES.AGENT_SUSPEND)),
            ),
          )
          .orderBy(desc(jobs.created_at))
          .limit(1);
        if (conflict) {
          throw new ApiError(
            409,
            "session_not_ready",
            `Agent ${job.agent_id} has conflicting ${conflict.type} job ${conflict.id}`,
            {
              conflictingJobId: conflict.id,
              conflictingJobType: conflict.type,
              conflictingJobStatus: conflict.status,
            },
          );
        }
        const claimedSandbox = await updateAgentLifecycleExecutionFence(
          tx,
          job,
          job.execution_generation!,
          "claim",
        );
        if (!claimedSandbox) {
          const [existingSandbox] = await tx
            .select({ id: agentSandboxes.id })
            .from(agentSandboxes)
            .where(
              and(
                eq(agentSandboxes.id, identity.agentId),
                eq(agentSandboxes.organization_id, identity.organizationId),
              ),
            )
            .limit(1);
          if (existingSandbox) {
            throw new Error(
              `Agent lifecycle resource generation is already owned: ${job.agent_id}`,
            );
          }
        }
      });
    };
    if (!ACCOUNT_LIFECYCLE_FENCED_AGENT_JOB_TYPES.includes(job.type as ProvisioningJobType)) {
      await prepare();
      return;
    }
    try {
      await prepareProvisioningWithAccountLifecycleFence(identity.organizationId, prepare);
    } catch (error) {
      if (!(error instanceof AccountLifecycleFencedError)) throw error;
      throw new RejectedAgentExecutionError(`Account lifecycle fenced provisioning job ${job.id}`, {
        jobId: job.id,
        jobType: job.type,
        columnAgentId: job.agent_id,
        columnOrganizationId: job.organization_id,
        payloadAgentId: identity.agentId,
        payloadOrganizationId: identity.organizationId,
        cause: "account_lifecycle_fenced_or_stale",
      });
    }
  }

  private async executeJob(job: Job): Promise<void> {
    await this.assertNoConflictingLifecycleExecution(job);
    if (this.executionOverride) {
      await this.executionOverride(job);
      return;
    }
    const providerAdmission = this.providerAdmissionForJob(job);
    if (!providerAdmission) {
      await this.executeJobDispatch(job);
      return;
    }
    try {
      await executeProvisioningWithAccountLifecycleAdmission({
        authority: providerAdmission,
        acquire: this.acquireProviderAdmission,
        release: this.releaseProviderAdmission,
        execute: () => this.executeJobDispatch(job),
      });
    } catch (error) {
      if (!(error instanceof AccountLifecycleFencedError)) throw error;
      const identity = this.assertAgentJobIdentity(job);
      throw new RejectedAgentExecutionError(
        `Account lifecycle fenced provider admission ${job.id}`,
        {
          jobId: job.id,
          jobType: job.type,
          columnAgentId: job.agent_id,
          columnOrganizationId: job.organization_id,
          payloadAgentId: identity?.agentId,
          payloadOrganizationId: identity?.organizationId,
          cause: "account_lifecycle_fenced_or_stale",
        },
      );
    }
  }

  private providerAdmissionForJob(job: Job): ProviderAdmissionAuthority | undefined {
    if (!ACCOUNT_LIFECYCLE_FENCED_AGENT_JOB_TYPES.includes(job.type as ProvisioningJobType)) {
      return undefined;
    }
    return {
      organizationId: job.organization_id,
      operationKind: "agent_lifecycle",
      operationId: job.id,
    };
  }

  private async releaseProviderAdmissionAfterRecordedFailure(job: Job): Promise<void> {
    const authority = this.providerAdmissionForJob(job);
    if (authority) await this.releaseProviderAdmission(authority);
  }

  private async executeJobDispatch(job: Job): Promise<void> {
    if (
      PRICED_AGENT_START_JOB_TYPES.includes(job.type) &&
      job.data.admittedComputePrice !== getDedicatedComputePriceAcceptance()
    ) {
      throw new RejectedAgentExecutionError(
        "Dedicated start price is missing or changed. Review the current price and submit a new start request; no runtime action was dispatched.",
        {
          jobId: job.id,
          jobType: job.type,
          columnAgentId: job.agent_id,
          columnOrganizationId: job.organization_id,
          cause: "dedicated_compute_price_confirmation_required",
        },
      );
    }
    switch (job.type) {
      case JOB_TYPES.AGENT_COMPUTE_LEASE: {
        const result = await executeAgentComputeLeaseJob(job, () =>
          this.assertExecutionMutationLease(job),
        );
        await this.settleClaimedExecution(job, "completed", {
          result,
          completed_at: new Date(),
        });
        break;
      }
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
      case JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE:
        await this.executeAdminCanaryImage(job);
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
        await this.assertExecutionMutationLease(job);
        await dispatchContainerJob(job, getContainerExecutorDeps());
        await this.settleClaimedExecution(job, "completed", {
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
        await this.assertExecutionMutationLease(job);
        const outcome = await dispatchContainerStopJob(job, {
          executionOwnerId: this.executionOwnerId,
        });
        await this.settleClaimedExecution(job, "completed", {
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
        await this.assertExecutionMutationLease(job);
        await dispatchAppDeployJob(job);
        await this.settleClaimedExecution(job, "completed", {
          completed_at: new Date(),
        });
        break;
      // Apps lane (Product 2): tear down a deleted app's isolated tenant DB.
      // The Worker enqueues this; the daemon runs the real DROP + slot release
      // via the injected deprovisioner (wired in apps-deploy-backend). (#8342)
      case JOB_TYPES.APP_DB_DEPROVISION: {
        await this.assertExecutionMutationLease(job);
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
        await this.settleClaimedExecution(job, "completed", {
          result: {
            deprovisioned: outcome.deprovisioned,
            reason: outcome.reason ?? null,
          },
          completed_at: new Date(),
        });
        break;
      }
      case JOB_TYPES.APP_CACHE_INVALIDATE:
        await this.assertExecutionMutationLease(job);
        await dispatchAppCacheInvalidationJob(job);
        await this.settleClaimedExecution(job, "completed", {
          completed_at: new Date(),
        });
        break;
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
    await this.settleClaimedExecution(job, "completed", {
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
    const authority = await this.resolveAgentSuspendAuthority(job);

    if (data.organizationId !== job.organization_id) {
      throw new Error(
        `Organization ID mismatch: job.data.organizationId (${data.organizationId}) !== job.organization_id (${job.organization_id})`,
      );
    }

    logger.info("[provisioning-jobs] Executing agent_suspend", {
      jobId: job.id,
      agentId: data.agentId,
    });

    await this.assertExecutionMutationLease(job);
    const result = await elizaSandboxService.executeSuspend(
      data.agentId,
      data.organizationId,
      job.id,
      authority.authorization,
      authority.lifecycleRevision,
    );

    if (await this.completeIfAgentGone(job, result, data.agentId)) return;

    if (!result.success) {
      await this.updateClaimedExecution(job, {
        result: jobRecord<AgentSuspendJobResult>({
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
      backupId: result.backupId,
      ...(result.skipped ? { skipped: true as const, reason: result.reason } : {}),
    };

    await this.settleClaimedExecution(job, "completed", {
      result: jobRecord<AgentSuspendJobResult>(jobResult),
      completed_at: new Date(),
    });

    if (job.webhook_url) {
      await this.fireWebhook(job, jobResult);
    }

    logger.info("[provisioning-jobs] agent_suspend completed", {
      jobId: job.id,
      agentId: data.agentId,
      containerStopped: result.containerStopped,
      backupId: result.backupId,
      skipped: result.skipped ?? false,
      reason: result.reason,
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

    await this.assertExecutionMutationLease(job);
    if (data.automaticResume) {
      const skipped = await this.automaticResumeRejection(job, data);
      if (skipped) {
        // The billing stop was superseded (user stop, deletion, newer
        // generation) or funding lapsed again. Report the no-op honestly.
        await this.settleClaimedExecution(job, "completed", {
          result: jobRecord<AgentResumeJobResult>({
            cloudAgentId: data.agentId,
            containerStarted: false,
            reprovisioned: false,
            skipped,
          }),
          completed_at: new Date(),
        });
        logger.info("[provisioning-jobs] automatic billing resume skipped", {
          jobId: job.id,
          agentId: data.agentId,
          reason: skipped,
        });
        return;
      }
    }
    const result = await elizaSandboxService.executeResume(data.agentId, data.organizationId);

    if (await this.completeIfAgentGone(job, result, data.agentId)) return;

    if (!result.success) {
      await this.updateClaimedExecution(job, {
        result: jobRecord<AgentResumeJobResult>({
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

    await this.settleClaimedExecution(job, "completed", {
      result: jobRecord<AgentResumeJobResult>(jobResult),
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

  /** Execution-time recheck of an automatic billing resume on the primary. */
  private async automaticResumeRejection(
    job: Job,
    data: AgentResumeJobData,
  ): Promise<AgentResumeJobResult["skipped"]> {
    const stopIntentId = data.automaticResume?.stopIntentId;
    if (!stopIntentId) return undefined;
    const candidate: BillingResumeCandidate = {
      intentId: stopIntentId,
      agentId: data.agentId,
      organizationId: data.organizationId,
      userId: data.userId,
    };
    const authorized = await dbWrite.transaction(async (tx) => {
      await configureElizaLifecycleTransaction(tx);
      await tx.execute(elizaProvisionAdvisoryLockSql(data.organizationId, data.agentId));
      return billingResumeStillAuthorizedInTransaction(tx, candidate, job.id);
    });
    if (!authorized) return "authority_changed";
    const funding = await checkAgentCreditGate(data.organizationId);
    return funding.allowed ? undefined : "unfunded";
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

    await this.assertExecutionMutationLease(job);
    const result = await elizaSandboxService.executeSleep(data.agentId, data.organizationId);

    if (await this.completeIfAgentGone(job, result, data.agentId)) return;

    if (!result.success) {
      await this.updateClaimedExecution(job, {
        result: jobRecord<AgentSleepJobResult>({
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

    await this.settleClaimedExecution(job, "completed", {
      result: jobRecord<AgentSleepJobResult>(jobResult),
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

    await this.assertExecutionMutationLease(job);
    const result = await elizaSandboxService.executeWake(data.agentId, data.organizationId, {
      restoreBackupId: data.restoreBackupId,
      forceFreshBoot: data.forceFreshBoot,
    });

    if (await this.completeIfAgentGone(job, result, data.agentId)) return;

    if (!result.success) {
      await this.updateClaimedExecution(job, {
        result: jobRecord<AgentWakeJobResult>({
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

    await this.settleClaimedExecution(job, "completed", {
      result: jobRecord<AgentWakeJobResult>(jobResult),
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
      stateLossAcknowledged: data.stateLossAcknowledged || undefined,
    });

    await this.assertExecutionMutationLease(job);
    const result = await elizaSandboxService.executeRestart(data.agentId, data.organizationId, {
      stateLossAcknowledged: data.stateLossAcknowledged,
    });

    if (await this.completeIfAgentGone(job, result, data.agentId)) return;

    if (!result.success) {
      const retrySnapshot = await this.updateClaimedExecution(job, {
        result: jobRecord<AgentRestartJobResult>({
          cloudAgentId: data.agentId,
          containerStopped: result.containerStopped,
          containerStarted: result.containerStarted,
          error: result.error,
        }),
      });
      if (result.retryable) {
        throw new RetryableProvisionTransportError(
          result.error ?? "Snapshot capture temporarily unavailable",
          retrySnapshot,
          PROVISION_TRANSPORT_MAX_FREE_RETRIES,
        );
      }
      throw new Error(result.error ?? "Unknown agent_restart failure");
    }

    const jobResult: AgentRestartJobResult = {
      cloudAgentId: data.agentId,
      containerStopped: result.containerStopped,
      containerStarted: result.containerStarted,
      bridgeUrl: result.bridgeUrl,
      healthUrl: result.healthUrl,
    };

    await this.settleClaimedExecution(job, "completed", {
      result: jobRecord<AgentRestartJobResult>(jobResult),
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
    await this.assertExecutionMutationLease(job);
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

    await this.settleClaimedExecution(job, "completed", {
      result: jobRecord<AgentUpgradeJobResult>(jobResult),
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

  private async executeAdminCanaryImage(job: Job): Promise<void> {
    const data = readAdminCanaryImageJobData(job);
    if (data.organizationId !== job.organization_id || data.actorUserId !== job.user_id) {
      throw new Error(`Admin canary audit identity mismatch for job ${job.id}`);
    }
    const startedAt = jobAuditTimestamp(job.started_at ?? job.updated_at);
    const priorCutover = isPendingAdminCanaryCutoverAudit(job.result) ? job.result : undefined;
    const pendingCutoverMatchesSnapshot = (
      pendingAudit: AdminCanaryImageJobResult,
      snapshot: Job,
    ): boolean => {
      const auditStartedAt =
        typeof pendingAudit.startedAt === "string"
          ? Date.parse(pendingAudit.startedAt)
          : Number.NaN;
      const cutoverAt =
        typeof pendingAudit.cutoverAt === "string"
          ? Date.parse(pendingAudit.cutoverAt)
          : Number.NaN;
      const rowStartedAt =
        snapshot.started_at === null
          ? Number.NaN
          : Date.parse(jobAuditTimestamp(snapshot.started_at));
      const rowUpdatedAt = Date.parse(jobAuditTimestamp(snapshot.updated_at));
      const directCutoverSnapshot =
        pendingAudit.startedAt ===
          (snapshot.started_at === null ? "" : jobAuditTimestamp(snapshot.started_at)) &&
        pendingAudit.cutoverAt === jobAuditTimestamp(snapshot.updated_at);
      const resumedCleanupClaim = cutoverResumeWindowAllows({
        cutoverAtMs: cutoverAt,
        rowStartedAtMs: rowStartedAt,
        rowUpdatedAtMs: rowUpdatedAt,
      });
      return (
        Number.isFinite(auditStartedAt) &&
        Number.isFinite(cutoverAt) &&
        auditStartedAt <= cutoverAt &&
        (directCutoverSnapshot || resumedCleanupClaim) &&
        snapshot.status === "in_progress" &&
        snapshot.type === JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE &&
        snapshot.organization_id === data.organizationId &&
        snapshot.user_id === data.actorUserId &&
        snapshot.agent_id === data.agentId &&
        snapshot.data_storage === "inline" &&
        snapshot.data_key === null &&
        JSON.stringify(snapshot.data) === JSON.stringify(job.data) &&
        snapshot.result_storage === "inline" &&
        snapshot.result_key === null &&
        snapshot.completed_at === null &&
        snapshot.started_at !== null &&
        pendingAudit.finishedAt === pendingAudit.cutoverAt &&
        pendingAudit.jobId === snapshot.id &&
        pendingAudit.operation === data.operation &&
        pendingAudit.rolloutId === data.rolloutId &&
        pendingAudit.actorUserId === data.actorUserId &&
        pendingAudit.decisionAt === data.decisionAt &&
        pendingAudit.agentId === data.agentId &&
        pendingAudit.organizationId === data.organizationId &&
        pendingAudit.targetOwnerUserId === data.targetOwnerUserId &&
        pendingAudit.sourceImage === data.sourceImage &&
        pendingAudit.sourceDigest === data.sourceDigest &&
        pendingAudit.targetImage === data.targetImage &&
        pendingAudit.targetDigest === data.targetDigest &&
        typeof pendingAudit.oldNodeId === "string" &&
        pendingAudit.oldNodeId.length > 0 &&
        typeof pendingAudit.oldContainerName === "string" &&
        pendingAudit.oldContainerName.length > 0 &&
        typeof pendingAudit.newNodeId === "string" &&
        pendingAudit.newNodeId.length > 0 &&
        typeof pendingAudit.newContainerName === "string" &&
        pendingAudit.newContainerName.length > 0
      );
    };
    let completedAudit: AdminCanaryImageJobResult | undefined;
    const completeCutoverInTx = async (
      tx: DbTransaction,
      pendingAudit: AdminCanaryImageJobResult,
      snapshot: Job,
    ): Promise<void> => {
      const finishedAt = new Date();
      const completion: AdminCanaryImageJobResult = {
        ...pendingAudit,
        success: true,
        cleanupPending: false,
        finishedAt: finishedAt.toISOString(),
      };
      const [updated] = await tx
        .update(jobs)
        .set({
          status: "completed",
          result: jobRecord<AdminCanaryImageJobResult>(completion),
          result_storage: "inline",
          result_key: null,
          error: null,
          error_storage: "inline",
          error_key: null,
          completed_at: finishedAt,
          execution_quiesced_at: finishedAt,
          updated_at: finishedAt,
        })
        .where(
          and(
            eq(jobs.id, snapshot.id),
            eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE),
            eq(jobs.status, "in_progress"),
            eq(jobs.organization_id, data.organizationId),
            eq(jobs.agent_id, data.agentId),
            eq(jobs.user_id, data.actorUserId),
            eq(jobs.attempts, snapshot.attempts),
            eq(jobs.max_attempts, snapshot.max_attempts),
            sql`${jobs.execution_generation} IS NOT DISTINCT FROM ${snapshot.execution_generation}`,
            isNull(jobs.execution_quiesced_at),
            // #17919 / #17284 class: ms-window fence so µs-stored NOW() rows match JS reads
            msWindowTimestampMatch(
              jobs.started_at,
              snapshot.started_at ? new Date(jobAuditTimestamp(snapshot.started_at)) : null,
            ),
            msWindowTimestampMatch(
              jobs.completed_at,
              snapshot.completed_at ? new Date(jobAuditTimestamp(snapshot.completed_at)) : null,
            ),
            msWindowTimestampMatch(
              jobs.updated_at,
              new Date(jobAuditTimestamp(snapshot.updated_at)),
            ),
            sql`${jobs.data_storage} = 'inline'`,
            sql`${jobs.data_key} IS NOT DISTINCT FROM ${snapshot.data_key}`,
            sql`${jobs.data} IS NOT DISTINCT FROM ${JSON.stringify(snapshot.data)}::jsonb`,
            sql`${jobs.result_storage} = 'inline'`,
            sql`${jobs.result_key} IS NOT DISTINCT FROM ${snapshot.result_key}`,
            sql`${jobs.result} IS NOT DISTINCT FROM ${JSON.stringify(pendingAudit)}::jsonb`,
            sql`${jobs.error_storage} = ${snapshot.error_storage}`,
            sql`${jobs.error_key} IS NOT DISTINCT FROM ${snapshot.error_key}`,
            sql`${jobs.error} IS NOT DISTINCT FROM ${snapshot.error ?? null}`,
          ),
        )
        .returning({ id: jobs.id });
      if (!updated) {
        throw new AdminCanaryCleanupCommitError(
          `Admin canary job ${snapshot.id} changed before cleanup completion`,
        );
      }
      if (!snapshot.execution_generation) {
        throw new AdminCanaryCleanupCommitError(
          `Admin canary job ${snapshot.id} has no execution generation`,
        );
      }
      await tx
        .update(agentSandboxes)
        .set({
          lifecycle_job_id: null,
          lifecycle_execution_generation: null,
        })
        .where(
          and(
            eq(agentSandboxes.id, data.agentId),
            eq(agentSandboxes.organization_id, data.organizationId),
            eq(agentSandboxes.lifecycle_job_id, snapshot.id),
            eq(agentSandboxes.lifecycle_execution_generation, snapshot.execution_generation),
          ),
        );
      completedAudit = completion;
    };
    if (priorCutover) {
      if (!pendingCutoverMatchesSnapshot(priorCutover, job)) {
        throw new Error(`Admin canary pending-cutover audit mismatch for job ${job.id}`);
      }
      const oldNodeId = priorCutover.oldNodeId as string;
      const oldContainerName = priorCutover.oldContainerName as string;
      const newNodeId = priorCutover.newNodeId as string;
      const newContainerName = priorCutover.newContainerName as string;
      try {
        await elizaSandboxService.convergeReplacementCleanupFence(
          data.agentId,
          data.organizationId,
          {
            targetOwnerUserId: data.targetOwnerUserId,
            targetImage: data.targetImage,
            targetDigest: data.targetDigest,
            newNodeId,
            newContainerName,
            oldNodeId,
            oldContainerName,
          },
          async (tx) => completeCutoverInTx(tx, priorCutover, job),
        );
      } catch (error) {
        if (
          safeErrorKind(error, AdminCanaryCleanupExpectationError) ||
          safeErrorKind(error, AdminCanaryCleanupCommitError)
        ) {
          throw error;
        }
        // error-policy:J2 context-adding rethrow — the queue needs a typed
        // retryable failure while preserving the cleanup cause.
        throw new RetryableReplacementCleanupError(
          // Summary only: the full error travels as `cause` below, and
          // interpolating its stack here would fill the 4,000-char job budget
          // with the inner frames, truncating away both the outer frames and
          // the cause chain at exactly the site #23117 needs them.
          `Admin canary cleanup remains pending: ${jobErrorSummary(error)}`,
          job,
          { cause: error },
        );
      }
      if (!completedAudit) {
        throw new AdminCanaryCleanupCommitError(
          `Admin canary job ${job.id} cleanup converged without a completed audit`,
        );
      }
      logger.info("[provisioning-jobs] Admin canary cleanup converged", {
        jobId: job.id,
        rolloutId: data.rolloutId,
        agentId: data.agentId,
      });
      return;
    }

    let committedAudit: AdminCanaryImageJobResult | undefined;
    let committedJobSnapshot: Job | undefined;
    const onCutoverInTx = async (
      tx: DbTransaction,
      cutover: {
        oldNodeId: string;
        oldContainerName: string;
        newNodeId: string;
        newContainerName: string;
        newDigest: string;
      },
    ): Promise<void> => {
      if (cutover.newDigest !== data.targetDigest) {
        throw new Error(`Admin canary cutover digest mismatch for job ${job.id}`);
      }
      const finishedAt = new Date();
      const cutoverAt = finishedAt.toISOString();
      const jobResult: AdminCanaryImageJobResult = {
        success: false,
        cleanupPending: true,
        cutoverAt,
        jobId: job.id,
        operation: data.operation,
        rolloutId: data.rolloutId,
        actorUserId: data.actorUserId,
        decisionAt: data.decisionAt,
        agentId: data.agentId,
        organizationId: data.organizationId,
        targetOwnerUserId: data.targetOwnerUserId,
        sourceImage: data.sourceImage,
        sourceDigest: data.sourceDigest,
        targetImage: data.targetImage,
        targetDigest: data.targetDigest,
        startedAt,
        finishedAt: cutoverAt,
        oldNodeId: cutover.oldNodeId,
        oldContainerName: cutover.oldContainerName,
        newNodeId: cutover.newNodeId,
        newContainerName: cutover.newContainerName,
      };
      const [updated] = await tx
        .update(jobs)
        .set({
          result: jobRecord<AdminCanaryImageJobResult>(jobResult),
          result_storage: "inline",
          result_key: null,
          error: null,
          error_storage: "inline",
          error_key: null,
          completed_at: null,
          updated_at: finishedAt,
        })
        .where(
          and(
            eq(jobs.id, job.id),
            eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE),
            eq(jobs.status, "in_progress"),
            eq(jobs.organization_id, data.organizationId),
            eq(jobs.agent_id, data.agentId),
            eq(jobs.user_id, data.actorUserId),
            eq(jobs.attempts, job.attempts),
            eq(jobs.max_attempts, job.max_attempts),
            sql`${jobs.execution_generation} IS NOT DISTINCT FROM ${job.execution_generation}`,
            isNull(jobs.execution_quiesced_at),
            // #17919 / #17284 class: ms-window fence so µs-stored NOW() rows match JS reads
            msWindowTimestampMatch(
              jobs.started_at,
              job.started_at ? new Date(jobAuditTimestamp(job.started_at)) : null,
            ),
            msWindowTimestampMatch(
              jobs.completed_at,
              job.completed_at ? new Date(jobAuditTimestamp(job.completed_at)) : null,
            ),
            msWindowTimestampMatch(jobs.updated_at, new Date(jobAuditTimestamp(job.updated_at))),
            sql`${jobs.data_storage} = 'inline'`,
            sql`${jobs.data_key} IS NOT DISTINCT FROM ${job.data_key}`,
            sql`${jobs.data} IS NOT DISTINCT FROM ${JSON.stringify(job.data)}::jsonb`,
            sql`${jobs.result_storage} = ${job.result_storage}`,
            sql`${jobs.result_key} IS NOT DISTINCT FROM ${job.result_key}`,
            job.result == null
              ? sql`${jobs.result} IS NULL`
              : sql`${jobs.result} IS NOT DISTINCT FROM ${JSON.stringify(job.result)}::jsonb`,
            sql`${jobs.error_storage} = ${job.error_storage}`,
            sql`${jobs.error_key} IS NOT DISTINCT FROM ${job.error_key}`,
            sql`${jobs.error} IS NOT DISTINCT FROM ${job.error ?? null}`,
          ),
        )
        .returning();
      if (!updated) {
        throw new Error(`Admin canary job ${job.id} changed before atomic cutover audit`);
      }
      committedAudit = jobResult;
      committedJobSnapshot = await hydrateJob(updated);
    };
    const onConvergedInTx = async (tx: DbTransaction): Promise<void> => {
      if (!committedAudit || !committedJobSnapshot) {
        throw new AdminCanaryCleanupCommitError(
          `Admin canary job ${job.id} cleanup ran without a committed cutover audit`,
        );
      }
      await completeCutoverInTx(tx, committedAudit, committedJobSnapshot);
    };
    const readDurablePendingCutover = async (): Promise<Job | undefined> => {
      const current = await jobsRepository.findByIdForWrite(job.id);
      if (!current || !isPendingAdminCanaryCutoverAudit(current.result)) return undefined;
      return pendingCutoverMatchesSnapshot(current.result, current) ? current : undefined;
    };

    logger.info("[provisioning-jobs] Executing admin canary image change", {
      jobId: job.id,
      rolloutId: data.rolloutId,
      actorUserId: data.actorUserId,
      agentId: data.agentId,
      organizationId: data.organizationId,
      operation: data.operation,
      sourceImage: data.sourceImage,
      sourceDigest: data.sourceDigest,
      targetImage: data.targetImage,
      targetDigest: data.targetDigest,
    });

    let result: Awaited<ReturnType<typeof elizaSandboxService.executeAdminCanaryUpgrade>>;
    await this.assertExecutionMutationLease(job);
    try {
      result =
        data.operation === "upgrade"
          ? await elizaSandboxService.executeAdminCanaryUpgrade({
              agentId: data.agentId,
              organizationId: data.organizationId,
              targetOwnerUserId: data.targetOwnerUserId,
              sourceImage: data.sourceImage,
              sourceDigest: data.sourceDigest,
              targetImage: data.targetImage,
              targetDigest: data.targetDigest,
              onCutoverInTx,
              onConvergedInTx,
            })
          : await elizaSandboxService.executeAdminCanaryRollback({
              agentId: data.agentId,
              organizationId: data.organizationId,
              targetOwnerUserId: data.targetOwnerUserId,
              sourceImage: data.sourceImage,
              sourceDigest: data.sourceDigest,
              targetImage: data.targetImage,
              targetDigest: data.targetDigest,
              onCutoverInTx,
              onConvergedInTx,
            });
    } catch (error) {
      // error-policy:J2 A post-cutover failure is rethrown with the exact
      // durable retry snapshot; failures before cutover retain their identity.
      const retrySnapshot = await readDurablePendingCutover();
      if (retrySnapshot) {
        throw new RetryableReplacementCleanupError(
          `Admin canary post-cutover convergence interrupted: ${jobErrorText(error)}`,
          retrySnapshot,
          { cause: error },
        );
      }
      throw error;
    }

    if (!result.success) {
      if (result.cleanupPending) {
        const retrySnapshot = (await readDurablePendingCutover()) ?? job;
        throw new RetryableReplacementCleanupError(
          result.error ?? "Admin canary pre-cutover cleanup remains pending",
          retrySnapshot,
        );
      }
      throw new Error(result.error ?? "Admin canary image change failed");
    }
    if (!committedAudit) {
      throw new Error(`Admin canary job ${job.id} cut over without a committed audit`);
    }
    if (result.cleanupPending) {
      const retrySnapshot = await readDurablePendingCutover();
      if (!retrySnapshot) {
        throw new Error(`Admin canary job ${job.id} lost its committed cutover audit`);
      }
      throw new RetryableReplacementCleanupError(
        result.error ?? "Admin canary post-cutover cleanup remains pending",
        retrySnapshot,
      );
    }
    if (!completedAudit) {
      throw new AdminCanaryCleanupCommitError(
        `Admin canary job ${job.id} cleanup completed without atomic job completion`,
      );
    }

    logger.info("[provisioning-jobs] Admin canary image change completed", {
      jobId: job.id,
      rolloutId: data.rolloutId,
      actorUserId: data.actorUserId,
      agentId: data.agentId,
      operation: data.operation,
      targetImage: data.targetImage,
      targetDigest: data.targetDigest,
      durationMs: new Date(completedAudit.finishedAt).getTime() - new Date(startedAt).getTime(),
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
    await this.assertExecutionMutationLease(job);
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

    await this.settleClaimedExecution(job, "completed", {
      result: jobRecord<AgentDowngradeJobResult>(jobResult),
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
      await this.updateClaimedExecution(job, {
        result: jobRecord<AgentLogsJobResult>({
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

    await this.settleClaimedExecution(job, "completed", {
      result: jobRecord<AgentLogsJobResult>(jobResult),
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

    await this.assertExecutionMutationLease(job);
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
      await this.updateClaimedExecution(job, {
        result: jobRecord<AgentMessageJobResult>({
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

    await this.settleClaimedExecution(job, "completed", {
      result: jobRecord<AgentMessageJobResult>(jobResult),
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

    // Belt to the lane filter (#16639): a snapshot job claimed through any
    // other path while the gate is off is re-scheduled without burning an
    // attempt — observable, never a fabricated success.
    if (!ProvisioningJobService.snapshotJobsEnabled()) {
      logger.warn("[provisioning-jobs] agent_snapshot blocked by disabled gate", {
        jobId: job.id,
        agentId: data.agentId,
      });
      await this.retryOwnedWrite(job, "snapshot-gate-retry", () =>
        jobsRepository.retryLaterWithoutIncrementingAttempts(
          job,
          "agent_snapshot lane disabled (ELIZA_SNAPSHOT_JOBS_ENABLED != true)",
          SNAPSHOT_GATE_RETRY_DELAY_MS,
          this.executionOwnerId,
        ),
      );
      return;
    }

    logger.info("[provisioning-jobs] Executing agent_snapshot", {
      jobId: job.id,
      agentId: data.agentId,
      snapshotType: data.snapshotType,
    });

    await this.assertExecutionMutationLease(job);
    const result = await elizaSandboxService.executeSnapshot(
      data.agentId,
      data.organizationId,
      data.snapshotType,
    );

    if (await this.completeIfAgentGone(job, result, data.agentId)) return;

    // Attempt bookkeeping (#15783): record that a capture was tried regardless
    // of outcome, and keep the snapshot-capability marker current —
    // `last_backup_at` stays success-only so staleness stays honest, while
    // `backup_unsupported_reason` moves incapable images out of the sweep's
    // hot window until their slow re-probe. A successful capture always
    // clears the marker (the image evidently serves the route now).
    await this.recordSnapshotAttemptMarkers(
      data.agentId,
      result.success
        ? "success"
        : result.error === SNAPSHOT_ENDPOINT_UNSUPPORTED
          ? "unsupported"
          : "other",
    );

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
      await this.settleClaimedExecution(job, "completed", {
        result: jobRecord<AgentSnapshotJobResult>({
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
      const retrySnapshot = await this.updateClaimedExecution(job, {
        result: jobRecord<AgentSnapshotJobResult>({
          cloudAgentId: data.agentId,
          error: result.error,
        }),
      });
      if (result.retryable) {
        throw new RetryableProvisionTransportError(
          result.error ?? "Snapshot capture temporarily unavailable",
          retrySnapshot,
          PROVISION_TRANSPORT_MAX_FREE_RETRIES,
        );
      }
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

    await this.settleClaimedExecution(job, "completed", {
      result: jobRecord<AgentSnapshotJobResult>(jobResult),
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

    await this.assertExecutionMutationLease(job);
    // A concurrent acknowledged DELETE may have upgraded the durable job data
    // after this worker claimed its in-memory snapshot (`upgradeReuse`). The
    // claimed object cannot observe that write, so re-read the row from the
    // primary under the execution lease immediately before the destructive
    // boundary. Authority is monotonic: the durable read may strengthen the
    // claimed snapshot, never weaken it.
    const durableJob = await jobsRepository.findByIdForWrite(job.id);
    const durableData = durableJob ? readAgentDeleteJobData(durableJob) : undefined;
    const authorityData = hasCompleteAgentDeleteAuthority(durableData)
      ? durableData
      : hasCompleteAgentDeleteAuthority(data)
        ? data
        : data;
    const stateLossAcknowledged = hasCompleteAgentDeleteAuthority(authorityData);
    const delResult = stateLossAcknowledged
      ? await elizaSandboxService.executeDeletion(
          data.agentId,
          data.organizationId,
          data.authorization,
          true,
        )
      : await elizaSandboxService.executeDeletion(
          data.agentId,
          data.organizationId,
          data.authorization,
        );

    if (!delResult.success) {
      // The free requeue is bounded. `retryLaterWithoutIncrementingAttempts`
      // leaves `attempts` alone by design, so a capture failure that stays
      // transient would requeue forever and a user-requested delete would
      // become an immortal — still billed — agent. Count the free requeues on
      // the job result and escalate past the cap.
      const priorCaptureRetries = Math.max(
        job.retryable_requeues,
        readAgentDeleteCaptureRetryCount(job.result),
      );
      const captureRetryExhausted =
        delResult.retryable && priorCaptureRetries >= PRE_DELETE_CAPTURE_MAX_FREE_RETRIES;
      const captureRetryCount = delResult.retryable ? priorCaptureRetries + 1 : priorCaptureRetries;
      // Persist a partial result and rethrow so the jobs runner counts an
      // attempt and retries (or marks failed on exhaustion).
      const retrySnapshot = await this.updateClaimedExecution(job, {
        result: jobRecord<AgentDeleteJobResult>({
          cloudAgentId: data.agentId,
          containerStopped: delResult.containerStopped,
          rowDeleted: false,
          ...agentDeleteAuthorityResult(authorityData),
          error: delResult.error,
          ...(captureRetryCount > 0 ? { captureRetryCount } : {}),
        }),
      });
      if (delResult.retryable && !captureRetryExhausted) {
        // A transient pre-deletion capture failure retries for free (same
        // rule the restart/snapshot handlers apply to shutdown's identical
        // signal) so the PGlite-closing race cannot exhaust the attempt
        // budget and strand the deletion (#18517).
        throw new RetryableProvisionTransportError(
          delResult.error ?? "Pre-deletion capture temporarily unavailable",
          retrySnapshot,
          PRE_DELETE_CAPTURE_MAX_FREE_RETRIES,
        );
      }
      if (captureRetryExhausted) {
        logger.error(
          "[provisioning-jobs] agent_delete pre-deletion capture exhausted its free-retry budget",
          {
            jobId: job.id,
            agentId: data.agentId,
            captureRetryCount: priorCaptureRetries,
            maxFreeRetries: PRE_DELETE_CAPTURE_MAX_FREE_RETRIES,
            error: delResult.error,
          },
        );
        const message = `Pre-deletion capture stayed unavailable across ${priorCaptureRetries} attempt-preserving retries: ${
          delResult.error ?? "unknown capture failure"
        }`;
        if (!stateLossAcknowledged) {
          throw new UnacknowledgedAgentDeleteError(message, retrySnapshot);
        }
        throw new PreDeleteCaptureExhaustedError(message);
      }
      const message = delResult.error ?? "Unknown agent_delete failure";
      if (!stateLossAcknowledged) {
        throw new UnacknowledgedAgentDeleteError(message, retrySnapshot);
      }
      throw new Error(message);
    }

    const jobResult = await this.settleCompletedAgentDelete(job, data, delResult);

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

    await this.assertExecutionMutationLease(job);
    const restoreDirective = await resolveReviewedProvisionRestoreDirectiveForExecution(data);
    const provResult = await elizaSandboxService.provision(
      data.agentId,
      data.organizationId,
      restoreDirective,
    );

    if (await this.completeIfAgentGone(job, provResult, data.agentId)) return;

    if (!provResult.success) {
      const provisionError = preserveProvisionFailureAcrossCleanupRetry(
        job.result,
        provResult.error,
      );
      const retrySnapshot = await this.updateClaimedExecution(job, {
        result: jobRecord<AgentProvisionJobResult>({
          cloudAgentId: data.agentId,
          status: provResult.sandboxRecord?.status ?? "error",
          error: provisionError,
        }),
      });
      if (provResult.retryable) {
        const cleanupOnlyRetry = provResult.error.startsWith(REPLACEMENT_CLEANUP_ONLY_PREFIX);
        const failureCause = cleanupOnlyRetry && job.error ? undefined : provResult.failureCause;
        throw new RetryableProvisionTransportError(
          provisionError,
          retrySnapshot,
          PROVISION_TRANSPORT_MAX_FREE_RETRIES,
          failureCause === undefined && !(cleanupOnlyRetry && job.error)
            ? undefined
            : {
                cause: failureCause,
                // The original startup failure is already a complete,
                // redacted durable diagnostic. Re-wrapping that serialized
                // text as a new Error cause copies every prior stack on each
                // cleanup retry and grows jobs.error geometrically. Preserve
                // it byte-for-byte; the refreshed cleanup fact is retained in
                // result.error above.
                durableErrorText: cleanupOnlyRetry ? (job.error ?? undefined) : undefined,
              },
        );
      }
      throw new ElizaError(provisionError, {
        code: "AGENT_PROVISION_FAILED",
        context: { jobId: job.id, agentId: data.agentId },
        cause: provResult.failureCause,
      });
    }

    const jobResult: AgentProvisionJobResult = {
      cloudAgentId: data.agentId,
      status: provResult.sandboxRecord.status,
      bridgeUrl: provResult.bridgeUrl,
      healthUrl: provResult.healthUrl,
    };

    await this.settleClaimedExecution(job, "completed", {
      result: jobRecord<AgentProvisionJobResult>(jobResult),
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
              error: jobErrorText(error),
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
            expectedLifecycleRevision: r.lifecycle_revision,
          });
          reprovisioned += 1;
        } catch (error) {
          failed += 1;
          logger.warn("[provisioning-jobs] disconnected recovery failed", {
            agentId: r.id,
            error: jobErrorText(error),
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
            error: jobErrorText(error),
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

  async reconcileExpiredAgentCompute() {
    const { reconcileExpiredAgentComputeBatch } = await import(
      "../lib/services/agent-compute-recovery"
    );
    return reconcileExpiredAgentComputeBatch();
  }

  private async recoverStaleJobs(
    jobTypes: readonly ProvisioningJobType[] = Object.values(JOB_TYPES),
  ): Promise<ProvisioningRecoverySummary> {
    const summary = emptyRecoverySummary();

    // Recover stale jobs per type across all organizations. The repository now
    // handles org-agnostic recovery, so we can do this in one pass.
    for (const jobType of jobTypes) {
      const result = await jobsRepository.recoverStaleJobs({
        type: jobType,
        staleThresholdMs: COLD_BOOT_JOB_TYPES.has(jobType)
          ? COLD_BOOT_STALE_JOB_THRESHOLD_MS
          : DEFAULT_STALE_JOB_THRESHOLD_MS,
        buildFailureWriteback: this.dependentRowWritebackBuilder(jobType),
      });
      addRecoveryResult(summary, result);
    }

    assertRecoveryHealthy("stale", summary);
    return summary;
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
      const responseOk = response.ok;
      const responseStatus = response.status;
      try {
        await response.body?.cancel();
      } catch (error) {
        // error-policy:J6 The webhook status is already authoritative; response
        // disposal is best-effort teardown of the pinned outbound connection.
        logger.warn("[provisioning-jobs] Failed to release webhook response body", {
          jobId: job.id,
          error: jobErrorText(error),
        });
      }

      await jobsRepository.update(job.id, {
        webhook_status: responseOk ? "delivered" : `failed_${responseStatus}`,
      });

      if (!responseOk) {
        logger.warn("[provisioning-jobs] Webhook delivery failed", {
          jobId: job.id,
          webhookUrl: safeWebhookUrl.toString(),
          status: responseStatus,
        });
      }
    } catch (err) {
      logger.error("[provisioning-jobs] Webhook delivery error", {
        jobId: job.id,
        error: jobErrorText(err),
      });

      await jobsRepository.update(job.id, {
        webhook_status: "error",
      });
    }
  }
}
export const provisioningJobService = new ProvisioningJobService();

export type {
  EnqueueAgentDeleteResult,
  EnqueueAgentDowngradeResult,
  EnqueueAgentLogsResult,
  EnqueueAgentProvisionResult,
  EnqueueAgentRestartResult,
  EnqueueAgentResumeResult,
  EnqueueAgentSleepResult,
  EnqueueAgentSnapshotResult,
  EnqueueAgentSuspendResult,
  EnqueueAgentWakeResult,
} from "../lib/services/provisioning-job-policy";
export {
  CONTAINER_BACKED_TARGET_REJECTION_REASON,
  CONTAINER_HEALTH_CHECK_BUDGET_MS,
  CONTAINER_LIFECYCLE_ESTIMATED_DURATION_MS,
  listRecoverableAgentComputeStopIntents,
  lockAgentSuspendTargetInTx,
  readAdminCanaryImageJobData,
  rearmRecoverableAgentComputeStopIntentOnce,
} from "../lib/services/provisioning-job-policy";
