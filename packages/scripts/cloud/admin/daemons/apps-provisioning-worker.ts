#!/usr/bin/env -S npx tsx
/**
 * Apps-control provisioning worker (Eliza Cloud Apps / Product 2).
 *
 * A PURPOSE-BUILT, deliberately slim sibling of `provisioning-worker.ts`. It
 * claims ONLY the apps lane (`APPS_JOB_TYPES`: CONTAINER_* + APP_DEPLOY +
 * APP_DB_DEPROVISION) and arms ONLY the apps deploy backend. It runs NONE of the
 * agent-fleet singletons the main worker owns — no liveness heartbeat, no fleet
 * image-upgrade, no node autoscale, no warm-pool drain — so a second copy of
 * THIS daemon can never race, duplicate, or disrupt the live agent control
 * plane. The two daemons coexist on the shared `jobs` table purely via
 * lane-scoped, `FOR UPDATE SKIP LOCKED` claiming.
 *
 * WHY A SEPARATE DAEMON / HOST: provisioning a per-tenant DB runs `pg` DDL
 * (CREATE ROLE/DATABASE) against the PRIVATE tenant Postgres, which is only
 * reachable on the apps private network — somewhere the agent control-plane node
 * (a different Hetzner project) is not. So this daemon is meant to run on a
 * TRUSTED node that sits ON the apps private net (reaches the tenant DB
 * privately) but runs NO untrusted user containers (those live on the separate
 * app node) — keeping the cluster ADMIN DSN off any box that runs user code.
 *
 * Deploy target is therefore the apps-control node (NOT the agent control plane,
 * NOT the untrusted app node). Pin the main worker to `PROVISIONING_JOB_LANES=agent`
 * once this is live so it stops claiming-and-failing apps jobs it can't run.
 *
 * Usage:
 *   npx tsx packages/scripts/cloud/admin/daemons/apps-provisioning-worker.ts
 *   npx tsx packages/scripts/cloud/admin/daemons/apps-provisioning-worker.ts --once
 *
 * Required env (in /opt/eliza/cloud/.env.local, same shape arm-apps-daemon writes):
 *   APPS_DEPLOY_ENABLED=1            arm gate (without it this daemon idles)
 *   DATABASE_URL=...                 the cloud Postgres (Neon) — the jobs queue
 *   APPS_TENANT_ADMIN_DSN=...        admin DSN of the tenant DB cluster (private IP)
 *   CONTAINERS_DOCKER_NODES=...      the app node(s) the deploy runner SSHes to
 *   CONTAINERS_SSH_USER, APPS_CADDY_ADMIN_URL, CONTAINERS_PUBLIC_BASE_DOMAIN, ...
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { APPS_JOB_TYPES } from "@elizaos/cloud-shared/lib/services/provisioning-job-types";
import type { ProcessingResult } from "@elizaos/cloud-shared/lib/services/provisioning-jobs";
import { loadLocalEnv } from "./shared/load-env";

type WorkerLogger =
  typeof import("@elizaos/cloud-shared/lib/utils/logger").logger;
type WorkerService =
  typeof import("@elizaos/cloud-shared/lib/services/provisioning-jobs").provisioningJobService;

interface AppsWorkerDeps {
  logger: WorkerLogger;
  provisioningJobService: WorkerService;
}

export interface AppsWorkerConfig {
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

export function readAppsWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
): AppsWorkerConfig {
  return {
    pollIntervalMs: parsePositiveInt(
      env.WORKER_POLL_INTERVAL,
      DEFAULT_POLL_INTERVAL_MS,
    ),
    batchSize: parsePositiveInt(env.WORKER_BATCH_SIZE, DEFAULT_BATCH_SIZE),
    runOnce: env.WORKER_RUN_ONCE === "1" || hasFlag(argv, "--once"),
  };
}

let depsPromise: Promise<AppsWorkerDeps> | null = null;

async function loadDeps(): Promise<AppsWorkerDeps> {
  if (!depsPromise) {
    depsPromise = Promise.all([
      import("@elizaos/cloud-shared/lib/services/provisioning-jobs"),
      import("@elizaos/cloud-shared/lib/utils/logger"),
    ]).then(([jobsModule, loggerModule]) => ({
      provisioningJobService: jobsModule.provisioningJobService,
      logger: loggerModule.logger,
    }));
  }
  return depsPromise;
}

/**
 * Arm the node deploy backend (per-tenant DB provisioning + container executor +
 * build-from-repo resolver). Mirrors `armAppsDeployBackendIfEnabled` in the main
 * worker. Gated on `APPS_DEPLOY_ENABLED=1`: returns false when unset so a
 * deployed-but-not-armed daemon idles instead of half-running.
 */
