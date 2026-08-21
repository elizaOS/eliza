#!/usr/bin/env -S npx tsx
/**
 * Dedicated manifest-v3 backup catalogue worker. The production composition
 * is disabled-first, cycles are bounded and serial, and SIGTERM cancellation
 * is propagated into capture/publication while durable database leases and the
 * persistent StateDirectory make a later process replay-safe.
 */

import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentBackupCatalogRuntimeSummary } from "@elizaos/cloud-shared/lib/services/agent-backup-catalog-runtime";
import {
  type AgentBackupCatalogWorkerComposition,
  createAgentBackupCatalogWorkerComposition,
} from "@elizaos/cloud-shared/lib/services/agent-backup-catalog-worker-composition";

export type BackupCatalogWorkerState =
  | "disabled"
  | "idle"
  | "running"
  | "degraded"
  | "retryable-failure"
  | "terminal-configuration-failure"
  | "bounded-shutdown";

export interface BackupCatalogWorkerConfig {
  runOnce: boolean;
  intervalMs: number;
  retryMs: number;
  shutdownTimeoutMs: number;
  healthFile: string;
}

export interface BackupCatalogWorkerHealth {
  format: "elizaos.agent-backup.catalog-worker-health.v1";
  state: BackupCatalogWorkerState;
  enabled: boolean;
  pid: number;
  updatedAt: string;
  startedAt: string;
  cycles: number;
  failures: number;
  lastCycleStartedAt: string | null;
  lastCycleCompletedAt: string | null;
  lastDurationMs: number | null;
  lastAlertCodes: readonly string[];
  lastCycleMetrics: Readonly<BackupCatalogWorkerCycleMetrics> | null;
}

export interface BackupCatalogWorkerCycleMetrics {
  scheduleEnrolled: number;
  scheduleProtected: number;
  scheduleRecycled: number;
  scheduleClaimed: number;
  scheduleReserved: number;
  scheduleDeferred: number;
  scheduleIndeterminate: number;
  scheduleOverdue: number;
  operationClaimed: number;
  operationCaptured: number;
  operationCaptureRetryScheduled: number;
  operationCaptureTerminal: number;
  operationProtected: number;
  operationPublicationRetryScheduled: number;
  operationDeferred: number;
  operationIndeterminate: number;
  spoolCleanupDiscovered: number;
  spoolCleanupAuthorized: number;
  spoolCleanupCompleted: number;
  spoolCleanupPending: number;
  spoolCleanupSkippedUnprotected: number;
  spoolCleanupIndeterminate: number;
  deletionCandidates: number;
  deletionEnqueued: number;
  deletionEnqueueIndeterminate: number;
  gcClaimed: number;
  gcCompleted: number;
  gcFailed: number;
  gcIndeterminate: number;
  deletionFinalized: number;
  deletionFinalizeIndeterminate: number;
}

type WorkerLogger =
  typeof import("@elizaos/cloud-shared/lib/utils/logger").logger;

export interface BackupCatalogWorkerDependencies {
  createComposition(input: {
    env: NodeJS.ProcessEnv;
  }): Promise<AgentBackupCatalogWorkerComposition>;
  writeHealth(
    filePath: string,
    health: Readonly<BackupCatalogWorkerHealth>,
  ): Promise<void>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  logger: Pick<WorkerLogger, "info" | "warn" | "error">;
}

