#!/usr/bin/env -S npx tsx
/**
 * Standalone provisioning worker.
 *
 * The Cloudflare cron route is a Worker-runtime stub because provisioning pulls
 * in Node-only SSH/Docker modules. This daemon runs on the Node sidecar and
 * delegates to the same ProvisioningJobService used by the API, so enqueue,
 * claim, retry, sandbox status, webhooks, and health checks share one codepath.
 *
 * Usage:
 *   npx tsx packages/scripts/provisioning-worker.ts
 *   npx tsx packages/scripts/provisioning-worker.ts --once
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { HeartbeatResult, ProcessingResult } from "../lib/services/provisioning-jobs";

type WorkerLogger = typeof import("../lib/utils/logger").logger;
type WorkerService = typeof import("../lib/services/provisioning-jobs").provisioningJobService;

interface WorkerDeps {
  logger: WorkerLogger;
  provisioningJobService: WorkerService;
}

export interface ProvisioningWorkerConfig {
  pollIntervalMs: number;
  batchSize: number;
  runOnce: boolean;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 3;

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;

    const key = trimmed.slice(0, eqIdx);
    let value = trimmed.slice(eqIdx + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function loadLocalEnv(): void {
  const scriptPath = fileURLToPath(import.meta.url);
  const projectRoot = path.resolve(path.dirname(scriptPath), "../..");
  loadEnvFile(path.join(projectRoot, ".env.local"));
  loadEnvFile(path.join(projectRoot, ".env"));
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}

export function readWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
): ProvisioningWorkerConfig {
  return {
    pollIntervalMs: parsePositiveInt(env.WORKER_POLL_INTERVAL, DEFAULT_POLL_INTERVAL_MS),
    batchSize: parsePositiveInt(env.WORKER_BATCH_SIZE, DEFAULT_BATCH_SIZE),
    runOnce: env.WORKER_RUN_ONCE === "1" || hasFlag(argv, "--once"),
  };
}

let depsPromise: Promise<WorkerDeps> | null = null;

async function loadDeps(): Promise<WorkerDeps> {
  if (!depsPromise) {
    depsPromise = Promise.all([
      import("../lib/services/provisioning-jobs"),
      import("../lib/utils/logger"),
    ]).then(([jobsModule, loggerModule]) => ({
      provisioningJobService: jobsModule.provisioningJobService,
      logger: loggerModule.logger,
    }));
  }
  return depsPromise;
}

function resultContext(result: ProcessingResult): Record<string, unknown> {
  return {
    claimed: result.claimed,
    succeeded: result.succeeded,
    failed: result.failed,
    errors: result.errors,
  };
}

export async function processProvisioningWorkerCycle(
  batchSize = readWorkerConfig().batchSize,
): Promise<ProcessingResult> {
  const { provisioningJobService } = await loadDeps();
  return provisioningJobService.processPendingJobs(batchSize);
}

export async function processHeartbeatCycle(concurrency = 5): Promise<HeartbeatResult> {
  const { provisioningJobService } = await loadDeps();
  return provisioningJobService.processRunningHeartbeats(concurrency);
}

let running = true;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollCycle(logger: WorkerLogger, config: ProvisioningWorkerConfig): Promise<void> {
  try {
    const result = await processProvisioningWorkerCycle(config.batchSize);
    if (result.claimed > 0 || result.failed > 0) {
      logger.info("[provisioning-worker] cycle complete", resultContext(result));
    }
  } catch (error) {
    logger.error("[provisioning-worker] cycle failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const heartbeats = await processHeartbeatCycle();
    if (heartbeats.total > 0) {
      logger.info("[provisioning-worker] heartbeat cycle complete", {
        total: heartbeats.total,
        succeeded: heartbeats.succeeded,
        failed: heartbeats.failed,
      });
    }
  } catch (error) {
    logger.error("[provisioning-worker] heartbeat cycle failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function main(): Promise<void> {
  loadLocalEnv();

  const config = readWorkerConfig();
  const { logger } = await loadDeps();

  logger.info("[provisioning-worker] starting", {
    pollIntervalMs: config.pollIntervalMs,
    batchSize: config.batchSize,
    runOnce: config.runOnce,
  });

  if (config.runOnce) {
    await pollCycle(logger, config);
    return;
  }

  while (running) {
    await pollCycle(logger, config);
    if (running) {
      await sleep(config.pollIntervalMs);
    }
  }

  logger.info("[provisioning-worker] stopped");
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry ? path.resolve(entry) === fileURLToPath(import.meta.url) : false;
}

process.on("SIGINT", () => {
  running = false;
});

process.on("SIGTERM", () => {
  running = false;
});

process.on("unhandledRejection", (reason) => {
  void loadDeps().then(({ logger }) => {
    logger.error("[provisioning-worker] unhandled rejection", {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  });
});

if (isMainModule()) {
  main().catch((error) => {
    process.stderr.write(
      `[provisioning-worker] fatal: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
