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
import type {
  HeartbeatResult,
  ProcessingResult,
} from "@elizaos/cloud-shared/lib/services/provisioning-jobs";
import { loadLocalEnv } from "./shared/load-env";

type WorkerLogger =
  typeof import("@elizaos/cloud-shared/lib/utils/logger").logger;
type WorkerService =
  typeof import("@elizaos/cloud-shared/lib/services/provisioning-jobs").provisioningJobService;
type WorkerNodeManager =
  typeof import("@elizaos/cloud-shared/lib/services/docker-node-manager").dockerNodeManager;

interface WorkerDeps {
  logger: WorkerLogger;
  provisioningJobService: WorkerService;
  dockerNodeManager: WorkerNodeManager;
}

export interface ProvisioningWorkerConfig {
  pollIntervalMs: number;
  batchSize: number;
  runOnce: boolean;
  nodeHealthIntervalMs: number;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 3;

/**
 * Node health-check cadence. The same daemon now owns this responsibility
 * (previously container-control-plane forwarded from a CF Worker cron, which
 * left the orchestrator host blind to its own nodes when the control-plane
 * was offline or missed its SSH key). 5 minutes mirrors the legacy CRON_FANOUT
 * schedule for `agent-hot-pool`. SSH for the check itself uses the
 * `CONTAINERS_SSH_KEY` env var that already powers provision/stop on this host.
 */
const DEFAULT_NODE_HEALTH_INTERVAL_MS = 5 * 60_000;

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
    pollIntervalMs: parsePositiveInt(
      env.WORKER_POLL_INTERVAL,
      DEFAULT_POLL_INTERVAL_MS,
    ),
    batchSize: parsePositiveInt(env.WORKER_BATCH_SIZE, DEFAULT_BATCH_SIZE),
    runOnce: env.WORKER_RUN_ONCE === "1" || hasFlag(argv, "--once"),
    nodeHealthIntervalMs: parsePositiveInt(
      env.WORKER_NODE_HEALTH_INTERVAL,
      DEFAULT_NODE_HEALTH_INTERVAL_MS,
    ),
  };
}

let depsPromise: Promise<WorkerDeps> | null = null;

async function loadDeps(): Promise<WorkerDeps> {
  if (!depsPromise) {
    depsPromise = Promise.all([
      import("@elizaos/cloud-shared/lib/services/provisioning-jobs"),
      import("@elizaos/cloud-shared/lib/utils/logger"),
      import("@elizaos/cloud-shared/lib/services/docker-node-manager"),
    ]).then(([jobsModule, loggerModule, nodeMgrModule]) => ({
      provisioningJobService: jobsModule.provisioningJobService,
      logger: loggerModule.logger,
      dockerNodeManager: nodeMgrModule.dockerNodeManager,
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

export async function processHeartbeatCycle(
  concurrency = 5,
): Promise<HeartbeatResult> {
  const { provisioningJobService } = await loadDeps();
  return provisioningJobService.processRunningHeartbeats(concurrency);
}

export interface NodeHealthSummary {
  total: number;
  healthy: number;
  unhealthy: number;
}

/**
 * Health-checks every enabled `docker_nodes` row (SSH + `docker info`) and
 * persists the resulting status. Previously owned by the CF-cron-forwarded
 * container-control-plane service; folded into this daemon so the orchestrator
 * host that already has SSH access keeps the truth, instead of relying on a
 * second moving piece that can be missing its key (verified in prod
 * 2026-05-17: cores were stuck `offline` because the control-plane host
 * lacked CONTAINERS_SSH_KEY, despite the keys being valid here).
 */
export async function processNodeHealthCheckCycle(): Promise<NodeHealthSummary> {
  const { dockerNodeManager } = await loadDeps();
  const result = await dockerNodeManager.healthCheckAll();
  let healthy = 0;
  let unhealthy = 0;
  for (const status of result.values()) {
    if (status === "healthy") {
      healthy += 1;
    } else {
      unhealthy += 1;
    }
  }
  return { total: result.size, healthy, unhealthy };
}

let running = true;
let lastNodeHealthCheckAt = 0;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollCycle(
  logger: WorkerLogger,
  config: ProvisioningWorkerConfig,
): Promise<void> {
  try {
    const result = await processProvisioningWorkerCycle(config.batchSize);
    if (result.claimed > 0 || result.failed > 0) {
      logger.info(
        "[provisioning-worker] cycle complete",
        resultContext(result),
      );
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

  // Node health checks ride on a longer interval than the heartbeat cycle:
  // SSH + `docker info` per node is expensive (~MAX_RETRIES * 10s timeout
  // worst-case per offline node) and the data only feeds capacity decisions
  // that don't need sub-minute freshness. Skip when not yet due.
  const now = Date.now();
  if (now - lastNodeHealthCheckAt >= config.nodeHealthIntervalMs) {
    lastNodeHealthCheckAt = now;
    try {
      const summary = await processNodeHealthCheckCycle();
      logger.info("[provisioning-worker] node health check cycle complete", {
        total: summary.total,
        healthy: summary.healthy,
        unhealthy: summary.unhealthy,
      });
    } catch (error) {
      logger.error("[provisioning-worker] node health check cycle failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
    nodeHealthIntervalMs: config.nodeHealthIntervalMs,
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
