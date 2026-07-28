/**
 * Converts one staging-only, read-only canary database snapshot into a strict
 * privacy-safe operator artifact. The raw snapshot never leaves its workflow
 * runner; only allowlisted lifecycle facts and classified failures are emitted.
 */

import { chmodSync, readFileSync, writeFileSync } from "node:fs";

type JsonRecord = Record<string, unknown>;

const SUFFIX_PATTERN = /^r[1-9][0-9]{7,19}a[1-9][0-9]{0,3}$/;
const UUID_PATTERN_SOURCE =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_PATTERN = new RegExp(`\\b${UUID_PATTERN_SOURCE}\\b`, "i");
const EXCLUSIVE_LIFECYCLE_JOB_TYPE_PATTERN =
  "agent_(?:provision|delete|suspend|resume|restart|downgrade|sleep|wake|upgrade|admin_canary_image)";
const LIFECYCLE_JOB_CONFLICT_PATTERN = new RegExp(
  `^Agent ${UUID_PATTERN_SOURCE} has conflicting ${EXCLUSIVE_LIFECYCLE_JOB_TYPE_PATTERN} job ${UUID_PATTERN_SOURCE}$`,
  "i",
);
const FORBIDDEN_OUTPUT_PATTERN =
  /(?:https?:\/\/|(?:\d{1,3}\.){3}\d{1,3}|\b(?:token|secret|password|api[_-]?key)\b|managed-dedicated-canary-|sha256:|\b[0-9a-f]{64}\b)/i;
const TIMEOUT_ERROR_PATTERN = /(?:timed out|timeout)/i;
const PERMANENT_DELETE_PREFIX = "Deletion permanently failed";
const PERMANENT_DELETE_PATTERN =
  /^Deletion permanently failed after ([1-9][0-9]{0,2}) attempts: ([\s\S]+)$/;
const WORKER_RESTART_TERMINAL_PATTERN =
  /^Job interrupted by worker restart ([1-9][0-9]{0,2}) times - max attempts reached$/;
const TIMEOUT_TERMINAL_PATTERN =
  /^Job timed out ([1-9][0-9]{0,2}) times - max attempts reached$/;

const SANDBOX_STATUSES = new Set([
  "pending",
  "provisioning",
  "running",
  "stopped",
  "sleeping",
  "disconnected",
  "error",
  "deletion_pending",
  "deletion_failed",
]);
const JOB_STATUSES = new Set([
  "pending",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
]);
const ROLLBACK_STANDBY_STATES = new Set([
  "pausing",
  "paused_pre_cutover",
  "paused",
  "retiring",
  "rollback_pending",
  "rollback_cleanup_pending",
]);
const RESTORE_VALIDATION_STATES = new Set([
  "planned",
  "candidate_provisioning",
  "restore_committed",
  "never_routed_retired",
]);
const SOURCE_JOB_OUTCOMES = new Set([
  "cutover_in_progress",
  "pre_cutover_retrying",
  "standby_pending",
  "pre_cutover_failed",
]);
const SOURCE_JOB_FAILURE_KINDS = new Set([
  "retry",
  "execution_audit",
  "stale_recovery",
]);
const STANDBY_DECISIONS = new Set(["accept", "reject"]);
const STANDBY_DECISION_OUTCOMES = new Set(["accepted", "rolled_back"]);
const RETAINED_STANDBY_DECISION_JOB_STATUSES = new Set([
  "pending",
  "in_progress",
  "failed",
]);

type RollbackStandbyState =
  | "pausing"
  | "paused_pre_cutover"
  | "paused"
  | "retiring"
  | "rollback_pending"
  | "rollback_cleanup_pending";
type RestoreValidationState =
  | "planned"
  | "candidate_provisioning"
  | "restore_committed"
  | "never_routed_retired";
type LifecycleAuthority = "none" | "delete" | "rollback_standby";
type RoutedRuntime = "not_applicable" | "standby" | "primary";
type SourceJobOutcome =
  | "cutover_in_progress"
  | "pre_cutover_retrying"
  | "standby_pending"
  | "pre_cutover_failed";
type SourceJobFailureKind = "retry" | "execution_audit" | "stale_recovery";
type StandbyDecision = "accept" | "reject";
type StandbyDecisionOutcome = "accepted" | "rolled_back";

type ErrorCode =
  | "none"
  | "unclassified"
  | "sandbox_stop_failed"
  | "agent_not_found"
  | "replacement_cleanup_pending"
  | "provisioning_in_progress"
  | "worker_restart_interrupted"
  | "lifecycle_conflict"
  | "credential_revoke_failed"
  | "row_delete_failed"
  | "database_failed"
  | "timeout";

type RecoveryCode = "none" | "worker_restart_recovered" | "timeout_recovered";

interface RecoveryClassification {
  code: Exclude<RecoveryCode, "none">;
  attempt: number;
  maxAttempts: number;
}

interface TerminalFailureClassification {
  code: Extract<ErrorCode, "timeout" | "worker_restart_interrupted">;
  attempts: number;
}

type ErrorLengthBucket = "1_64" | "65_128" | "129_256" | "257_512" | "513_2000";

interface UnclassifiedErrorProfile {
  lengthBucket: ErrorLengthBucket;
  writerHints: {
    jobRunnerLike: boolean;
    deleteLifecycleLike: boolean;
    persistenceLike: boolean;
    containerRuntimeLike: boolean;
    transportLike: boolean;
  };
}

interface JobErrorClassification {
  code: ErrorCode;
  unclassifiedProfile: UnclassifiedErrorProfile | null;
}

interface PermanentDeleteEnvelope {
  attempts: number;
  cause: string;
}

interface ClassifiedJobSource {
  diagnostic: ManagedDedicatedCanaryDiagnostic["jobs"][number];
  rawError: unknown;
}

const RECOVERY_PARTIAL_RESULT_ERRORS = new Map<string, ErrorCode>([
  ["Failed to delete sandbox", "sandbox_stop_failed"],
  ["Agent replacement cleanup is still pending", "replacement_cleanup_pending"],
  ["Agent provisioning is in progress", "provisioning_in_progress"],
  ["Agent deletion ownership changed", "lifecycle_conflict"],
]);

export interface ManagedDedicatedCanaryDiagnosticV3 {
  schemaVersion: 3;
  targetCount: 1;
  sandbox: {
    status: string;
    errorCode: ErrorCode;
    errorCount: number;
    deletionStartedAt: string | null;
    updatedAt: string;
  };
  jobs: Array<{
    status: string;
    attempts: number;
    maxAttempts: number;
    containerStopped: boolean | null;
    rowDeleted: boolean | null;
    errorCode: ErrorCode;
    recoveryCode: RecoveryCode;
    resultErrorCode: ErrorCode;
    unclassifiedProfile: UnclassifiedErrorProfile | null;
    scheduledFor: string;
    startedAt: string | null;
    completedAt: string | null;
    createdAt: string;
    updatedAt: string;
    durationMs: number | null;
    queueDurationMs: number | null;
  }>;
}