export interface BackupCatalogWorkerRunResult {
  state: BackupCatalogWorkerState;
  exitCode: number;
  cycles: number;
  failures: number;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_RETRY_MS = 5_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;
const DEFAULT_HEALTH_FILE = "/run/eliza-backup-catalog/health.json";
const CONFIG_ERROR_EXIT_CODE = 78;
const MIN_CYCLE_DELAY_MS = 5_000;
const MIN_SHUTDOWN_TIMEOUT_MS = 1_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 25_000;
const MAX_HEALTH_COUNTER = 1_000_000_000;

const SAFE_BACKUP_CATALOG_ERROR_CODES = new Set([
  "AGENT_BACKUP_CATALOG_CYCLE_FAILED",
  "AGENT_BACKUP_V2_CAPTURE_ABORTED",
  "AGENT_BACKUP_V2_CAPTURE_DEADLINE_EXCEEDED",
  "AGENT_BACKUP_V2_PIPELINE_ABORTED",
  "AGENT_BACKUP_V2_PIPELINE_DEADLINE_EXCEEDED",
  "AGENT_BACKUP_V2_PIPELINE_LEASE_LOST",
  "AGENT_BACKUP_V3_RUNTIME_AUTHORITY_STALE",
  "AGENT_BACKUP_V3_RUNTIME_AUTHORITY_UNAVAILABLE",
  "AGENT_BACKUP_V3_RUNTIME_IDENTITY_CHANGED",
  "AGENT_BACKUP_V3_VAULT_AUTHORITY_CHANGED",
]);

const SAFE_BACKUP_CATALOG_ALERT_CODES = new Set([
  "BACKUP_CAPTURE_V2_RETRY_SCHEDULED",
  "BACKUP_CAPTURE_V2_TERMINAL",
  "BACKUP_DELETION_ENQUEUE_RECONCILE_REQUIRED",
  "BACKUP_DELETION_FINALIZE_RECONCILE_REQUIRED",
  "BACKUP_GC_RECONCILE_REQUIRED",
  "BACKUP_GC_RETRY_SCHEDULED",
  "BACKUP_OPERATION_RECONCILE_REQUIRED",
  "BACKUP_PIPELINE_STAGE_UNAVAILABLE",
  "BACKUP_PRIMARY_PUBLICATION_RETRY",
  "BACKUP_PUBLICATION_RETRY_SCHEDULED",
  "BACKUP_SCHEDULE_RECONCILE_REQUIRED",
  "BACKUP_SCHEDULE_RESERVATION_RETRY",
  "BACKUP_SCHEDULE_RPO_OVERDUE",
  "BACKUP_SECONDARY_REPLICATION_RETRY",
  "BACKUP_SPOOL_CLEANUP_RECONCILE_REQUIRED",
]);

const SAFE_BACKUP_CATALOG_CONFIGURATION_NAMES = new Set([
  "AGENT_BACKUP_AGENT_SCHEMA_VERSION",
  "AGENT_BACKUP_CAPTURE_DEADLINE_MS",
  "AGENT_BACKUP_CATALOG_RUNTIME_ENABLED",
  "AGENT_BACKUP_CATALOG_WORKER_HEALTH_FILE",
  "AGENT_BACKUP_CATALOG_WORKER_ID",
  "AGENT_BACKUP_CATALOG_WORKER_INTERVAL_MS",
  "AGENT_BACKUP_CATALOG_WORKER_RETRY_MS",
  "AGENT_BACKUP_CATALOG_WORKER_SHUTDOWN_TIMEOUT_MS",
  "AGENT_BACKUP_DATABASE_SCHEMA_VERSION",
  "AGENT_BACKUP_DELETION_BATCH_SIZE",
  "AGENT_BACKUP_GC_BATCH_SIZE",
  "AGENT_BACKUP_GC_LEASE_MS",
  "AGENT_BACKUP_GC_RETRY_BASE_MS",
  "AGENT_BACKUP_GC_RETRY_MAX_MS",
  "AGENT_BACKUP_HETZNER_ACCESS_KEY_ID",
  "AGENT_BACKUP_HETZNER_ACCOUNT_ID",
  "AGENT_BACKUP_HETZNER_BUCKET",
  "AGENT_BACKUP_HETZNER_ENDPOINT",
  "AGENT_BACKUP_HETZNER_ENDPOINT_ALIAS",
  "AGENT_BACKUP_HETZNER_REGION",
  "AGENT_BACKUP_HETZNER_SECRET_ACCESS_KEY",
  "AGENT_BACKUP_LEGACY_WRITER_DRAINED_AT",
  "AGENT_BACKUP_LEGACY_WRITER_DRAIN_DEPLOYMENT_ID",
  "AGENT_BACKUP_OBJECT_TRANSFER_DEADLINE_MS",
  "AGENT_BACKUP_OPERATION_BATCH_SIZE",
  "AGENT_BACKUP_OPERATION_LEASE_MS",
  "AGENT_BACKUP_OPERATION_RETRY_BASE_MS",
  "AGENT_BACKUP_OPERATION_RETRY_MAX_MS",
  "AGENT_BACKUP_R2_ACCESS_KEY_ID",
  "AGENT_BACKUP_R2_ACCOUNT_ID",
  "AGENT_BACKUP_R2_BUCKET",
  "AGENT_BACKUP_R2_ENDPOINT",
  "AGENT_BACKUP_R2_ENDPOINT_ALIAS",
  "AGENT_BACKUP_R2_REGION",
  "AGENT_BACKUP_R2_SECRET_ACCESS_KEY",
  "AGENT_BACKUP_RPO_SCHEDULER_ENABLED",
  "AGENT_BACKUP_RUNTIME_PLUGINS_JSON",
  "AGENT_BACKUP_SCHEDULE_BATCH_SIZE",
  "AGENT_BACKUP_SCHEDULE_LEASE_MS",
  "AGENT_BACKUP_SCHEDULE_RETRY_MS",
  "AGENT_BACKUP_SPOOL_CLEANUP_BATCH_SIZE",
  "AGENT_BACKUP_SPOOL_MAX_BYTES",
  "AGENT_BACKUP_SPOOL_MIN_FREE_BYTES",
  "AGENT_BACKUP_SPOOL_STATE_DIRECTORY",
  "AGENT_BACKUP_STEWARD_KMS_BASE_URL",
  "AGENT_BACKUP_STEWARD_KMS_TOKEN",
  "AGENT_BACKUP_STORAGE_SCOPE",
  "DATABASE_SSL_NO_VERIFY",
  "DATABASE_URL",
  "SECRETS_MASTER_KEY",
]);

function canonicalInteger(params: {
  env: NodeJS.ProcessEnv;
  name: string;
  fallback: number;
  min: number;
  max: number;
}): number {
  const raw = params.env[params.name];
  if (raw === undefined || raw === "") return params.fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${params.name} must be a canonical positive integer`);
  }
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < params.min ||
    value > params.max
  ) {
    throw new Error(
      `${params.name} must be between ${params.min} and ${params.max}`,
    );
  }
  return value;
}

export function readBackupCatalogWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
): BackupCatalogWorkerConfig {
  const healthFile =
    env.AGENT_BACKUP_CATALOG_WORKER_HEALTH_FILE || DEFAULT_HEALTH_FILE;
  if (
    !path.isAbsolute(healthFile) ||
    path.parse(healthFile).root === healthFile ||
    healthFile !== healthFile.trim() ||
    healthFile.includes("\0")
  ) {
    throw new Error(
      "AGENT_BACKUP_CATALOG_WORKER_HEALTH_FILE must be a specific absolute path",
    );
  }
  return {
    runOnce: argv.includes("--once"),
    intervalMs: canonicalInteger({
      env,
      name: "AGENT_BACKUP_CATALOG_WORKER_INTERVAL_MS",
      fallback: DEFAULT_INTERVAL_MS,
      min: MIN_CYCLE_DELAY_MS,
      max: 60_000,
    }),
    retryMs: canonicalInteger({
      env,
      name: "AGENT_BACKUP_CATALOG_WORKER_RETRY_MS",
      fallback: DEFAULT_RETRY_MS,
      min: MIN_CYCLE_DELAY_MS,
      max: 60_000,
    }),
    shutdownTimeoutMs: canonicalInteger({
      env,
      name: "AGENT_BACKUP_CATALOG_WORKER_SHUTDOWN_TIMEOUT_MS",
      fallback: DEFAULT_SHUTDOWN_TIMEOUT_MS,
      min: MIN_SHUTDOWN_TIMEOUT_MS,
      max: MAX_SHUTDOWN_TIMEOUT_MS,
    }),
    healthFile,
  };
}

async function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Atomically publish one non-secret health snapshot for systemd/preflight. */
export async function writeBackupCatalogWorkerHealth(
  filePath: string,
  health: Readonly<BackupCatalogWorkerHealth>,
): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(health)}\n`, { mode: 0o600 });
    await rename(temporary, filePath);
  } catch (cause) {
    // error-policy:J6 attempt teardown of the unpublished temporary file, then
    // preserve the original health-publication failure below.
    try {
      await unlink(temporary);
    } catch {
      // error-policy:J6 cleanup cannot replace the health publication failure.
    }
    throw cause;
  }
}

