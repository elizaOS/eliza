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

type RecoveryCode =
  | "none"
  | "worker_restart_recovered"
  | "timeout_recovered";

interface RecoveryClassification {
  code: Exclude<RecoveryCode, "none">;
  attempt: number;
  maxAttempts: number;
}

interface TerminalFailureClassification {
  code: Extract<ErrorCode, "timeout" | "worker_restart_interrupted">;
  attempts: number;
}

const RECOVERY_PARTIAL_RESULT_ERRORS = new Map<string, ErrorCode>([
  ["Failed to delete sandbox", "sandbox_stop_failed"],
  [
    "Agent replacement cleanup is still pending",
    "replacement_cleanup_pending",
  ],
  ["Agent provisioning is in progress", "provisioning_in_progress"],
  ["Agent deletion ownership changed", "lifecycle_conflict"],
]);

export interface ManagedDedicatedCanaryDiagnostic {
  schemaVersion: 2;
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
    scheduledFor: string;
    startedAt: string | null;
    completedAt: string | null;
    createdAt: string;
    updatedAt: string;
    durationMs: number | null;
    queueDurationMs: number | null;
  }>;
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

function classifyError(value: unknown, label: string): ErrorCode {
  if (value === null) return "none";
  if (typeof value !== "string" || value.length === 0 || value.length > 2_000) {
    throw new Error(`${label} must be a bounded string or null`);
  }
  const permanentDelete =
    /^Deletion permanently failed after [1-9][0-9]* attempts: (.+)$/.exec(
      value,
    );
  if (permanentDelete)
    return classifyError(permanentDelete[1], `${label} cause`);
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
  throw new Error(`${label} is not covered by the privacy-safe classifier`);
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
    root.jobs.length > 5
  ) {
    throw new Error("jobs must contain one to five newest-first records");
  }

  let previousCreatedAt = Number.POSITIVE_INFINITY;
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
      typeof job.error === "string"
        ? classifyTerminalFailure(job.error)
        : null;
    const recovery = classifyRecovery(job.error, `jobs[${index}].error`);
    const jobErrorCode = recovery
      ? "none"
      : classifyError(job.error, `jobs[${index}].error`);
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
    if (
      recovery &&
      job.status !== "pending" &&
      job.status !== "in_progress"
    ) {
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
      throw new Error(`jobs[${index}] recovery result is not a partial failure`);
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

    return {
      status: job.status,
      attempts,
      maxAttempts,
      containerStopped,
      rowDeleted,
      errorCode: jobErrorCode,
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

  const sandboxErrorCode = classifyError(
    agent.errorMessage,
    "agent.errorMessage",
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
    schemaVersion: 2,
    targetCount: 1,
    sandbox: {
      status: agent.status,
      errorCode: sandboxErrorCode,
      errorCount: integer(agent.errorCount, "agent.errorCount", 0, 1_000),
      deletionStartedAt,
      updatedAt: timestamp(agent.updatedAt, "agent.updatedAt") as string,
    },
    jobs,
  };
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
