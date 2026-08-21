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
import { loadLocalEnv } from "./shared/load-env";

export type BackupCatalogWorkerState =
  | "disabled"
  | "idle"
  | "running"
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
      min: 1,
      max: 60_000,
    }),
    retryMs: canonicalInteger({
      env,
      name: "AGENT_BACKUP_CATALOG_WORKER_RETRY_MS",
      fallback: DEFAULT_RETRY_MS,
      min: 1,
      max: 60_000,
    }),
    shutdownTimeoutMs: canonicalInteger({
      env,
      name: "AGENT_BACKUP_CATALOG_WORKER_SHUTDOWN_TIMEOUT_MS",
      fallback: DEFAULT_SHUTDOWN_TIMEOUT_MS,
      min: 1,
      max: 60_000,
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
    try {
      await unlink(temporary);
    } catch {
      // error-policy:J6 cleanup cannot replace the health publication failure.
    }
    throw cause;
  }
}

function safeErrorCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof Reflect.get(error, "code") === "string" &&
    /^[A-Z][A-Z0-9_]{0,95}$/.test(Reflect.get(error, "code") as string)
  ) {
    return Reflect.get(error, "code") as string;
  }
  return "AGENT_BACKUP_CATALOG_CYCLE_FAILED";
}

/** Extract only bounded configuration names; never return rejected values or provider messages. */
export function safeBackupCatalogConfigurationNames(
  error: unknown,
): readonly string[] {
  if (!(error instanceof Error)) return Object.freeze([]);
  const matches = error.message.match(
    /\b(?:AGENT_BACKUP_[A-Z0-9_]+|DATABASE_URL|SECRETS_MASTER_KEY)\b/g,
  );
  return Object.freeze([...new Set(matches ?? [])].sort().slice(0, 32));
}

function summaryMetrics(summary: Readonly<AgentBackupCatalogRuntimeSummary>) {
  return {
    scheduleClaimed: summary.scheduleClaimed,
    scheduleReserved: summary.scheduleReserved,
    scheduleOverdue: summary.scheduleOverdue,
    operationClaimed: summary.operationClaimed,
    operationCaptured: summary.operationCaptured,
    operationProtected: summary.operationProtected,
    operationRetryScheduled:
      summary.operationCaptureRetryScheduled +
      summary.operationPublicationRetryScheduled,
    gcClaimed: summary.gcClaimed,
    gcCompleted: summary.gcCompleted,
    spoolCleanupPending: summary.spoolCleanup.pending,
    alertCodes: summary.alertCodes,
  };
}

function waitForShutdownBound<T>(params: {
  pending: Promise<T>;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<{ kind: "settled"; value: T } | { kind: "shutdown-timeout" }> {
  if (!params.signal.aborted) {
    return new Promise((resolve, reject) => {
      let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        shutdownTimer = setTimeout(
          () => resolve({ kind: "shutdown-timeout" }),
          params.timeoutMs,
        );
      };
      params.signal.addEventListener("abort", onAbort, { once: true });
      params.pending.then(
        (value) => {
          if (shutdownTimer) clearTimeout(shutdownTimer);
          params.signal.removeEventListener("abort", onAbort);
          resolve({ kind: "settled", value });
        },
        (error: unknown) => {
          if (shutdownTimer) clearTimeout(shutdownTimer);
          params.signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }
  return Promise.race([
    params.pending.then((value) => ({ kind: "settled" as const, value })),
    new Promise<{ kind: "shutdown-timeout" }>((resolve) =>
      setTimeout(() => resolve({ kind: "shutdown-timeout" }), params.timeoutMs),
    ),
  ]);
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
    });
  };

  const configurationFailure = async (
    error: unknown,
  ): Promise<BackupCatalogWorkerRunResult> => {
    failures = 1;
    await health("terminal-configuration-failure", false);
    input.dependencies.logger.error(
      "[backup-catalog-worker] configuration rejected",
      {
        code: "AGENT_BACKUP_CATALOG_CONFIGURATION_INVALID",
        configurationNames: safeBackupCatalogConfigurationNames(error),
      },
    );
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
    return configurationFailure(error);
  }
  try {
    composition = await input.dependencies.createComposition({ env });
  } catch (error) {
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
    await health("running", true);
    try {
      // Normalize a synchronous composition failure into the same retry path as
      // an asynchronous provider/database failure.
      const pending = Promise.resolve().then(() =>
        composition.runCycle(input.signal),
      );
      // Observe any late rejection after a bounded shutdown return.
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
      lastAlertCodes = Object.freeze([...settled.value.alertCodes]);
      await health(input.signal.aborted ? "bounded-shutdown" : "idle", true);
      input.dependencies.logger.info("[backup-catalog-worker] cycle complete", {
        cycle: cycles,
        durationMs: lastDurationMs,
        ...summaryMetrics(settled.value),
      });
    } catch (error) {
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
    if (config.runOnce) return { state: "idle", exitCode: 0, cycles, failures };
    const elapsed = Math.max(0, input.dependencies.now() - cycleStartedMs);
    await input.dependencies.sleep(
      Math.max(0, config.intervalMs - elapsed),
      input.signal,
    );
  }
  await health("bounded-shutdown", true);
  return { state: "bounded-shutdown", exitCode: 0, cycles, failures };
}

async function main(): Promise<number> {
  loadLocalEnv(import.meta.url);
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
      process.stderr.write(
        `[backup-catalog-worker] fatal: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    },
  );
}