export async function armAppsDeployBackend(
  logger: WorkerLogger,
): Promise<boolean> {
  if (process.env.APPS_DEPLOY_ENABLED !== "1") {
    logger.warn(
      "[apps-worker] APPS_DEPLOY_ENABLED is not '1' — deploy backend NOT armed; " +
        "daemon will idle (claims no jobs). Set APPS_DEPLOY_ENABLED=1 to arm.",
    );
    return false;
  }
  const { configureAppsDeployBackend } = await import(
    "@elizaos/cloud-shared/lib/services/apps-deploy-backend"
  );
  const port = process.env.APPS_DEPLOY_PORT
    ? Number(process.env.APPS_DEPLOY_PORT)
    : undefined;
  // APPS_IMAGE_REGISTRY set → BUILD-FROM-REPO (buildx on the app node, push to
  // this registry). Unset → prebuilt images (imageTag / APP_DEFAULT_IMAGE).
  const registry = process.env.APPS_IMAGE_REGISTRY;
  configureAppsDeployBackend({ port, registry });
  logger.info("[apps-worker] apps deploy backend armed", {
    tenantDbAdminDsn: process.env.APPS_TENANT_ADMIN_DSN
      ? "env-sourced"
      : "encrypted",
    images: registry
      ? "build-from-repo"
      : "prebuilt (imageTag/APP_DEFAULT_IMAGE)",
    registry: registry ?? null,
    port: port ?? 3000,
    dockerNodes: process.env.CONTAINERS_DOCKER_NODES ?? "(unset)",
  });
  return true;
}

function resultContext(result: ProcessingResult): Record<string, unknown> {
  return {
    claimed: result.claimed,
    succeeded: result.succeeded,
    failed: result.failed,
    errors: result.errors,
  };
}

let running = true;
let armed = false;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One work cycle: claim + process the apps lane only. No heartbeat, no infra
 * maintenance — those are the agent control plane's job, not ours.
 */
async function pollCycle(
  logger: WorkerLogger,
  config: AppsWorkerConfig,
): Promise<void> {
  if (!armed) return; // not armed → nothing to claim; stay a quiet no-op.
  try {
    const { provisioningJobService } = await loadDeps();
    const result = await provisioningJobService.processPendingJobs(
      config.batchSize,
      { jobTypes: APPS_JOB_TYPES },
    );
    if (result.claimed > 0 || result.failed > 0) {
      logger.info("[apps-worker] cycle complete", resultContext(result));
    }
  } catch (error) {
    logger.error("[apps-worker] cycle failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function main(): Promise<void> {
  loadLocalEnv(import.meta.url);

  const config = readAppsWorkerConfig();
  const { logger } = await loadDeps();

  logger.info("[apps-worker] starting", {
    pollIntervalMs: config.pollIntervalMs,
    batchSize: config.batchSize,
    runOnce: config.runOnce,
    lane: "apps",
    jobTypes: APPS_JOB_TYPES,
  });

  armed = await armAppsDeployBackend(logger);

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

  logger.info("[apps-worker] stopped");
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
  const reasonStr = reason instanceof Error ? reason.message : String(reason);
  // Fall back to stderr if the logger import itself rejects (e.g. a rejection
  // around startup before deps are loaded) so the original reason is never
  // silently swallowed.
  void loadDeps()
    .then(({ logger }) => {
      logger.error("[apps-worker] unhandled rejection", { error: reasonStr });
    })
    .catch(() => {
      process.stderr.write(`[apps-worker] unhandled rejection: ${reasonStr}\n`);
    });
});

if (isMainModule()) {
  main().catch((error) => {
    process.stderr.write(
      `[apps-worker] fatal: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