function ownDataString(error: unknown, property: string): string | undefined {
  if (!error || (typeof error !== "object" && typeof error !== "function")) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, property);
    return descriptor &&
      "value" in descriptor &&
      typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    // error-policy:J1 hostile thrown values become absent metadata without
    // invoking getters or reflecting their messages at the daemon boundary.
    return undefined;
  }
}

function safeErrorCode(error: unknown): string {
  const code = ownDataString(error, "code");
  if (code && SAFE_BACKUP_CATALOG_ERROR_CODES.has(code)) return code;
  return "AGENT_BACKUP_CATALOG_CYCLE_FAILED";
}

/** Format the process-boundary failure without reflecting provider values/messages. */
export function formatBackupCatalogFatalMessage(error: unknown): string {
  return `[backup-catalog-worker] fatal: ${safeErrorCode(error)}\n`;
}

/** Extract only bounded configuration names; never return rejected values or provider messages. */
export function safeBackupCatalogConfigurationNames(
  error: unknown,
): readonly string[] {
  const message = ownDataString(error, "message");
  if (!message) return Object.freeze([]);
  const matches = message.match(/\b[A-Z][A-Z0-9_]{1,127}\b/g) ?? [];
  return Object.freeze(
    [...new Set(matches)]
      .filter((name) => SAFE_BACKUP_CATALOG_CONFIGURATION_NAMES.has(name))
      .sort()
      .slice(0, 64),
  );
}

