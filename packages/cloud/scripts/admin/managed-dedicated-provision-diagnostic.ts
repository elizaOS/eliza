/**
 * Converts one exact staging canary's provision row into a privacy-safe
 * operator artifact. The workflow keeps the raw database snapshot local and
 * uploads only allowlisted lifecycle facts and a closed failure category.
 */

import { chmodSync, readFileSync, writeFileSync } from "node:fs";

type JsonRecord = Record<string, unknown>;

const SUFFIX_PATTERN = /^r[1-9][0-9]{7,19}a[1-9][0-9]{0,3}$/;
const FORBIDDEN_OUTPUT_PATTERN =
  /(?:https?:\/\/|(?:\d{1,3}\.){3}\d{1,3}|\b(?:token|secret|password|api[_-]?key)\b|managed-dedicated-canary-|sha256:|[0-9a-f]{8}-[0-9a-f-]{27,})/i;

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
const DATABASE_STATUSES = new Set(["none", "provisioning", "ready", "error"]);
const JOB_STATUSES = new Set([
  "pending",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
]);

export type ManagedDedicatedProvisionFailureCode =
  | "none"
  | "capacity"
  | "image"
  | "secrets"
  | "database"
  | "ingress"
  | "container_ssh_auth"
  | "container_ssh_timeout"
  | "container_ssh_refused"
  | "container_ssh_dns"
  | "container_ssh_reset"
  | "container_ssh_connect_error"
  | "container_ssh_exec_error"
  | "container_ssh_command_exit"
  | "container_ssh_stream_error"
  | "container_ssh_transport"
  | "container_daemon"
  | "container_create"
  | "container_configuration"
  | "container_identity"
  | "container_replacement"
  | "container"
  | "transport"
  | "runtime"
  | "lifecycle"
  | "timeout"
  | "unclassified";

