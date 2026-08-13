/**
 * Converts one staging-only, read-only canary database snapshot into a strict
 * privacy-safe operator artifact. The raw snapshot never leaves its workflow
 * runner; only allowlisted lifecycle facts and classified failures are emitted.
 */

import { chmodSync, readFileSync, writeFileSync } from "node:fs";

type JsonRecord = Record<string, unknown>;

const SUFFIX_PATTERN = /^r[1-9][0-9]{7,19}a[1-9][0-9]{0,3}$/;
const UUID_PATTERN_SOURCE =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_PATTERN = new RegExp(`\\b${UUID_PATTERN_SOURCE}\\b`, "i");
const EXCLUSIVE_LIFECYCLE_JOB_TYPE_PATTERN =
  "agent_(?:provision|delete|suspend|resume|restart|downgrade|sleep|wake|upgrade|admin_canary_image)";
const LIFECYCLE_JOB_CONFLICT_PATTERN = new RegExp(
  `^Agent ${UUID_PATTERN_SOURCE} has conflicting ${EXCLUSIVE_LIFECYCLE_JOB_TYPE_PATTERN} job ${UUID_PATTERN_SOURCE}$`,
  "i",
);
const FORBIDDEN_OUTPUT_PATTERN =
  /(?:https?:\/\/|(?:\d{1,3}\.){3}\d{1,3}|\b(?:token|secret|password|api[_-]?key)\b|managed-dedicated-canary-|sha256:)/i;
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