function boundedHealthCounter(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, MAX_HEALTH_COUNTER)
    : 0;
}

function safeAlertCodes(codes: readonly string[]): readonly string[] {
  const safe = new Set<string>();
  let redacted = false;
  for (const code of codes) {
    if (SAFE_BACKUP_CATALOG_ALERT_CODES.has(code)) safe.add(code);
    else redacted = true;
  }
  if (redacted) safe.add("BACKUP_ALERT_REDACTED");
  return Object.freeze([...safe].sort());
}

function summaryMetrics(
  summary: Readonly<AgentBackupCatalogRuntimeSummary>,
): Readonly<BackupCatalogWorkerCycleMetrics> {
  return Object.freeze({
    scheduleEnrolled: boundedHealthCounter(summary.scheduleEnrolled),
    scheduleProtected: boundedHealthCounter(summary.scheduleProtected),
    scheduleRecycled: boundedHealthCounter(summary.scheduleRecycled),
    scheduleClaimed: boundedHealthCounter(summary.scheduleClaimed),
    scheduleReserved: boundedHealthCounter(summary.scheduleReserved),
    scheduleDeferred: boundedHealthCounter(summary.scheduleDeferred),
    scheduleIndeterminate: boundedHealthCounter(summary.scheduleIndeterminate),
    scheduleOverdue: boundedHealthCounter(summary.scheduleOverdue),
    operationClaimed: boundedHealthCounter(summary.operationClaimed),
    operationCaptured: boundedHealthCounter(summary.operationCaptured),
    operationCaptureRetryScheduled: boundedHealthCounter(
      summary.operationCaptureRetryScheduled,
    ),
    operationCaptureTerminal: boundedHealthCounter(
      summary.operationCaptureTerminal,
    ),
    operationProtected: boundedHealthCounter(summary.operationProtected),
    operationPublicationRetryScheduled: boundedHealthCounter(
      summary.operationPublicationRetryScheduled,
    ),
    operationDeferred: boundedHealthCounter(summary.operationDeferred),
    operationIndeterminate: boundedHealthCounter(
      summary.operationIndeterminate,
    ),
    spoolCleanupDiscovered: boundedHealthCounter(
      summary.spoolCleanup.discovered,
    ),
    spoolCleanupAuthorized: boundedHealthCounter(
      summary.spoolCleanup.authorized,
    ),
    spoolCleanupCompleted: boundedHealthCounter(summary.spoolCleanup.completed),
    spoolCleanupPending: boundedHealthCounter(summary.spoolCleanup.pending),
    spoolCleanupSkippedUnprotected: boundedHealthCounter(
      summary.spoolCleanup.skippedUnprotected,
    ),
    spoolCleanupIndeterminate: boundedHealthCounter(
      summary.spoolCleanup.indeterminate,
    ),
    deletionCandidates: boundedHealthCounter(summary.deletionCandidates),
    deletionEnqueued: boundedHealthCounter(summary.deletionEnqueued),
    deletionEnqueueIndeterminate: boundedHealthCounter(
      summary.deletionEnqueueIndeterminate,
    ),
    gcClaimed: boundedHealthCounter(summary.gcClaimed),
    gcCompleted: boundedHealthCounter(summary.gcCompleted),
    gcFailed: boundedHealthCounter(summary.gcFailed),
    gcIndeterminate: boundedHealthCounter(summary.gcIndeterminate),
    deletionFinalized: boundedHealthCounter(summary.deletionFinalized),
    deletionFinalizeIndeterminate: boundedHealthCounter(
      summary.deletionFinalizeIndeterminate,
    ),
  });
}