export interface ManagedDedicatedProvisionDiagnostic {
  schemaVersion: 1;
  targetCount: 1;
  sandbox: {
    status: string;
    executionTier: "dedicated-always";
    databaseStatus: string;
    errorCode: ManagedDedicatedProvisionFailureCode;
    errorCount: number;
    locator: {
      sandboxIdPresent: boolean;
      nodeIdPresent: boolean;
      containerNamePresent: boolean;
      headscaleIpPresent: boolean;
    };
    replacementLocator: {
      sandboxIdPresent: boolean;
      nodeIdPresent: boolean;
      containerNamePresent: boolean;
      attemptIdPresent: boolean;
      containerIdPresent: boolean;
      vpnNodeIdPresent: boolean;
    };
    updatedAt: string;
  };
  provisionJob: {
    status: string;
    attempts: number;
    maxAttempts: number;
    retryableRequeues: number;
    executionInterruptions: number;
    errorCode: ManagedDedicatedProvisionFailureCode;
    resultErrorCode: ManagedDedicatedProvisionFailureCode;
    scheduledFor: string;
    startedAt: string | null;
    completedAt: string | null;
    createdAt: string;
    updatedAt: string;
    queueDurationMs: number | null;
    durationMs: number | null;
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
  maximum = 100,
): number {
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

function elapsedMs(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const elapsed = Date.parse(end) - Date.parse(start);
  if (!Number.isSafeInteger(elapsed) || elapsed < 0) {
    throw new Error("diagnostic timestamps are out of order");
  }
  return elapsed;
}

export function classifyManagedDedicatedProvisionFailure(
  value: unknown,
  label: string,
): ManagedDedicatedProvisionFailureCode {
  if (value === null) return "none";
  if (typeof value !== "string" || value.length === 0 || value.length > 8_000) {
    throw new Error(`${label} must be a bounded string or null`);
  }
  // Job persistence appends stack frames for operator diagnosis. Classifying
  // the whole value makes source paths such as docker-sandbox-provider.ts look
  // like the failure itself, so only the primary error line may choose a code.
  const primary = value.split(/\r?\n/, 1)[0] ?? "";

  if (
    /(?:secret|credential|decrypt|encryption|kms|master key|api[_ -]?key)/i.test(
      primary,
    )
  ) {
    return "secrets";
  }
  if (
    /(?:database|postgres|pglite|drizzle|\bsql\b|migration|tenant[_ -]?db|failed query)/i.test(
      primary,
    )
  ) {
    return "database";
  }
  if (
    /(?:image|manifest|pull access denied|registry|ghcr|digest)/i.test(primary)
  ) {
    return "image";
  }
  if (
    /(?:capacity|no (?:eligible|available) (?:docker )?nodes?|no (?:docker )?nodes? available|none (?:are|is) available for placement|no valid nodes parsed|insufficient|quota|resource exhausted|allocation limit|server limit|placement unavailable)/i.test(
      primary,
    )
  ) {
    return "capacity";
  }
  if (
    /(?:headscale|tailnet|tailscale|mesh|ingress|bridge port|proxy route)/i.test(
      primary,
    )
  ) {
    return "ingress";
  }
  if (
    /(?:permission denied|publickey|host key|fingerprint mismatch|authentication (?:methods )?failed|all configured authentication methods failed|private key)/i.test(
      primary,
    )
  ) {
    return "container_ssh_auth";
  }
  if (
    /(?:timed out|timeout|etimedout)/i.test(primary) &&
    /(?:ssh|\[docker-ssh\])/i.test(primary)
  ) {
    return "container_ssh_timeout";
  }
  if (/(?:connection refused|econnrefused)/i.test(primary)) {
    return "container_ssh_refused";
  }
  if (/(?:getaddrinfo|enotfound|eai_again)/i.test(primary)) {
    return "container_ssh_dns";
  }
  if (/(?:econnreset|connection reset|connection closed)/i.test(primary)) {
    return "container_ssh_reset";
  }
  if (/\[docker-ssh\] connection error/i.test(primary)) {
    return "container_ssh_connect_error";
  }
  if (/\[docker-ssh\] exec(?:stream)? error/i.test(primary)) {
    return "container_ssh_exec_error";
  }
  if (/\[docker-ssh\] command exited with code/i.test(primary)) {
    return "container_ssh_command_exit";
  }
  if (/\[docker-ssh\] (?:execstream channel|stream) error/i.test(primary)) {
    return "container_ssh_stream_error";
  }
  if (/(?:\[docker-ssh\]|ssh|handshake)/i.test(primary)) {
    return "container_ssh_transport";
  }
  if (
    /(?:docker daemon|cannot connect to docker|daemon is unavailable)/i.test(
      primary,
    )
  ) {
    return "container_daemon";
  }
  if (
    /(?:failed to create container|docker create|docker run)/i.test(primary)
  ) {
    return "container_create";
  }
  if (
    /(?=.*(?:docker|container|sandbox))(?=.*(?:not set|not configured|invalid|required|missing))/i.test(
      primary,
    )
  ) {
    return "container_configuration";
  }
  if (/(?=.*(?:docker|container))(?=.*identity)/i.test(primary)) {
    return "container_identity";
  }
  if (/replacement/i.test(primary)) return "container_replacement";
  if (
    /(?:docker|container|sandbox provider|container runtime|port allocation|ssh)/i.test(
      primary,
    )
  ) {
    return "container";
  }
  if (
    /(?:econnreset|econnrefused|enetdown|enetunreach|ehostunreach|getaddrinfo|socket|fetch failed|network)/i.test(
      primary,
    )
  ) {
    return "transport";
  }
  if (/(?:timed out|timeout|etimedout)/i.test(primary)) return "timeout";
  if (/(?:health|readiness|heartbeat|runtime|startup|bridge)/i.test(primary)) {
    return "runtime";
  }
  if (
    /(?:lifecycle|identity changed|ownership changed|organization id mismatch|conflicting agent_)/i.test(
      primary,
    )
  ) {
    return "lifecycle";
  }
  return "unclassified";
}

export function sanitizeManagedDedicatedProvisionDiagnostic(
  raw: unknown,
  suffix: string,
): ManagedDedicatedProvisionDiagnostic {
  if (!SUFFIX_PATTERN.test(suffix))
    throw new Error("diagnostic suffix is invalid");

  const root = record(raw, "diagnostic input");
  exactKeys(root, ["targetCount", "agent", "provisionJob"], "diagnostic input");
  if (integer(root.targetCount, "targetCount", 0, 2) !== 1) {
    throw new Error("diagnostic input must resolve exactly one target");
  }

  const agent = record(root.agent, "agent");
  exactKeys(
    agent,
    [
      "status",
      "executionTier",
      "databaseStatus",
      "errorMessage",
      "errorCount",
      "updatedAt",
      "locator",
      "replacementLocator",
    ],
    "agent",
  );
  if (typeof agent.status !== "string" || !SANDBOX_STATUSES.has(agent.status)) {
    throw new Error("agent.status is invalid");
  }
  if (agent.executionTier !== "dedicated-always") {
    throw new Error("agent.executionTier must be dedicated-always");
  }
  if (
    typeof agent.databaseStatus !== "string" ||
    !DATABASE_STATUSES.has(agent.databaseStatus)
  ) {
    throw new Error("agent.databaseStatus is invalid");
  }
  const locator = record(agent.locator, "agent.locator");
  exactKeys(
    locator,
    [
      "sandboxIdPresent",
      "nodeIdPresent",
      "containerNamePresent",
      "headscaleIpPresent",
    ],
    "agent.locator",
  );
  const replacementLocator = record(
    agent.replacementLocator,
    "agent.replacementLocator",
  );
  exactKeys(
    replacementLocator,
    [
      "sandboxIdPresent",
      "nodeIdPresent",
      "containerNamePresent",
      "attemptIdPresent",
      "containerIdPresent",
      "vpnNodeIdPresent",
    ],
    "agent.replacementLocator",
  );

  const provisionJob = record(root.provisionJob, "provisionJob");
  exactKeys(
    provisionJob,
    [
      "status",
      "error",
      "resultError",
      "attempts",
      "maxAttempts",
      "retryableRequeues",
      "executionInterruptions",
      "resultStorage",
      "errorStorage",
      "scheduledFor",
      "startedAt",
      "completedAt",
      "createdAt",
      "updatedAt",
    ],
    "provisionJob",
  );
  if (
    typeof provisionJob.status !== "string" ||
    !JOB_STATUSES.has(provisionJob.status)
  ) {
    throw new Error("provisionJob.status is invalid");
  }
  if (
    provisionJob.resultStorage !== "inline" ||
    provisionJob.errorStorage !== "inline"
  ) {
    throw new Error("provisionJob diagnostic payloads must be inline");
  }

  const attempts = integer(provisionJob.attempts, "provisionJob.attempts");
  const maxAttempts = integer(
    provisionJob.maxAttempts,
    "provisionJob.maxAttempts",
    1,
  );
  if (attempts > maxAttempts)
    throw new Error("provisionJob attempts exceed maxAttempts");
  const retryableRequeues = integer(
    provisionJob.retryableRequeues,
    "provisionJob.retryableRequeues",
  );
  const executionInterruptions = integer(
    provisionJob.executionInterruptions,
    "provisionJob.executionInterruptions",
  );
  const scheduledFor = timestamp(
    provisionJob.scheduledFor,
    "provisionJob.scheduledFor",
  ) as string;
  const startedAt = timestamp(
    provisionJob.startedAt,
    "provisionJob.startedAt",
    true,
  );
  const completedAt = timestamp(
    provisionJob.completedAt,
    "provisionJob.completedAt",
    true,
  );
  const createdAt = timestamp(
    provisionJob.createdAt,
    "provisionJob.createdAt",
  ) as string;
  const updatedAt = timestamp(
    provisionJob.updatedAt,
    "provisionJob.updatedAt",
  ) as string;
  if (Date.parse(scheduledFor) < Date.parse(createdAt)) {
    throw new Error("provisionJob schedule predates creation");
  }
  if (provisionJob.status === "failed" && attempts !== maxAttempts) {
    throw new Error("failed provisionJob has not exhausted attempts");
  }
  if (provisionJob.status === "completed" && provisionJob.error !== null) {
    throw new Error("completed provisionJob retains an error");
  }

  return {
    schemaVersion: 1,
    targetCount: 1,
    sandbox: {
      status: agent.status,
      executionTier: "dedicated-always",
      databaseStatus: agent.databaseStatus,
      errorCode: classifyManagedDedicatedProvisionFailure(
        agent.errorMessage,
        "agent.errorMessage",
      ),
      errorCount: integer(agent.errorCount, "agent.errorCount", 0, 10_000),
      locator: {
        sandboxIdPresent: boolean(
          locator.sandboxIdPresent,
          "locator.sandboxIdPresent",
        ),
        nodeIdPresent: boolean(locator.nodeIdPresent, "locator.nodeIdPresent"),
        containerNamePresent: boolean(
          locator.containerNamePresent,
          "locator.containerNamePresent",
        ),
        headscaleIpPresent: boolean(
          locator.headscaleIpPresent,
          "locator.headscaleIpPresent",
        ),
      },
      replacementLocator: {
        sandboxIdPresent: boolean(
          replacementLocator.sandboxIdPresent,
          "replacementLocator.sandboxIdPresent",
        ),
        nodeIdPresent: boolean(
          replacementLocator.nodeIdPresent,
          "replacementLocator.nodeIdPresent",
        ),
        containerNamePresent: boolean(
          replacementLocator.containerNamePresent,
          "replacementLocator.containerNamePresent",
        ),
        attemptIdPresent: boolean(
          replacementLocator.attemptIdPresent,
          "replacementLocator.attemptIdPresent",
        ),
        containerIdPresent: boolean(
          replacementLocator.containerIdPresent,
          "replacementLocator.containerIdPresent",
        ),
        vpnNodeIdPresent: boolean(
          replacementLocator.vpnNodeIdPresent,
          "replacementLocator.vpnNodeIdPresent",
        ),
      },
      updatedAt: timestamp(agent.updatedAt, "agent.updatedAt") as string,
    },
    provisionJob: {
      status: provisionJob.status,
      attempts,
      maxAttempts,
      retryableRequeues,
      executionInterruptions,
      errorCode: classifyManagedDedicatedProvisionFailure(
        provisionJob.error,
        "provisionJob.error",
      ),
      resultErrorCode: classifyManagedDedicatedProvisionFailure(
        provisionJob.resultError,
        "provisionJob.resultError",
      ),
      scheduledFor,
      startedAt,
      completedAt,
      createdAt,
      updatedAt,
      queueDurationMs: elapsedMs(createdAt, startedAt),
      durationMs: elapsedMs(startedAt, completedAt ?? updatedAt),
    },
  };
}

export function canonicalizeManagedDedicatedProvisionDiagnostic(
  value: unknown,
): string {
  const diagnostic = record(value, "diagnostic artifact");
  const canonical = `${JSON.stringify(diagnostic, null, 2)}\n`;
  if (FORBIDDEN_OUTPUT_PATTERN.test(canonical)) {
    throw new Error("diagnostic artifact contains a forbidden value shape");
  }
  return canonical;
}

export function writeManagedDedicatedProvisionDiagnostic(
  suffix: string,
  rawPath: string,
  evidencePath: string,
): void {
  const raw = JSON.parse(readFileSync(rawPath, "utf8")) as unknown;
  const sanitized = sanitizeManagedDedicatedProvisionDiagnostic(raw, suffix);
  const canonical = canonicalizeManagedDedicatedProvisionDiagnostic(sanitized);
  writeFileSync(evidencePath, canonical, { mode: 0o600 });
  chmodSync(evidencePath, 0o600);
}

if (import.meta.main) {
  const [suffix, rawPath, evidencePath] = process.argv.slice(2);
  if (!suffix || !rawPath || !evidencePath) {
    throw new Error(
      "usage: managed-dedicated-provision-diagnostic <suffix> <raw> <evidence>",
    );
  }
  writeManagedDedicatedProvisionDiagnostic(suffix, rawPath, evidencePath);
}