export interface ManagedDedicatedCanaryDiagnostic {
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

// --- Schema-v4 lifecycle authority types ---

/**
 * Standby lifecycle states introduced by #17172. These are the only states a
 * rollback-standby row may occupy; the preflight proves the column exists before
 * any of them can be emitted.
 */
const STANDBY_STATES = new Set([
  "pausing",
  "paused_pre_cutover",
  "paused",
  "retiring",
  "rollback_pending",
  "rollback_cleanup_pending",
]);

/**
 * Restore-validation states introduced by #17172. These are the only states a
 * never-routed restore proof may occupy.
 */
const RESTORE_VALIDATION_STATES = new Set([
  "planned",
  "candidate_provisioning",
  "restore_committed",
  "never_routed_retired",
]);

/**
 * The private control route that never exposes a restore candidate to traffic.
 */
const RESTORE_VALIDATION_ROUTE = "restore_validation_private_control";

/**
 * The frozen #17172 receipt schema version for committed restore proofs.
 */
const RESTORE_RECEIPT_SCHEMA = 2;

/**
 * The frozen #17172 transfer protocol for chunked v2 backup payloads.
 */
const RESTORE_TRANSFER_PROTOCOL = "chunked-v1";

/**
 * Read-only SQL preflight to prove the 0184 (rollback_standby_state) and 0185
 * (agent_snapshot_restore_validations) migrations have landed before emitting
 * schemaVersion: 4. Runs inside a single BEGIN READ ONLY transaction; never
 * mutates the database.
 *
 * The connection is accepted as a callback so this function owns no database
 * client lifecycle — the caller is responsible for opening and closing it.
 */
export interface SchemaV4PreflightClient {
  /**
   * Execute a query string inside the current transaction. The query is always
   * read-only information_schema introspection; results are returned as rows.
   */
  query(sql: string): Promise<Array<Record<string, unknown>>>;
}

export interface SchemaV4PreflightResult {
  /** True only when every required 0184/0185 column and constraint exists. */
  ready: boolean;
  /**
   * The specific findings — column names present/absent, constraint names
   * present/absent. Contains no secrets: only information_schema identifiers.
   */
  details: {
    columnsPresent: string[];
    columnsAbsent: string[];
    constraintsPresent: string[];
    constraintsAbsent: string[];
  };
}

/**
 * The exact columns and constraints the preflight proves exist. These are the
 * frozen #17172 migration targets at commit 2fc20c254b96e8413b03a59318e7002826e5e730.
 */
const REQUIRED_SCHEMA_V4_COLUMNS = [
  // 0184_rollback_standby_state.sql adds a standby lifecycle column to
  // agent_sandboxes.
  "agent_sandboxes.rollback_standby_state",
  // 0185_agent_snapshot_restore_validations.sql adds a restore-validation
  // column to agent_sandboxes.
  "agent_sandboxes.restore_validation_state",
] as const;

const REQUIRED_SCHEMA_V4_CONSTRAINTS = [
  // 0184 adds a CHECK constraint bounding rollback_standby_state to the
  // allowlisted enum.
  "agent_sandboxes_rollback_standby_state_check",
  // 0185 adds a CHECK constraint bounding restore_validation_state to the
  // allowlisted enum.
  "agent_sandboxes_restore_validation_state_check",
] as const;

export async function runSchemaV4Preflight(
  client: SchemaV4PreflightClient,
): Promise<SchemaV4PreflightResult> {
  const columnsPresent: string[] = [];
  const columnsAbsent: string[] = [];
  const constraintsPresent: string[] = [];
  const constraintsAbsent: string[] = [];

  // Introspect columns: one read-only query covers all required column checks.
  const columnRows = await client.query(`
    SELECT table_name || '.' || column_name AS qualified
    FROM information_schema.columns
    WHERE table_schema = 'public'
  `);
  const foundColumns = new Set(
    columnRows
      .map((row) => row.qualified)
      .filter((value): value is string => typeof value === "string"),
  );
  for (const column of REQUIRED_SCHEMA_V4_COLUMNS) {
    if (foundColumns.has(column)) {
      columnsPresent.push(column);
    } else {
      columnsAbsent.push(column);
    }
  }

  // Introspect constraints: one read-only query covers all required checks.
  const constraintRows = await client.query(`
    SELECT conname AS name
    FROM pg_constraint
    JOIN pg_namespace ON pg_constraint.connamespace = pg_namespace.oid
    WHERE nspname = 'public'
  `);
  const foundConstraints = new Set(
    constraintRows
      .map((row) => row.name)
      .filter((value): value is string => typeof value === "string"),
  );
  for (const constraint of REQUIRED_SCHEMA_V4_CONSTRAINTS) {
    if (foundConstraints.has(constraint)) {
      constraintsPresent.push(constraint);
    } else {
      constraintsAbsent.push(constraint);
    }
  }

  return {
    ready: columnsAbsent.length === 0 && constraintsAbsent.length === 0,
    details: {
      columnsPresent,
      columnsAbsent,
      constraintsPresent,
      constraintsAbsent,
    },
  };
}

/**
 * The closed lifecycle authority surface emitted only after the schema-v4
 * preflight proves the 0184/0185 columns and constraints exist.
 */
export interface LifecycleAuthority {
  /** Transaction capture time for the read-only snapshot. */
  capturedAt: string;
  /** Current locator-presence booleans for the sandbox row. */
  locator: {
    sandboxIdPresent: boolean;
    nodeIdPresent: boolean;
    containerNamePresent: boolean;
  };
  /**
   * Closed lifecycle authority: whether the row carries rollback-standby
   * authority, restore-validation authority, or neither. Never both — the
   * #17172 contract guarantees exactly one lifecycle authority per row.
   */
  lifecycleAuthority: "rollback_standby" | "restore_validation" | "deletion_only";
  /** Whether the current row owns deletion (matches schema-v3 deletionOwned). */
  deletionOwnership: boolean;
  /**
   * Replacement-cleanup state from the existing replacement_cleanup lifecycle.
   * Null when the row is not in a replacement-cleanup phase.
   */
  replacementCleanupState: "pending" | "completed" | "absent";
  /**
   * Routed-runtime state: whether the sandbox has ever been routed to traffic.
   */
  routedRuntimeState: "routed" | "never_routed";
  /** Exact pointed source job clock (createdAt of the pointed source job). */
  sourceJobClock: string | null;
  /** Exact pointed decision job clock (createdAt of the pointed decision job). */
  decisionJobClock: string | null;
  /** Allowlisted outcomes for the source and decision jobs. */
  sourceJobOutcome: "exhausted" | "recovery" | "absent";
  decisionJobOutcome: "exhausted" | "recovery" | "absent";
  /** Closed standby state from the 0184 column. Null when absent. */
  standbyState: string | null;
  /** Never-routed restore-validation proof from the 0185 contract. */
  restoreValidation: {
    validationState: string;
    route: string;
    receiptSchema: number;
    transferProtocol: string;
    routeExposedAt: string | null;
    committed: boolean;
    retirementProof: {
      descriptorRetiredAt: string | null;
      chunksRetiredAt: string | null;
      standbyRetiredAt: string | null;
      routeBlockedAt: string | null;
    };
  } | null;
}

export interface ManagedDedicatedCanaryDiagnosticV4 {
  schemaVersion: 4;
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
  lifecycle: LifecycleAuthority;
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

export function sanitizeManagedDedicatedCanaryDiagnostic(
  raw: unknown,
  suffix: string,
): ManagedDedicatedCanaryDiagnostic {
  if (!SUFFIX_PATTERN.test(suffix))
    throw new Error("diagnostic suffix is invalid");

  const root = record(raw, "diagnostic input");
  exactKeys(root, ["targetCount", "agent", "jobs"], "diagnostic input");
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
  const deletionOwned = boolean(agent.deletionOwned, "agent.deletionOwned");
  const deletionStartedAt = timestamp(
    agent.deletionStartedAt,
    "agent.deletionStartedAt",
    true,
  );
  if (deletionOwned !== (deletionStartedAt !== null)) {
    throw new Error("agent deletion ownership and timestamp disagree");
  }
  boolean(locator.sandboxIdPresent, "locator.sandboxIdPresent");
  boolean(locator.nodeIdPresent, "locator.nodeIdPresent");
  boolean(locator.containerNamePresent, "locator.containerNamePresent");

  if (
    !Array.isArray(root.jobs) ||
    root.jobs.length < 1 ||
    root.jobs.length > 3
  ) {
    throw new Error("jobs must contain one to three newest-first records");
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

  return {
    schemaVersion: 3,
    targetCount: 1,
    sandbox: {
      status: agent.status,
      errorCode: sandboxErrorCode,
      errorCount,
      deletionStartedAt,
      updatedAt: timestamp(agent.updatedAt, "agent.updatedAt") as string,
    },
    jobs,
  };
}

// --- Schema-v4 lifecycle authority sanitization ---

/**
 * Sanitize the lifecycle authority section from the raw diagnostic input. This
 * is only called after the v3 base diagnostic has been validated and after the
 * schema-v4 preflight has confirmed the 0184/0185 columns and constraints exist.
 *
 * The lifecycle authority consumes the production reader contract
 * semantically — it validates the exact shape of the restore-proof and standby
 * records without inferring authority from latest-job ordering or timestamps
 * alone.
 */
function sanitizeLifecycleAuthority(
  raw: unknown,
  locatorPresent: { sandboxIdPresent: boolean; nodeIdPresent: boolean; containerNamePresent: boolean },
  deletionOwned: boolean,
  jobClocks: string[],
): LifecycleAuthority {
  const lifecycle = record(raw, "lifecycle");
  exactKeys(
    lifecycle,
    [
      "capturedAt",
      "lifecycleAuthority",
      "deletionOwnership",
      "replacementCleanupState",
      "routedRuntimeState",
      "sourceJobClock",
      "decisionJobClock",
      "sourceJobOutcome",
      "decisionJobOutcome",
      "standbyState",
      "restoreValidation",
      "sourceJob",
      "decisionJob",
    ],
    "lifecycle",
  );

  const capturedAt = timestamp(
    lifecycle.capturedAt,
    "lifecycle.capturedAt",
  ) as string;
  const lifecycleAuthorityValue = lifecycle.lifecycleAuthority;
  if (
    lifecycleAuthorityValue !== "rollback_standby" &&
    lifecycleAuthorityValue !== "restore_validation" &&
    lifecycleAuthorityValue !== "deletion_only"
  ) {
    throw new Error("lifecycle.lifecycleAuthority is invalid");
  }
  const deletionOwnership = boolean(
    lifecycle.deletionOwnership,
    "lifecycle.deletionOwnership",
  );
  if (deletionOwnership !== deletionOwned) {
    throw new Error("lifecycle deletion ownership disagrees with agent");
  }

  const replacementCleanupStateValue = lifecycle.replacementCleanupState;
  if (
    replacementCleanupStateValue !== "pending" &&
    replacementCleanupStateValue !== "completed" &&
    replacementCleanupStateValue !== "absent"
  ) {
    throw new Error("lifecycle.replacementCleanupState is invalid");
  }
  const routedRuntimeStateValue = lifecycle.routedRuntimeState;
  if (
    routedRuntimeStateValue !== "routed" &&
    routedRuntimeStateValue !== "never_routed"
  ) {
    throw new Error("lifecycle.routedRuntimeState is invalid");
  }

  // Source and decision job clocks must be exact ISO timestamps or null. They
  // must point at a real job in the bounded history when present — authority is
  // never inferred from timestamps alone.
  const sourceJobClock = timestamp(
    lifecycle.sourceJobClock,
    "lifecycle.sourceJobClock",
    true,
  );
  const decisionJobClock = timestamp(
    lifecycle.decisionJobClock,
    "lifecycle.decisionJobClock",
    true,
  );

  // Validate pointed source/decision job clocks against the bounded job history.
  // The source and decision job records carry their own createdAt and outcome.
  const sourceJobRecord = record(lifecycle.sourceJob, "lifecycle.sourceJob");
  exactKeys(sourceJobRecord, ["createdAt", "outcome"], "lifecycle.sourceJob");
  const decisionJobRecord = record(
    lifecycle.decisionJob,
    "lifecycle.decisionJob",
  );
  exactKeys(decisionJobRecord, ["createdAt", "outcome"], "lifecycle.decisionJob");

  const sourceJobCreatedAt = timestamp(
    sourceJobRecord.createdAt,
    "lifecycle.sourceJob.createdAt",
    true,
  );
  const decisionJobCreatedAt = timestamp(
    decisionJobRecord.createdAt,
    "lifecycle.decisionJob.createdAt",
    true,
  );
  const sourceJobOutcomeValue = sourceJobRecord.outcome;
  if (
    sourceJobOutcomeValue !== "exhausted" &&
    sourceJobOutcomeValue !== "recovery" &&
    sourceJobOutcomeValue !== "absent"
  ) {
    throw new Error("lifecycle.sourceJob.outcome is invalid");
  }
  const decisionJobOutcomeValue = decisionJobRecord.outcome;
  if (
    decisionJobOutcomeValue !== "exhausted" &&
    decisionJobOutcomeValue !== "recovery" &&
    decisionJobOutcomeValue !== "absent"
  ) {
    throw new Error("lifecycle.decisionJob.outcome is invalid");
  }

  // Cross-check: if a clock is present it must match its job record and a job
  // in the bounded history. If absent, the job record must also be absent.
  if (sourceJobClock === null) {
    if (sourceJobCreatedAt !== null || sourceJobOutcomeValue !== "absent") {
      throw new Error("lifecycle source job clock and record disagree");
    }
  } else {
    if (sourceJobClock !== sourceJobCreatedAt) {
      throw new Error("lifecycle source job clock does not match record");
    }
    if (!jobClocks.includes(sourceJobClock)) {
      throw new Error("lifecycle source job clock is not in bounded history");
    }
  }
  if (decisionJobClock === null) {
    if (decisionJobCreatedAt !== null || decisionJobOutcomeValue !== "absent") {
      throw new Error("lifecycle decision job clock and record disagree");
    }
  } else {
    if (decisionJobClock !== decisionJobCreatedAt) {
      throw new Error("lifecycle decision job clock does not match record");
    }
    if (!jobClocks.includes(decisionJobClock)) {
      throw new Error("lifecycle decision job clock is not in bounded history");
    }
  }

  // A row cannot carry both a source and decision job that are the same clock
  // unless the lifecycle authority is deletion_only (where they represent the
  // same exhausted attempt).
  if (
    sourceJobClock !== null &&
    decisionJobClock !== null &&
    sourceJobClock === decisionJobClock &&
    lifecycleAuthorityValue !== "deletion_only"
  ) {
    throw new Error("lifecycle dual authority is contradictory");
  }

  // Validate standby state from the 0184 column.
  let standbyState: string | null = null;
  if (lifecycle.standbyState !== null) {
    if (typeof lifecycle.standbyState !== "string") {
      throw new Error("lifecycle.standbyState must be a string or null");
    }
    if (!STANDBY_STATES.has(lifecycle.standbyState)) {
      throw new Error("lifecycle.standbyState is not an allowlisted standby enum");
    }
    standbyState = lifecycle.standbyState;
    // Standby state requires rollback_standby authority.
    if (lifecycleAuthorityValue !== "rollback_standby") {
      throw new Error("lifecycle standby state without rollback_standby authority");
    }
  } else {
    if (lifecycleAuthorityValue === "rollback_standby") {
      throw new Error("lifecycle rollback_standby authority requires standby state");
    }
  }

  // Validate the never-routed restore-validation proof from the 0185 contract.
  let restoreValidation: LifecycleAuthority["restoreValidation"] = null;
  if (lifecycle.restoreValidation !== null) {
    if (lifecycleAuthorityValue !== "restore_validation") {
      throw new Error(
        "lifecycle restore validation present without restore_validation authority",
      );
    }
    const rv = record(lifecycle.restoreValidation, "lifecycle.restoreValidation");
    exactKeys(
      rv,
      [
        "validationState",
        "route",
        "receiptSchema",
        "transferProtocol",
        "routeExposedAt",
        "committed",
        "retirementProof",
      ],
      "lifecycle.restoreValidation",
    );
    if (
      typeof rv.validationState !== "string" ||
      !RESTORE_VALIDATION_STATES.has(rv.validationState)
    ) {
      throw new Error(
        "lifecycle.restoreValidation.validationState is not an allowlisted enum",
      );
    }
    if (rv.route !== RESTORE_VALIDATION_ROUTE) {
      throw new Error("lifecycle.restoreValidation.route is invalid");
    }
    const receiptSchema = integer(
      rv.receiptSchema,
      "lifecycle.restoreValidation.receiptSchema",
      RESTORE_RECEIPT_SCHEMA,
      RESTORE_RECEIPT_SCHEMA,
    );
    if (rv.transferProtocol !== RESTORE_TRANSFER_PROTOCOL) {
      throw new Error("lifecycle.restoreValidation.transferProtocol is invalid");
    }
    const routeExposedAt = timestamp(
      rv.routeExposedAt,
      "lifecycle.restoreValidation.routeExposedAt",
      true,
    );
    // The never-routed proof requires route_exposed_at to remain null.
    if (routeExposedAt !== null) {
      throw new Error(
        "lifecycle.restoreValidation.routeExposedAt must remain null for never-routed proof",
      );
    }
    const committed = boolean(
      rv.committed,
      "lifecycle.restoreValidation.committed",
    );

    // Validate the retirement/absence proof timestamps.
    const rp = record(
      rv.retirementProof,
      "lifecycle.restoreValidation.retirementProof",
    );
    exactKeys(
      rp,
      ["descriptorRetiredAt", "chunksRetiredAt", "standbyRetiredAt", "routeBlockedAt"],
      "lifecycle.restoreValidation.retirementProof",
    );
    const retirementProof = {
      descriptorRetiredAt: timestamp(
        rp.descriptorRetiredAt,
        "lifecycle.restoreValidation.retirementProof.descriptorRetiredAt",
        true,
      ),
      chunksRetiredAt: timestamp(
        rp.chunksRetiredAt,
        "lifecycle.restoreValidation.retirementProof.chunksRetiredAt",
        true,
      ),
      standbyRetiredAt: timestamp(
        rp.standbyRetiredAt,
        "lifecycle.restoreValidation.retirementProof.standbyRetiredAt",
        true,
      ),
      routeBlockedAt: timestamp(
        rp.routeBlockedAt,
        "lifecycle.restoreValidation.retirementProof.routeBlockedAt",
        true,
      ),
    };

    // A committed receipt requires a complete retirement proof: all four
    // retirement/absence proof timestamps must be present.
    if (committed) {
      if (
        retirementProof.descriptorRetiredAt === null ||
        retirementProof.chunksRetiredAt === null ||
        retirementProof.standbyRetiredAt === null ||
        retirementProof.routeBlockedAt === null
      ) {
        throw new Error(
          "lifecycle committed restore receipt requires all four retirement proof timestamps",
        );
      }
    }

    restoreValidation = {
      validationState: rv.validationState,
      route: RESTORE_VALIDATION_ROUTE,
      receiptSchema,
      transferProtocol: RESTORE_TRANSFER_PROTOCOL,
      routeExposedAt: null,
      committed,
      retirementProof,
    };
  } else {
    if (lifecycleAuthorityValue === "restore_validation") {
      throw new Error(
        "lifecycle restore_validation authority requires restore validation proof",
      );
    }
  }

  // Existing stale deletion-owned rows must remain classifiable without
  // fabricating standby or restore state. When lifecycleAuthority is
  // deletion_only, both standbyState and restoreValidation must be null.
  if (
    lifecycleAuthorityValue === "deletion_only" &&
    (standbyState !== null || restoreValidation !== null)
  ) {
    throw new Error(
      "lifecycle deletion_only authority must not carry standby or restore state",
    );
  }

  return {
    capturedAt,
    locator: { ...locatorPresent },
    lifecycleAuthority: lifecycleAuthorityValue,
    deletionOwnership,
    replacementCleanupState: replacementCleanupStateValue,
    routedRuntimeState: routedRuntimeStateValue,
    sourceJobClock,
    decisionJobClock,
    sourceJobOutcome: sourceJobOutcomeValue,
    decisionJobOutcome: decisionJobOutcomeValue,
    standbyState,
    restoreValidation,
  };
}

/**
 * Sanitize the full schema-v4 diagnostic: the existing schema-v3 fields plus
 * the lifecycle authority. The preflight result must be passed to prove the
 * 0184/0185 columns and constraints exist before schemaVersion: 4 is emitted.
 */
export function sanitizeManagedDedicatedCanaryDiagnosticV4(
  raw: unknown,
  suffix: string,
  preflight: SchemaV4PreflightResult,
): ManagedDedicatedCanaryDiagnosticV4 {
  if (!preflight.ready) {
    throw new Error(
      "schema-v4 diagnostic requires a passing 0184/0185 schema preflight",
    );
  }

  const root = record(raw, "diagnostic input");
  // The v4 input carries an additional lifecycle key alongside the v3 keys.
  exactKeys(
    root,
    ["targetCount", "agent", "jobs", "lifecycle"],
    "diagnostic input",
  );

  // Reuse the v3 sanitizer on a v3-shaped projection (without the lifecycle
  // key) so every existing field and invariant is preserved.
  const v3Projection = sanitizeManagedDedicatedCanaryDiagnostic(
    {
      targetCount: root.targetCount,
      agent: root.agent,
      jobs: root.jobs,
    },
    suffix,
  );

  // Extract locator booleans from the agent for the lifecycle section.
  const agent = record(root.agent, "agent");
  const locator = record(agent.locator, "agent.locator");
  const locatorPresent = {
    sandboxIdPresent: boolean(locator.sandboxIdPresent, "locator.sandboxIdPresent"),
    nodeIdPresent: boolean(locator.nodeIdPresent, "locator.nodeIdPresent"),
    containerNamePresent: boolean(
      locator.containerNamePresent,
      "locator.containerNamePresent",
    ),
  };
  const deletionOwned = boolean(agent.deletionOwned, "agent.deletionOwned");

  // Collect job createdAt clocks for cross-checking lifecycle pointers.
  const jobClocks = v3Projection.jobs.map((job) => job.createdAt);

  const lifecycle = sanitizeLifecycleAuthority(
    root.lifecycle,
    locatorPresent,
    deletionOwned,
    jobClocks,
  );

  return {
    schemaVersion: 4,
    targetCount: 1,
    sandbox: v3Projection.sandbox,
    jobs: v3Projection.jobs,
    lifecycle,
  };
}

/**
 * Project a schema-v4 diagnostic back to schema-v3, proving old fields and
 * semantics are unchanged. This is the exact schema-v3 golden: every v3 field
 * is present with the same value, and the lifecycle section is dropped.
 */
export function projectDiagnosticV3(
  v4: ManagedDedicatedCanaryDiagnosticV4,
): ManagedDedicatedCanaryDiagnostic {
  return {
    schemaVersion: 3,
    targetCount: v4.targetCount,
    sandbox: { ...v4.sandbox },
    jobs: v4.jobs.map((job) => ({ ...job })),
  };
}

export function canonicalizeManagedDedicatedCanaryDiagnosticV4(
  rawText: string,
  suffix: string,
  preflight: SchemaV4PreflightResult,
): string {
  const evidence = sanitizeManagedDedicatedCanaryDiagnosticV4(
    JSON.parse(rawText),
    suffix,
    preflight,
  );
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

export function canonicalizeManagedDedicatedCanaryDiagnostic(
  rawText: string,
  suffix: string,
): string {
  const evidence = sanitizeManagedDedicatedCanaryDiagnostic(
    JSON.parse(rawText),
    suffix,
  );
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