interface PointedJobClocks {
  scheduledFor: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedDedicatedCanaryDiagnostic
  extends Omit<ManagedDedicatedCanaryDiagnosticV3, "schemaVersion"> {
  schemaVersion: 4;
  capturedAt: string;
  sandbox: ManagedDedicatedCanaryDiagnosticV3["sandbox"] & {
    locator: {
      sandboxIdPresent: boolean;
      nodeIdPresent: boolean;
      containerNamePresent: boolean;
    };
  };
  lifecycle: {
    authority: LifecycleAuthority;
    deletionOwned: boolean;
    replacementCleanupPending: boolean;
    standbyState: RollbackStandbyState | null;
    routedRuntime: RoutedRuntime;
    sourceJob:
      | ({
          status: string;
          outcome: SourceJobOutcome;
          failureKind: SourceJobFailureKind | null;
          attempts: number;
          maxAttempts: number;
          errorCode: ErrorCode;
          recoveryCode: RecoveryCode;
          unclassifiedProfile: UnclassifiedErrorProfile | null;
        } & PointedJobClocks)
      | null;
    decisionJob:
      | ({
          status: string;
          decision: StandbyDecision;
          outcome: StandbyDecisionOutcome | null;
        } & PointedJobClocks)
      | null;
    restoreValidation: {
      state: RestoreValidationState;
      routeMode: "restore_validation_private_control";
      authorityPointed: boolean;
      sourceIdentityMatches: boolean;
      backupVerifiedV2: boolean;
      receiptState: "committed" | null;
      receiptSchemaVersion: 2 | null;
      receiptTransfer: "chunked-v1" | null;
      receiptCommittedAt: string | null;
      routeExposedAt: null;
      candidateContainerAbsentAt: string | null;
      candidateVpnAbsentAt: string | null;
      candidateVolumeAbsentAt: string | null;
      candidateRetiredAt: string | null;
    } | null;
  };
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} has an unexpected shape`);
  }
}

function integer(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value as number;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function nullableBoolean(value: unknown, label: string): boolean | null {
  if (value === null) return null;
  return boolean(value, label);
}

function closedString<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): T {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as T;
}

function nullableClosedString<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): T | null {
  if (value === null) return null;
  return closedString<T>(value, allowed, label);
}

function nullableInteger(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null {
  if (value === null) return null;
  return integer(value, label, minimum, maximum);
}

function looksLikeRecoveryProvenance(value: string): boolean {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return (
    (normalized.includes("recover") || normalized.includes("retry")) &&
    (TIMEOUT_ERROR_PATTERN.test(value) ||
      normalized.includes("timeout") ||
      normalized.includes("timedout") ||
      normalized.includes("workerrestart"))
  );
}

function isReservedRecoveryNamespace(value: string): boolean {
  const normalizedPrefix = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return (
    normalizedPrefix.startsWith("jobtimedout") ||
    normalizedPrefix.startsWith("jobinterruptedbyworkerrestart")
  );
}

function isReservedPermanentDeleteNamespace(value: string): boolean {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .startsWith("deletionpermanentlyfailed");
}

function classifyTerminalFailure(
  value: string,
): TerminalFailureClassification | null {
  const timeout = TIMEOUT_TERMINAL_PATTERN.exec(value);
  if (timeout) return { code: "timeout", attempts: Number(timeout[1]) };
  const workerRestart = WORKER_RESTART_TERMINAL_PATTERN.exec(value);
  if (workerRestart) {
    return {
      code: "worker_restart_interrupted",
      attempts: Number(workerRestart[1]),
    };
  }
  return null;
}

function buildUnclassifiedErrorProfile(
  value: string,
): UnclassifiedErrorProfile {
  const lengthBucket: ErrorLengthBucket =
    value.length <= 64
      ? "1_64"
      : value.length <= 128
        ? "65_128"
        : value.length <= 256
          ? "129_256"
          : value.length <= 512
            ? "257_512"
            : "513_2000";
  const writerHints = {
    jobRunnerLike: false,
    deleteLifecycleLike: false,
    persistenceLike: false,
    containerRuntimeLike: false,
    transportLike: false,
  };
  // Exact prefixes and first-match precedence keep this diagnostic useful
  // without turning arbitrary operator text into a fingerprinting channel.
  if (
    /^job agent_delete\b/.test(value) ||
    /^Invalid agent delete job data for job /.test(value) ||
    /^Organization ID mismatch: job\.data\.organizationId /.test(value) ||
    /^Job not found: /.test(value)
  ) {
    writerHints.jobRunnerLike = true;
  } else if (
    /^(?:Agent deletion intent was not persisted|Deletion |Failed to delete\b|Unknown agent_delete failure$)/.test(
      value,
    )
  ) {
    writerHints.deleteLifecycleLike = true;
  } else if (
    /^(?:Failed query:|Database |PGlite |Postgres |PostgresError:|PostgreSQL |SQL |Transaction |Deadlock )/.test(
      value,
    )
  ) {
    writerHints.persistenceLike = true;
  } else if (
    /^(?:Docker |SSH |Headscale |Sandbox provider |Container runtime )/.test(
      value,
    )
  ) {
    writerHints.containerRuntimeLike = true;
  } else if (
    /^(?:fetch |Fetch |connect |Connect |connection |Connection |getaddrinfo |socket |Socket |ECONNRESET\b|ECONNREFUSED\b|ENETDOWN\b|ENETUNREACH\b|EHOSTUNREACH\b|ETIMEDOUT\b)/.test(
      value,
    )
  ) {
    writerHints.transportLike = true;
  }
  return {
    lengthBucket,
    writerHints,
  };
}

function timestamp(
  value: unknown,
  label: string,
  nullable = false,
): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(
      `${label} must be an ISO timestamp${nullable ? " or null" : ""}`,
    );
  }
  return new Date(value).toISOString();
}

function classifyError(
  value: unknown,
  label: string,
  allowUnclassified = false,
): ErrorCode {
  if (value === null) return "none";
  if (typeof value !== "string" || value.length === 0 || value.length > 2_000) {
    throw new Error(`${label} must be a bounded string or null`);
  }
  if (isReservedPermanentDeleteNamespace(value)) {
    throw new Error(
      `${label} permanent-delete envelope requires source correlation`,
    );
  }
  const terminalFailure = classifyTerminalFailure(value);
  if (terminalFailure) return terminalFailure.code;
  if (
    isReservedRecoveryNamespace(value) ||
    looksLikeRecoveryProvenance(value)
  ) {
    throw new Error(`${label} has malformed recovery provenance`);
  }
  if (value === "Failed to delete sandbox") return "sandbox_stop_failed";
  if (value === "Agent not found") return "agent_not_found";
  if (value === "Agent replacement cleanup is still pending") {
    return "replacement_cleanup_pending";
  }
  if (value === "Agent provisioning is in progress") {
    return "provisioning_in_progress";
  }
  if (LIFECYCLE_JOB_CONFLICT_PATTERN.test(value)) {
    return "lifecycle_conflict";
  }
  if (value.startsWith("Agent ") && value.includes(" has conflicting ")) {
    throw new Error(`${label} is not covered by the privacy-safe classifier`);
  }
  if (/failed query:[\s\S]*delete from\s+"?agent_sandboxes"?/i.test(value)) {
    return "row_delete_failed";
  }
  if (
    /failed query:[\s\S]*(?:delete from|update)\s+"?api_keys"?/i.test(value)
  ) {
    return "credential_revoke_failed";
  }
  if (
    /(?:lifecycle|identity changed|ownership changed|non-quiescent|organization id mismatch)/i.test(
      value,
    )
  ) {
    return "lifecycle_conflict";
  }
  if (/(?:revoke|credential)/i.test(value)) return "credential_revoke_failed";
  if (
    /(?:failed query|database|postgres|sql|transaction|deadlock|connection)/i.test(
      value,
    )
  ) {
    return "database_failed";
  }
  if (TIMEOUT_ERROR_PATTERN.test(value)) return "timeout";
  if (allowUnclassified) return "unclassified";
  throw new Error(`${label} is not covered by the privacy-safe classifier`);
}

function parsePermanentDeleteEnvelope(
  value: string,
  label: string,
): PermanentDeleteEnvelope | null {
  if (!value.startsWith(PERMANENT_DELETE_PREFIX)) {
    if (isReservedPermanentDeleteNamespace(value)) {
      throw new Error(`${label} has a malformed permanent-delete envelope`);
    }
    return null;
  }
  const match = PERMANENT_DELETE_PATTERN.exec(value);
  if (!match) {
    throw new Error(`${label} has a malformed permanent-delete envelope`);
  }
  const attempts = integer(Number(match[1]), `${label} attempts`, 1, 100);
  const cause = match[2];
  if (cause.startsWith(PERMANENT_DELETE_PREFIX)) {
    throw new Error(`${label} has a nested permanent-delete envelope`);
  }
  return { attempts, cause };
}

function classifySandboxError(
  value: unknown,
  status: string,
  deletionOwned: boolean,
  errorCount: number,
  jobs: ClassifiedJobSource[],
): ErrorCode {
  const label = "agent.errorMessage";
  if (value === null) return "none";
  if (typeof value !== "string" || value.length === 0 || value.length > 2_000) {
    throw new Error(`${label} must be a bounded string or null`);
  }

  const envelope = parsePermanentDeleteEnvelope(value, label);
  if (!envelope) {
    const code = classifyError(value, label);
    if (status === "deletion_failed") {
      throw new Error(
        `${label} must use the canonical permanent-delete envelope`,
      );
    }
    return code;
  }
  if (
    (status !== "deletion_failed" && status !== "deletion_pending") ||
    !deletionOwned ||
    errorCount < 1
  ) {
    throw new Error(`${label} has inconsistent deletion lifecycle state`);
  }

  // Recovery preserves the last permanent failure while adding newer jobs, so
  // raw equality and counters identify its writer without exposing another
  // arbitrary-text profile or assuming the retained writer is still newest.
  // A recovery-authored terminal failure is a legitimate envelope cause too:
  // the recovery sweep now runs the same dependent-row writeback the live
  // execution path runs. It needs no extra counter fence — job-level
  // validation already pins a terminal message's own attempt count to the
  // job's attempts and maxAttempts, which the equalities below pin to the
  // envelope's.
  const sourceIndex = jobs.findIndex(
    ({ diagnostic, rawError }) =>
      typeof rawError === "string" &&
      rawError === envelope.cause &&
      diagnostic.status === "failed" &&
      diagnostic.attempts === envelope.attempts &&
      diagnostic.maxAttempts === envelope.attempts,
  );
  if (sourceIndex === -1) {
    throw new Error(
      `${label} does not correlate with bounded failed-job history`,
    );
  }
  if (status === "deletion_failed") {
    if (sourceIndex !== 0) {
      throw new Error(
        `${label} does not correlate with the latest failed deletion job`,
      );
    }
  } else {
    if (sourceIndex === 0) {
      throw new Error(
        `${label} retained failure has no newer recovery lifecycle`,
      );
    }
    let activeRecoveryCount = 0;
    for (const [index, job] of jobs.slice(0, sourceIndex).entries()) {
      if (
        job.diagnostic.status === "pending" ||
        job.diagnostic.status === "in_progress"
      ) {
        activeRecoveryCount += 1;
        if (
          index !== 0 ||
          activeRecoveryCount > 1 ||
          job.diagnostic.attempts >= job.diagnostic.maxAttempts ||
          job.diagnostic.completedAt !== null ||
          (job.diagnostic.status === "in_progress" &&
            job.diagnostic.startedAt === null)
        ) {
          throw new Error(
            `${label} retained failure has invalid active recovery ordering`,
          );
        }
        continue;
      }
      if (
        job.diagnostic.status !== "failed" ||
        typeof job.rawError !== "string" ||
        classifyTerminalFailure(job.rawError) === null
      ) {
        throw new Error(
          `${label} retained failure crosses an unrelated newer job`,
        );
      }
    }
  }
  return jobs[sourceIndex].diagnostic.errorCode;
}

function classifyJobError(
  value: unknown,
  label: string,
): JobErrorClassification {
  if (value === null) return { code: "none", unclassifiedProfile: null };
  if (typeof value !== "string" || value.length === 0 || value.length > 2_000) {
    throw new Error(`${label} must be a bounded string or null`);
  }
  const code = classifyError(value, label, true);
  return {
    code,
    unclassifiedProfile:
      code === "unclassified" ? buildUnclassifiedErrorProfile(value) : null,
  };
}

function classifyRecovery(
  value: unknown,
  label: string,
): RecoveryClassification | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 2_000) {
    throw new Error(`${label} must be a bounded string or null`);
  }
  const patterns: Array<{
    code: Exclude<RecoveryCode, "none">;
    pattern: RegExp;
  }> = [
    {
      code: "worker_restart_recovered",
      pattern:
        /^Job interrupted by worker restart - recovered for retry \(attempt ([1-9][0-9]{0,2})\/([1-9][0-9]{0,2})\)$/,
    },
    {
      code: "timeout_recovered",
      pattern:
        /^Job timed out - recovered for retry \(attempt ([1-9][0-9]{0,2})\/([1-9][0-9]{0,2})\)$/,
    },
  ];
  for (const { code, pattern } of patterns) {
    const match = pattern.exec(value);
    if (!match || match[0] !== value) continue;
    return {
      code,
      attempt: Number(match[1]),
      maxAttempts: Number(match[2]),
    };
  }
  if (classifyTerminalFailure(value)) return null;
  if (
    isReservedRecoveryNamespace(value) ||
    looksLikeRecoveryProvenance(value)
  ) {
    throw new Error(`${label} has malformed recovery provenance`);
  }
  return null;
}

function elapsedMs(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const elapsed = Date.parse(end) - Date.parse(start);
  if (!Number.isSafeInteger(elapsed) || elapsed < 0) {
    throw new Error("diagnostic timestamps are out of order");
  }
  return elapsed;
}

function requireCaptured(
  capturedAt: string,
  value: string | null,
  label: string,
): void {
  if (value !== null && elapsedMs(value, capturedAt) === null) {
    throw new Error(`${label} is not covered by the capture clock`);
  }
}

function pointedJobClocks(job: JsonRecord, label: string): PointedJobClocks {
  const scheduledFor = timestamp(
    job.scheduledFor,
    `${label}.scheduledFor`,
  ) as string;
  const startedAt = timestamp(job.startedAt, `${label}.startedAt`, true);
  const completedAt = timestamp(job.completedAt, `${label}.completedAt`, true);
  const createdAt = timestamp(job.createdAt, `${label}.createdAt`) as string;
  const updatedAt = timestamp(job.updatedAt, `${label}.updatedAt`) as string;
  elapsedMs(createdAt, updatedAt);
  elapsedMs(createdAt, startedAt);
  elapsedMs(startedAt, completedAt);
  elapsedMs(startedAt, updatedAt);
  elapsedMs(completedAt, updatedAt);
  return {
    scheduledFor,
    startedAt,
    completedAt,
    createdAt,
    updatedAt,
  };
}

function parseSourceJob(
  value: unknown,
  standbyState: RollbackStandbyState,
): ManagedDedicatedCanaryDiagnostic["lifecycle"]["sourceJob"] {
  const job = record(value, "agent.rollbackStandby.sourceJob");
  exactKeys(
    job,
    [
      "type",
      "status",
      "outcome",
      "failureKind",
      "error",
      "attempts",
      "maxAttempts",
      "scheduledFor",
      "startedAt",
      "completedAt",
      "createdAt",
      "updatedAt",
    ],
    "agent.rollbackStandby.sourceJob",
  );
  if (job.type !== "agent_admin_canary_image") {
    throw new Error("rollback standby source job type is invalid");
  }
  const status = closedString<string>(
    job.status,
    JOB_STATUSES,
    "agent.rollbackStandby.sourceJob.status",
  );
  const outcome = closedString<SourceJobOutcome>(
    job.outcome,
    SOURCE_JOB_OUTCOMES,
    "agent.rollbackStandby.sourceJob.outcome",
  );
  const failureKind = nullableClosedString<SourceJobFailureKind>(
    job.failureKind,
    SOURCE_JOB_FAILURE_KINDS,
    "agent.rollbackStandby.sourceJob.failureKind",
  );
  const attempts = integer(
    job.attempts,
    "agent.rollbackStandby.sourceJob.attempts",
    0,
    100,
  );
  const maxAttempts = integer(
    job.maxAttempts,
    "agent.rollbackStandby.sourceJob.maxAttempts",
    1,
    100,
  );
  if (attempts > maxAttempts) {
    throw new Error("rollback standby source job attempts exceed maxAttempts");
  }
  const recovery = classifyRecovery(
    job.error,
    "agent.rollbackStandby.sourceJob.error",
  );
  const error = recovery
    ? { code: "none" as const, unclassifiedProfile: null }
    : classifyJobError(job.error, "agent.rollbackStandby.sourceJob.error");
  const clocks = pointedJobClocks(job, "agent.rollbackStandby.sourceJob");
  if (
    outcome === "cutover_in_progress" &&
    (status !== "in_progress" ||
      clocks.startedAt === null ||
      clocks.completedAt !== null ||
      failureKind !== null ||
      error.code !== "none" ||
      recovery !== null)
  ) {
    throw new Error("rollback standby source job is not in progress");
  }
  if (
    outcome === "standby_pending" &&
    (status !== "completed" ||
      clocks.startedAt === null ||
      clocks.completedAt === null ||
      failureKind !== null ||
      error.code !== "none" ||
      recovery !== null)
  ) {
    throw new Error("rollback standby source job has no completed cutover");
  }
  const beforeCutover =
    standbyState === "pausing" || standbyState === "paused_pre_cutover";
  if (
    (outcome === "pre_cutover_failed") !==
      (beforeCutover && status === "failed") ||
    (beforeCutover &&
      outcome !== "cutover_in_progress" &&
      outcome !== "pre_cutover_retrying" &&
      outcome !== "pre_cutover_failed") ||
    (!beforeCutover && outcome !== "standby_pending")
  ) {
    throw new Error("rollback standby state and source job outcome disagree");
  }
  if (
    outcome === "pre_cutover_retrying" &&
    ((status !== "pending" && status !== "in_progress") ||
      failureKind !== "retry" ||
      (error.code === "none" && recovery === null) ||
      attempts < 1 ||
      attempts >= maxAttempts ||
      clocks.startedAt === null ||
      clocks.completedAt !== null)
  ) {
    throw new Error("rollback standby source retry is incomplete");
  }
  if (
    outcome === "pre_cutover_retrying" &&
    recovery !== null &&
    (recovery.attempt !== attempts || recovery.maxAttempts !== maxAttempts)
  ) {
    throw new Error("rollback standby source retry counters disagree");
  }
  if (outcome === "pre_cutover_failed") {
    if (
      failureKind === null ||
      (failureKind !== "execution_audit" && failureKind !== "stale_recovery") ||
      error.code === "none" ||
      clocks.startedAt === null ||
      attempts !== maxAttempts
    ) {
      throw new Error("rollback standby source failure is incomplete");
    }
    const terminalFailure =
      typeof job.error === "string" ? classifyTerminalFailure(job.error) : null;
    if (
      (failureKind === "execution_audit" && clocks.completedAt === null) ||
      (failureKind === "stale_recovery" &&
        (clocks.completedAt !== null ||
          terminalFailure === null ||
          terminalFailure.attempts !== attempts))
    ) {
      throw new Error("rollback standby source failure shape is invalid");
    }
  }
  return {
    status,
    outcome,
    failureKind,
    attempts,
    maxAttempts,
    errorCode: error.code,
    recoveryCode: recovery?.code ?? "none",
    unclassifiedProfile: error.unclassifiedProfile,
    ...clocks,
  };
}

function parseDecisionJob(
  value: unknown,
  standbyState: RollbackStandbyState,
): ManagedDedicatedCanaryDiagnostic["lifecycle"]["decisionJob"] {
  if (value === null) {
    if (
      standbyState === "retiring" ||
      standbyState === "rollback_pending" ||
      standbyState === "rollback_cleanup_pending"
    ) {
      throw new Error("rollback standby decision job is missing");
    }
    return null;
  }
  if (
    standbyState === "pausing" ||
    standbyState === "paused_pre_cutover" ||
    standbyState === "paused"
  ) {
    throw new Error("rollback standby has a premature decision job");
  }
  const job = record(value, "agent.rollbackStandby.decisionJob");
  exactKeys(
    job,
    [
      "type",
      "status",
      "decision",
      "outcome",
      "scheduledFor",
      "startedAt",
      "completedAt",
      "createdAt",
      "updatedAt",
    ],
    "agent.rollbackStandby.decisionJob",
  );
  if (job.type !== "agent_admin_canary_standby_decision") {
    throw new Error("rollback standby decision job type is invalid");
  }
  const status = closedString<string>(
    job.status,
    RETAINED_STANDBY_DECISION_JOB_STATUSES,
    "agent.rollbackStandby.decisionJob.status",
  );
  const decision = closedString<StandbyDecision>(
    job.decision,
    STANDBY_DECISIONS,
    "agent.rollbackStandby.decisionJob.decision",
  );
  const outcome = nullableClosedString<StandbyDecisionOutcome>(
    job.outcome,
    STANDBY_DECISION_OUTCOMES,
    "agent.rollbackStandby.decisionJob.outcome",
  );
  const clocks = pointedJobClocks(job, "agent.rollbackStandby.decisionJob");
  if (
    outcome !== null ||
    clocks.startedAt === null ||
    clocks.completedAt !== null
  ) {
    throw new Error("rollback standby decision outcome and clocks disagree");
  }
  if (
    (decision === "reject" && outcome === "accepted") ||
    (standbyState === "retiring" && decision !== "accept")
  ) {
    throw new Error("rollback standby decision and outcome disagree");
  }
  return { status, decision, outcome, ...clocks };
}

function parseRestoreValidation(
  value: unknown,
  countValue: unknown,
  standbyState: RollbackStandbyState,
): ManagedDedicatedCanaryDiagnostic["lifecycle"]["restoreValidation"] {
  const count = integer(
    countValue,
    "agent.rollbackStandby.restoreValidationCount",
    0,
    2,
  );
  const beforeCutover =
    standbyState === "pausing" || standbyState === "paused_pre_cutover";
  if (beforeCutover) {
    if (count !== 0 || value !== null) {
      throw new Error(
        "pre-cutover rollback standby cannot have restore validation authority",
      );
    }
    return null;
  }
  if (value === null) {
    if (count !== 0) {
      throw new Error("restore validation cardinality disagrees with payload");
    }
    throw new Error("rollback standby restore validation is missing");
  }
  if (count !== 1) {
    throw new Error("restore validation must resolve exactly one row");
  }
  const validation = record(value, "agent.rollbackStandby.restoreValidation");
  exactKeys(
    validation,
    [
      "state",
      "routeMode",
      "authorityPointed",
      "sourceIdentityMatches",
      "backupVerifiedV2",
      "contractComplete",
      "receiptState",
      "receiptSchemaVersion",
      "receiptTransfer",
      "receiptCommittedAt",
      "routeExposedAt",
      "candidateContainerAbsentAt",
      "candidateVpnAbsentAt",
      "candidateVolumeAbsentAt",
      "candidateRetiredAt",
    ],
    "agent.rollbackStandby.restoreValidation",
  );
  const state = closedString<RestoreValidationState>(
    validation.state,
    RESTORE_VALIDATION_STATES,
    "agent.rollbackStandby.restoreValidation.state",
  );
  if (validation.routeMode !== "restore_validation_private_control") {
    throw new Error("restore validation route mode is invalid");
  }
  const authorityPointed = boolean(
    validation.authorityPointed,
    "agent.rollbackStandby.restoreValidation.authorityPointed",
  );
  const sourceIdentityMatches = boolean(
    validation.sourceIdentityMatches,
    "agent.rollbackStandby.restoreValidation.sourceIdentityMatches",
  );
  const backupVerifiedV2 = boolean(
    validation.backupVerifiedV2,
    "agent.rollbackStandby.restoreValidation.backupVerifiedV2",
  );
  if (
    !boolean(
      validation.contractComplete,
      "agent.rollbackStandby.restoreValidation.contractComplete",
    )
  ) {
    throw new Error("restore validation row violates the frozen contract");
  }
  const receiptState = nullableClosedString<"committed">(
    validation.receiptState,
    new Set(["committed"]),
    "agent.rollbackStandby.restoreValidation.receiptState",
  );
  const receiptSchemaVersion = nullableInteger(
    validation.receiptSchemaVersion,
    "agent.rollbackStandby.restoreValidation.receiptSchemaVersion",
    2,
    2,
  ) as 2 | null;
  const receiptTransfer = nullableClosedString<"chunked-v1">(
    validation.receiptTransfer,
    new Set(["chunked-v1"]),
    "agent.rollbackStandby.restoreValidation.receiptTransfer",
  );
  const receiptCommittedAt = timestamp(
    validation.receiptCommittedAt,
    "agent.rollbackStandby.restoreValidation.receiptCommittedAt",
    true,
  );
  const routeExposedAt = timestamp(
    validation.routeExposedAt,
    "agent.rollbackStandby.restoreValidation.routeExposedAt",
    true,
  );
  const candidateContainerAbsentAt = timestamp(
    validation.candidateContainerAbsentAt,
    "agent.rollbackStandby.restoreValidation.candidateContainerAbsentAt",
    true,
  );
  const candidateVpnAbsentAt = timestamp(
    validation.candidateVpnAbsentAt,
    "agent.rollbackStandby.restoreValidation.candidateVpnAbsentAt",
    true,
  );
  const candidateVolumeAbsentAt = timestamp(
    validation.candidateVolumeAbsentAt,
    "agent.rollbackStandby.restoreValidation.candidateVolumeAbsentAt",
    true,
  );
  const candidateRetiredAt = timestamp(
    validation.candidateRetiredAt,
    "agent.rollbackStandby.restoreValidation.candidateRetiredAt",
    true,
  );

  if (!sourceIdentityMatches || routeExposedAt !== null) {
    throw new Error(
      "restore validation is not bound to private source authority",
    );
  }
  const committed =
    state === "restore_committed" || state === "never_routed_retired";
  if (
    committed !== (receiptState === "committed") ||
    committed !== (receiptSchemaVersion === 2) ||
    committed !== (receiptTransfer === "chunked-v1") ||
    committed !== (receiptCommittedAt !== null) ||
    committed !== backupVerifiedV2
  ) {
    throw new Error("restore validation receipt is incomplete");
  }
  const retired = state === "never_routed_retired";
  if (
    retired !== (candidateContainerAbsentAt !== null) ||
    retired !== (candidateVpnAbsentAt !== null) ||
    retired !== (candidateVolumeAbsentAt !== null) ||
    retired !== (candidateRetiredAt !== null)
  ) {
    throw new Error("restore validation retirement proof is incomplete");
  }
  if (
    retired &&
    (elapsedMs(receiptCommittedAt, candidateContainerAbsentAt) === null ||
      elapsedMs(receiptCommittedAt, candidateVpnAbsentAt) === null ||
      elapsedMs(receiptCommittedAt, candidateVolumeAbsentAt) === null ||
      elapsedMs(candidateContainerAbsentAt, candidateRetiredAt) === null ||
      elapsedMs(candidateVpnAbsentAt, candidateRetiredAt) === null ||
      elapsedMs(candidateVolumeAbsentAt, candidateRetiredAt) === null)
  ) {
    throw new Error("restore validation retirement clocks are incomplete");
  }
  const acceptanceState = standbyState === "retiring";
  if (
    acceptanceState !== authorityPointed ||
    (acceptanceState && (!retired || !backupVerifiedV2))
  ) {
    throw new Error("restore validation acceptance authority disagrees");
  }
  return {
    state,
    routeMode: "restore_validation_private_control",
    authorityPointed,
    sourceIdentityMatches,
    backupVerifiedV2,
    receiptState,
    receiptSchemaVersion,
    receiptTransfer,
    receiptCommittedAt,
    routeExposedAt: null,
    candidateContainerAbsentAt,
    candidateVpnAbsentAt,
    candidateVolumeAbsentAt,
    candidateRetiredAt,
  };
}

export function sanitizeManagedDedicatedCanaryDiagnostic(
  raw: unknown,
  suffix: string,
): ManagedDedicatedCanaryDiagnostic {
  if (!SUFFIX_PATTERN.test(suffix))
    throw new Error("diagnostic suffix is invalid");

  const root = record(raw, "diagnostic input");
  exactKeys(
    root,
    ["capturedAt", "targetCount", "agent", "jobs"],
    "diagnostic input",
  );
  const capturedAt = timestamp(root.capturedAt, "capturedAt") as string;
  if (integer(root.targetCount, "targetCount", 0, 2) !== 1) {
    throw new Error("diagnostic input must resolve exactly one target");
  }

  const agent = record(root.agent, "agent");
  exactKeys(
    agent,
    [
      "status",
      "errorMessage",
      "errorCount",
      "deletionOwned",
      "deletionStartedAt",
      "updatedAt",
      "locator",
      "replacementCleanupLocator",
      "rollbackStandby",
    ],
    "agent",
  );
  if (typeof agent.status !== "string" || !SANDBOX_STATUSES.has(agent.status)) {
    throw new Error("agent.status is invalid");
  }
  const locator = record(agent.locator, "agent.locator");
  exactKeys(
    locator,
    ["sandboxIdPresent", "nodeIdPresent", "containerNamePresent"],
    "agent.locator",
  );
  const sandboxIdPresent = boolean(
    locator.sandboxIdPresent,
    "locator.sandboxIdPresent",
  );
  const nodeIdPresent = boolean(locator.nodeIdPresent, "locator.nodeIdPresent");
  const containerNamePresent = boolean(
    locator.containerNamePresent,
    "locator.containerNamePresent",
  );
  const replacementCleanupLocator = record(
    agent.replacementCleanupLocator,
    "agent.replacementCleanupLocator",
  );
  exactKeys(
    replacementCleanupLocator,
    [
      "sandboxIdPresent",
      "nodeIdPresent",
      "containerNamePresent",
      "createdAtPresent",
      "contractComplete",
    ],
    "agent.replacementCleanupLocator",
  );
  if (
    !boolean(
      replacementCleanupLocator.contractComplete,
      "agent.replacementCleanupLocator.contractComplete",
    )
  ) {
    throw new Error(
      "agent replacement cleanup row violates its locator contract",
    );
  }
  const replacementCleanupPresence = [
    boolean(
      replacementCleanupLocator.sandboxIdPresent,
      "agent.replacementCleanupLocator.sandboxIdPresent",
    ),
    boolean(
      replacementCleanupLocator.nodeIdPresent,
      "agent.replacementCleanupLocator.nodeIdPresent",
    ),
    boolean(
      replacementCleanupLocator.containerNamePresent,
      "agent.replacementCleanupLocator.containerNamePresent",
    ),
    boolean(
      replacementCleanupLocator.createdAtPresent,
      "agent.replacementCleanupLocator.createdAtPresent",
    ),
  ];
  const replacementCleanupPending = replacementCleanupPresence.some(Boolean);
  if (
    replacementCleanupPresence.some(
      (present) => present !== replacementCleanupPending,
    )
  ) {
    throw new Error("agent replacement cleanup locator is partially populated");
  }
  const deletionOwned = boolean(agent.deletionOwned, "agent.deletionOwned");
  const deletionStartedAt = timestamp(
    agent.deletionStartedAt,
    "agent.deletionStartedAt",
    true,
  );
  if (deletionOwned !== (deletionStartedAt !== null)) {
    throw new Error("agent deletion ownership and timestamp disagree");
  }
  const sandboxUpdatedAt = timestamp(
    agent.updatedAt,
    "agent.updatedAt",
  ) as string;

  let standbyState: RollbackStandbyState | null = null;
  let routedRuntime: RoutedRuntime = "not_applicable";
  let sourceJob: ManagedDedicatedCanaryDiagnostic["lifecycle"]["sourceJob"] =
    null;
  let decisionJob: ManagedDedicatedCanaryDiagnostic["lifecycle"]["decisionJob"] =
    null;
  let restoreValidation: ManagedDedicatedCanaryDiagnostic["lifecycle"]["restoreValidation"] =
    null;
  if (agent.rollbackStandby !== null) {
    if (deletionOwned) {
      throw new Error("agent has dual delete and rollback-standby authority");
    }
    const standby = record(agent.rollbackStandby, "agent.rollbackStandby");
    exactKeys(
      standby,
      [
        "state",
        "currentMatchesPrimary",
        "currentMatchesStandby",
        "contractComplete",
        "sourceJob",
        "decisionJob",
        "restoreValidationCount",
        "restoreValidation",
      ],
      "agent.rollbackStandby",
    );
    standbyState = closedString<RollbackStandbyState>(
      standby.state,
      ROLLBACK_STANDBY_STATES,
      "agent.rollbackStandby.state",
    );
    if (
      agent.status === "deletion_pending" ||
      agent.status === "deletion_failed"
    ) {
      throw new Error("rollback standby cannot coexist with deletion status");
    }
    if (
      !boolean(
        standby.contractComplete,
        "agent.rollbackStandby.contractComplete",
      )
    ) {
      throw new Error("rollback standby row violates the frozen contract");
    }
    const currentMatchesPrimary = boolean(
      standby.currentMatchesPrimary,
      "agent.rollbackStandby.currentMatchesPrimary",
    );
    const currentMatchesStandby = boolean(
      standby.currentMatchesStandby,
      "agent.rollbackStandby.currentMatchesStandby",
    );
    if (currentMatchesPrimary === currentMatchesStandby) {
      throw new Error("rollback standby routed runtime is ambiguous");
    }
    const standbyRouted =
      standbyState === "pausing" ||
      standbyState === "paused_pre_cutover" ||
      standbyState === "rollback_cleanup_pending";
    if (
      standbyRouted !== currentMatchesStandby ||
      standbyRouted === currentMatchesPrimary
    ) {
      throw new Error("rollback standby state and routed runtime disagree");
    }
    routedRuntime = standbyRouted ? "standby" : "primary";
    sourceJob = parseSourceJob(standby.sourceJob, standbyState);
    decisionJob = parseDecisionJob(standby.decisionJob, standbyState);
    restoreValidation = parseRestoreValidation(
      standby.restoreValidation,
      standby.restoreValidationCount,
      standbyState,
    );
    const beforeCutover =
      standbyState === "pausing" || standbyState === "paused_pre_cutover";
    if (beforeCutover !== replacementCleanupPending) {
      throw new Error(
        "rollback standby state and replacement cleanup locator disagree",
      );
    }
  }
  const deletionStatus =
    agent.status === "deletion_pending" || agent.status === "deletion_failed";
  if (deletionOwned !== deletionStatus) {
    throw new Error("agent deletion ownership and status disagree");
  }
  const authority: LifecycleAuthority = standbyState
    ? "rollback_standby"
    : deletionOwned
      ? "delete"
      : "none";

  if (
    !Array.isArray(root.jobs) ||
    root.jobs.length > 3 ||
    (deletionOwned && root.jobs.length < 1)
  ) {
    throw new Error(
      "jobs must contain at most three newest-first records and deletion authority requires one",
    );
  }

  let previousCreatedAt = Number.POSITIVE_INFINITY;
  const rawJobErrors: unknown[] = [];
  const jobs = root.jobs.map((value, index) => {
    const job = record(value, `jobs[${index}]`);
    exactKeys(
      job,
      [
        "status",
        "error",
        "result",
        "attempts",
        "maxAttempts",
        "resultStorage",
        "errorStorage",
        "scheduledFor",
        "startedAt",
        "completedAt",
        "createdAt",
        "updatedAt",
      ],
      `jobs[${index}]`,
    );
    if (typeof job.status !== "string" || !JOB_STATUSES.has(job.status)) {
      throw new Error(`jobs[${index}].status is invalid`);
    }
    if (job.resultStorage !== "inline" || job.errorStorage !== "inline") {
      throw new Error(`jobs[${index}] has non-inline diagnostic payloads`);
    }

    const terminalFailure =
      typeof job.error === "string" ? classifyTerminalFailure(job.error) : null;
    const recovery = classifyRecovery(job.error, `jobs[${index}].error`);
    const jobError = recovery
      ? { code: "none" as const, unclassifiedProfile: null }
      : classifyJobError(job.error, `jobs[${index}].error`);
    const jobErrorCode = jobError.code;
    let containerStopped: boolean | null = null;
    let rowDeleted: boolean | null = null;
    let resultErrorCode: ErrorCode = "none";
    let resultErrorValue: unknown = null;
    if (job.result !== null) {
      const result = record(job.result, `jobs[${index}].result`);
      exactKeys(
        result,
        ["containerStopped", "rowDeleted", "error"],
        `jobs[${index}].result`,
      );
      containerStopped = nullableBoolean(
        result.containerStopped,
        `jobs[${index}].result.containerStopped`,
      );
      rowDeleted = nullableBoolean(
        result.rowDeleted,
        `jobs[${index}].result.rowDeleted`,
      );
      resultErrorValue = result.error;
      resultErrorCode = classifyError(
        result.error,
        `jobs[${index}].result.error`,
      );
    }
    const scheduledFor = timestamp(
      job.scheduledFor,
      `jobs[${index}].scheduledFor`,
    ) as string;
    const startedAt = timestamp(
      job.startedAt,
      `jobs[${index}].startedAt`,
      true,
    );
    const completedAt = timestamp(
      job.completedAt,
      `jobs[${index}].completedAt`,
      true,
    );
    const createdAt = timestamp(
      job.createdAt,
      `jobs[${index}].createdAt`,
    ) as string;
    const updatedAt = timestamp(
      job.updatedAt,
      `jobs[${index}].updatedAt`,
    ) as string;
    const createdAtMs = Date.parse(createdAt);
    if (createdAtMs > previousCreatedAt) {
      throw new Error("jobs are not strictly newest-first");
    }
    previousCreatedAt = createdAtMs;

    const attempts = integer(job.attempts, `jobs[${index}].attempts`, 0, 100);
    const maxAttempts = integer(
      job.maxAttempts,
      `jobs[${index}].maxAttempts`,
      1,
      100,
    );
    if (attempts > maxAttempts) {
      throw new Error(`jobs[${index}] attempts exceed maxAttempts`);
    }
    if (
      terminalFailure &&
      (job.status !== "failed" ||
        terminalFailure.attempts !== attempts ||
        terminalFailure.attempts !== maxAttempts)
    ) {
      throw new Error(`jobs[${index}] terminal counters disagree`);
    }
    if (
      recovery &&
      (recovery.attempt !== attempts ||
        recovery.maxAttempts !== maxAttempts ||
        attempts >= maxAttempts)
    ) {
      throw new Error(`jobs[${index}] recovery counters disagree`);
    }
    if (recovery && job.status !== "pending" && job.status !== "in_progress") {
      throw new Error(`jobs[${index}] recovery status is invalid`);
    }
    if (
      (recovery || terminalFailure) &&
      (startedAt === null || completedAt !== null)
    ) {
      throw new Error(`jobs[${index}] recovery timestamps disagree`);
    }
    if (
      (recovery || terminalFailure) &&
      job.result !== null &&
      (containerStopped !== false ||
        rowDeleted !== false ||
        typeof resultErrorValue !== "string" ||
        RECOVERY_PARTIAL_RESULT_ERRORS.get(resultErrorValue) !==
          resultErrorCode)
    ) {
      throw new Error(
        `jobs[${index}] recovery result is not a partial failure`,
      );
    }
    if (
      jobErrorCode === "unclassified" &&
      (job.status === "completed" ||
        job.status === "cancelled" ||
        startedAt === null ||
        completedAt !== null ||
        attempts === 0 ||
        (job.status === "failed"
          ? attempts !== maxAttempts
          : attempts >= maxAttempts))
    ) {
      throw new Error(`jobs[${index}] unclassified lifecycle is inconsistent`);
    }
    if (
      jobErrorCode === "unclassified" &&
      job.result !== null &&
      (containerStopped !== false ||
        rowDeleted !== false ||
        typeof resultErrorValue !== "string" ||
        RECOVERY_PARTIAL_RESULT_ERRORS.get(resultErrorValue) !==
          resultErrorCode)
    ) {
      throw new Error(
        `jobs[${index}] unclassified result is not a partial failure`,
      );
    }
    if (rowDeleted === true && containerStopped !== true) {
      throw new Error(
        `jobs[${index}] deleted a row without a stopped container`,
      );
    }
    if (
      job.status === "completed" &&
      (jobErrorCode !== "none" ||
        resultErrorCode !== "none" ||
        containerStopped !== true ||
        rowDeleted !== true)
    ) {
      throw new Error(`jobs[${index}] has an invalid completed result`);
    }
    if (
      job.status === "failed" &&
      (attempts === 0 || jobErrorCode === "none")
    ) {
      throw new Error(`jobs[${index}] has an invalid failed result`);
    }
    const terminalAt =
      completedAt ??
      (job.status === "completed" ||
      job.status === "failed" ||
      job.status === "cancelled"
        ? updatedAt
        : null);
    elapsedMs(createdAt, updatedAt);
    elapsedMs(startedAt, updatedAt);
    elapsedMs(completedAt, updatedAt);

    rawJobErrors.push(job.error);
    return {
      status: job.status,
      attempts,
      maxAttempts,
      containerStopped,
      rowDeleted,
      errorCode: jobErrorCode,
      unclassifiedProfile: jobError.unclassifiedProfile,
      recoveryCode: recovery?.code ?? "none",
      resultErrorCode,
      scheduledFor,
      startedAt,
      completedAt,
      createdAt,
      updatedAt,
      durationMs: elapsedMs(startedAt, terminalAt),
      queueDurationMs: elapsedMs(createdAt, startedAt),
    };
  });
  const classifiedJobs = jobs.map((diagnostic, index) => ({
    diagnostic,
    rawError: rawJobErrors[index],
  }));

  const errorCount = integer(agent.errorCount, "agent.errorCount", 0, 1_000);
  const sandboxErrorCode = classifySandboxError(
    agent.errorMessage,
    agent.status,
    deletionOwned,
    errorCount,
    classifiedJobs,
  );
  if (
    agent.status === "deletion_failed" &&
    (sandboxErrorCode === "none" ||
      jobs[0]?.status !== "failed" ||
      jobs[0].errorCode !== sandboxErrorCode)
  ) {
    throw new Error("sandbox and latest failed deletion job disagree");
  }
  requireCaptured(capturedAt, sandboxUpdatedAt, "agent.updatedAt");
  requireCaptured(capturedAt, deletionStartedAt, "agent.deletionStartedAt");
  for (const [index, job] of jobs.entries()) {
    for (const [field, value] of [
      ["createdAt", job.createdAt],
      ["startedAt", job.startedAt],
      ["completedAt", job.completedAt],
      ["updatedAt", job.updatedAt],
    ] as const) {
      requireCaptured(capturedAt, value, `jobs[${index}].${field}`);
    }
  }
  for (const [label, job] of [
    ["sourceJob", sourceJob],
    ["decisionJob", decisionJob],
  ] as const) {
    if (!job) continue;
    for (const [field, value] of [
      ["createdAt", job.createdAt],
      ["startedAt", job.startedAt],
      ["completedAt", job.completedAt],
      ["updatedAt", job.updatedAt],
    ] as const) {
      requireCaptured(capturedAt, value, `${label}.${field}`);
    }
  }
  if (restoreValidation) {
    for (const [field, value] of [
      ["receiptCommittedAt", restoreValidation.receiptCommittedAt],
      [
        "candidateContainerAbsentAt",
        restoreValidation.candidateContainerAbsentAt,
      ],
      ["candidateVpnAbsentAt", restoreValidation.candidateVpnAbsentAt],
      ["candidateVolumeAbsentAt", restoreValidation.candidateVolumeAbsentAt],
      ["candidateRetiredAt", restoreValidation.candidateRetiredAt],
    ] as const) {
      requireCaptured(capturedAt, value, `restoreValidation.${field}`);
    }
  }

  return {
    schemaVersion: 4,
    capturedAt,
    targetCount: 1,
    sandbox: {
      status: agent.status,
      errorCode: sandboxErrorCode,
      errorCount,
      deletionStartedAt,
      updatedAt: sandboxUpdatedAt,
      locator: {
        sandboxIdPresent,
        nodeIdPresent,
        containerNamePresent,
      },
    },
    jobs,
    lifecycle: {
      authority,
      deletionOwned,
      replacementCleanupPending,
      standbyState,
      routedRuntime,
      sourceJob,
      decisionJob,
      restoreValidation,
    },
  };
}

export function projectManagedDedicatedCanaryDiagnosticV3(
  evidence: ManagedDedicatedCanaryDiagnostic,
): ManagedDedicatedCanaryDiagnosticV3 {
  if (evidence.jobs.length < 1 || evidence.jobs.length > 3) {
    throw new Error(
      "schema-v4 evidence has no one-to-three-job v3-compatible projection",
    );
  }
  return {
    schemaVersion: 3,
    targetCount: evidence.targetCount,
    sandbox: {
      status: evidence.sandbox.status,
      errorCode: evidence.sandbox.errorCode,
      errorCount: evidence.sandbox.errorCount,
      deletionStartedAt: evidence.sandbox.deletionStartedAt,
      updatedAt: evidence.sandbox.updatedAt,
    },
    jobs: evidence.jobs,
  };
}

export function canonicalizeManagedDedicatedCanaryDiagnostic(
  rawText: string,
  suffix: string,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    // error-policy:J3 Raw parser errors can echo private diagnostic input.
    throw new Error("managed canary diagnostic input is not valid JSON");
  }
  const evidence = sanitizeManagedDedicatedCanaryDiagnostic(parsed, suffix);
  const canonical = `${JSON.stringify(evidence, null, 2)}\n`;
  if (
    UUID_PATTERN.test(canonical) ||
    FORBIDDEN_OUTPUT_PATTERN.test(canonical)
  ) {
    throw new Error(
      "privacy-safe diagnostic contains a forbidden identifier or secret shape",
    );
  }
  return canonical;
}

export function writeManagedDedicatedCanaryDiagnostic(
  rawPath: string,
  evidencePath: string,
  suffix: string,
): void {
  const canonical = canonicalizeManagedDedicatedCanaryDiagnostic(
    readFileSync(rawPath, "utf8"),
    suffix,
  );
  writeFileSync(evidencePath, canonical, { mode: 0o600 });
  chmodSync(evidencePath, 0o600);
}

if (import.meta.main) {
  const [suffix, rawPath, evidencePath] = process.argv.slice(2);
  if (!suffix || !rawPath || !evidencePath) {
    throw new Error(
      "canary diagnostic requires suffix, raw path, and evidence path",
    );
  }
  writeManagedDedicatedCanaryDiagnostic(rawPath, evidencePath, suffix);
}