export function waitForShutdownBound<T>(params: {
  pending: Promise<T>;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<{ kind: "settled"; value: T } | { kind: "shutdown-timeout" }> {
  return new Promise((resolve, reject) => {
    let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
    const clearShutdownTimer = () => {
      if (shutdownTimer !== undefined) {
        clearTimeout(shutdownTimer);
        shutdownTimer = undefined;
      }
    };
    const onAbort = () => {
      if (shutdownTimer !== undefined) return;
      shutdownTimer = setTimeout(() => {
        shutdownTimer = undefined;
        params.signal.removeEventListener("abort", onAbort);
        resolve({ kind: "shutdown-timeout" });
      }, params.timeoutMs);
    };
    if (params.signal.aborted) onAbort();
    else params.signal.addEventListener("abort", onAbort, { once: true });
    params.pending.then(
      (value) => {
        clearShutdownTimer();
        params.signal.removeEventListener("abort", onAbort);
        resolve({ kind: "settled", value });
      },
      (error: unknown) => {
        clearShutdownTimer();
        params.signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

const EMPTY_ALERTS: readonly string[] = Object.freeze([]);

/** Run until cancellation or one deterministic `--once` cycle. */
export async function runBackupCatalogWorker(input: {
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
  signal: AbortSignal;
  dependencies: BackupCatalogWorkerDependencies;
}): Promise<BackupCatalogWorkerRunResult> {
  const env = input.env ?? process.env;
  const argv = input.argv ?? process.argv.slice(2);
  const startedAtMs = input.dependencies.now();
  let config: BackupCatalogWorkerConfig = {
    runOnce: argv.includes("--once"),
    intervalMs: DEFAULT_INTERVAL_MS,
    retryMs: DEFAULT_RETRY_MS,
    shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
    healthFile: DEFAULT_HEALTH_FILE,
  };
  let composition: AgentBackupCatalogWorkerComposition;
  let cycles = 0;
  let failures = 0;
  let lastCycleStartedAt: string | null = null;
  let lastCycleCompletedAt: string | null = null;
  let lastDurationMs: number | null = null;
  let lastAlertCodes = EMPTY_ALERTS;
  let lastCycleMetrics: Readonly<BackupCatalogWorkerCycleMetrics> | null = null;
  const health = async (
    state: BackupCatalogWorkerState,
    enabled: boolean,
  ): Promise<void> => {
    const now = input.dependencies.now();
    await input.dependencies.writeHealth(config.healthFile, {
      format: "elizaos.agent-backup.catalog-worker-health.v1",
      state,
      enabled,
      pid: process.pid,
      updatedAt: new Date(now).toISOString(),
      startedAt: new Date(startedAtMs).toISOString(),
      cycles,
      failures,
      lastCycleStartedAt,
      lastCycleCompletedAt,
      lastDurationMs,
      lastAlertCodes,
      lastCycleMetrics,
    });
  };

  const configurationFailure = async (
    error: unknown,
  ): Promise<BackupCatalogWorkerRunResult> => {
    failures = 1;
    input.dependencies.logger.error(
      "[backup-catalog-worker] configuration rejected",
      {
        code: "AGENT_BACKUP_CATALOG_CONFIGURATION_INVALID",
        configurationNames: safeBackupCatalogConfigurationNames(error),
      },
    );
    try {
      await health("terminal-configuration-failure", false);
    } catch {
      // error-policy:J1 health publication is best-effort at this terminal
      // boundary. Never reflect its failure or replace the permanent exit 78.
      input.dependencies.logger.error(
        "[backup-catalog-worker] configuration health publication failed",
        { code: "AGENT_BACKUP_CATALOG_HEALTH_WRITE_FAILED" },
      );
    }
    return {
      state: "terminal-configuration-failure",
      exitCode: CONFIG_ERROR_EXIT_CODE,
      cycles,
      failures,
    };
  };

  try {
    config = readBackupCatalogWorkerConfig(env, argv);
  } catch (error) {
    // error-policy:J1 translate the daemon configuration boundary to a
    // value-redacted terminal health state and bounded process exit code.
    return configurationFailure(error);
  }
  try {
    composition = await input.dependencies.createComposition({ env });
  } catch (error) {
    // error-policy:J1 construction may cross DB/provider adapters, but the
    // daemon boundary emits only configuration names and a stable code.
    return configurationFailure(error);
  }

  input.dependencies.logger.info("[backup-catalog-worker] started", {
    enabled: composition.enabled,
    runOnce: config.runOnce,
    intervalMs: config.intervalMs,
  });

  if (!composition.enabled) {
    await health("disabled", false);
    if (config.runOnce)
      return { state: "disabled", exitCode: 0, cycles, failures };
    while (!input.signal.aborted) {
      await input.dependencies.sleep(config.intervalMs, input.signal);
      if (!input.signal.aborted) await health("disabled", false);
    }
    await health("bounded-shutdown", false);
    return { state: "bounded-shutdown", exitCode: 0, cycles, failures };
  }

  await health("idle", true);
  while (!input.signal.aborted) {
    const cycleStartedMs = input.dependencies.now();
    lastCycleStartedAt = new Date(cycleStartedMs).toISOString();
    lastAlertCodes = EMPTY_ALERTS;
    lastCycleMetrics = null;
    await health("running", true);
    try {
      // Normalize a synchronous composition failure into the same retry path as
      // an asynchronous provider/database failure.
      const pending = Promise.resolve().then(() =>
        composition.runCycle(input.signal),
      );
      // Observe any late rejection after a bounded shutdown return.
      // error-policy:J5 the durable lease owns replay after the daemon has
      // already published its bounded-shutdown state.
      void pending.catch(() => undefined);
      const settled = await waitForShutdownBound({
        pending,
        signal: input.signal,
        timeoutMs: config.shutdownTimeoutMs,
      });
      if (settled.kind === "shutdown-timeout") {
        failures += 1;
        await health("bounded-shutdown", true);
        input.dependencies.logger.warn(
          "[backup-catalog-worker] shutdown deadline reached",
          {
            shutdownTimeoutMs: config.shutdownTimeoutMs,
          },
        );
        return { state: "bounded-shutdown", exitCode: 0, cycles, failures };
      }
      cycles += 1;
      const completedAtMs = input.dependencies.now();
      lastCycleCompletedAt = new Date(completedAtMs).toISOString();
      lastDurationMs = Math.max(0, completedAtMs - cycleStartedMs);
      lastAlertCodes = safeAlertCodes(settled.value.alertCodes);
      lastCycleMetrics = summaryMetrics(settled.value);
      const degraded = settled.value.alertCodes.length > 0;
      if (degraded) failures += 1;
      await health(
        input.signal.aborted
          ? "bounded-shutdown"
          : degraded
            ? "degraded"
            : "idle",
        true,
      );
      const metrics = {
        cycle: cycles,
        durationMs: lastDurationMs,
        failures,
        ...lastCycleMetrics,
        alertCodes: lastAlertCodes,
      };
      if (degraded) {
        input.dependencies.logger.warn(
          "[backup-catalog-worker] cycle degraded",
          metrics,
        );
      } else {
        input.dependencies.logger.info(
          "[backup-catalog-worker] cycle complete",
          metrics,
        );
      }
    } catch (error) {
      // error-policy:J1 the daemon loop boundary translates cycle failures to
      // an explicit retryable health state with closed, value-free diagnostics.
      if (input.signal.aborted) {
        await health("bounded-shutdown", true);
        return { state: "bounded-shutdown", exitCode: 0, cycles, failures };
      }
      failures += 1;
      lastDurationMs = Math.max(0, input.dependencies.now() - cycleStartedMs);
      lastAlertCodes = Object.freeze([safeErrorCode(error)]);
      await health("retryable-failure", true);
      input.dependencies.logger.warn(
        "[backup-catalog-worker] cycle will retry",
        {
          code: safeErrorCode(error),
          failures,
        },
      );
      if (config.runOnce) {
        return { state: "retryable-failure", exitCode: 1, cycles, failures };
      }
      await input.dependencies.sleep(config.retryMs, input.signal);
      continue;
    }
    if (config.runOnce) {
      const degraded = lastAlertCodes.length > 0;
      return {
        state: degraded ? "degraded" : "idle",
        exitCode: degraded ? 1 : 0,
        cycles,
        failures,
      };
    }
    const elapsed = Math.max(0, input.dependencies.now() - cycleStartedMs);
    await input.dependencies.sleep(
      lastAlertCodes.length > 0
        ? config.retryMs
        : Math.max(0, config.intervalMs - elapsed),
      input.signal,
    );
  }
  await health("bounded-shutdown", true);
  return { state: "bounded-shutdown", exitCode: 0, cycles, failures };
}

async function main(): Promise<number> {
  // Unlike the general provisioning daemons, this process must never ingest
  // cloud/.env.local. systemd supplies a dedicated allowlisted EnvironmentFile;
  // loading the shared file here would place unrelated credentials in the
  // disabled worker's /proc environment before the feature gate is inspected.
  const controller = new AbortController();
  const stop = (signal: string) => {
    if (!controller.signal.aborted)
      controller.abort(new Error(`Received ${signal}`));
  };
  const onSigint = () => stop("SIGINT");
  const onSigterm = () => stop("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    const { logger } = await import("@elizaos/cloud-shared/lib/utils/logger");
    const result = await runBackupCatalogWorker({
      signal: controller.signal,
      dependencies: {
        createComposition: createAgentBackupCatalogWorkerComposition,
        writeHealth: writeBackupCatalogWorkerHealth,
        sleep: sleepAbortable,
        now: Date.now,
        logger,
      },
    });
    return result.exitCode;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry ? path.resolve(entry) === fileURLToPath(import.meta.url) : false;
}

if (isMainModule()) {
  main().then(
    (exitCode) => {
      // The enabled dependency graph may retain provider/database handles even
      // after a bounded cycle or shutdown. The daemon has already flushed its
      // health state, so terminate explicitly and let systemd own restarts.
      process.exit(exitCode);
    },
    (error) => {
      // error-policy:J1 this is the final process boundary; arbitrary error
      // messages may contain credentials and must never reach journald.
      process.stderr.write(formatBackupCatalogFatalMessage(error));
      process.exit(1);
    },
  );
}
