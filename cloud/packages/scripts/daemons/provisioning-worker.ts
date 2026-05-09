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
 *   npx tsx packages/scripts/daemons/provisioning-worker.ts
 *   npx tsx packages/scripts/daemons/provisioning-worker.ts --once
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { HeartbeatResult, ProcessingResult } from "../../lib/services/provisioning-jobs";
import { loadLocalEnv } from "./shared/load-env";

type WorkerLogger = typeof import("../../lib/utils/logger").logger;
type WorkerService = typeof import("../../lib/services/provisioning-jobs").provisioningJobService;

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
      import("../../lib/services/provisioning-jobs"),
      import("../../lib/utils/logger"),
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
  loadLocalEnv(import.meta.url);

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
