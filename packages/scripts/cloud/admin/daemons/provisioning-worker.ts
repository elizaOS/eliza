#!/usr/bin/env -S npx tsx
/**
 * Standalone provisioning worker.
 *
 * The Cloudflare cron route only triggers the Node sidecar because provisioning
 * pulls in Node-only SSH/Docker modules. This daemon runs on that sidecar and
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
type WorkerNodeAutoscaler =
  typeof import("@elizaos/cloud-shared/lib/services/containers/node-autoscaler").getNodeAutoscaler;
type WorkerWarmPoolManager =
  typeof import("@elizaos/cloud-shared/lib/services/containers/warm-pool-manager").WarmPoolManager;
type WorkerContainersEnv =
  typeof import("@elizaos/cloud-shared/lib/config/containers-env").containersEnv;
type WorkerWarmPoolCreator =
  typeof import("@elizaos/cloud-shared/lib/services/containers/agent-warm-pool-creator").getHetznerPoolContainerCreator;
type WorkerResolveImageDigest =
  typeof import("@elizaos/cloud-shared/lib/services/containers/registry-probe").resolveImageDigest;
type WorkerAgentSandboxesRepository =
  typeof import("@elizaos/cloud-shared/db/repositories/agent-sandboxes").agentSandboxesRepository;
type WorkerJobsRepository =
  typeof import("@elizaos/cloud-shared/db/repositories/jobs").jobsRepository;

interface PreflightKmsClient {
  getOrCreateKey(keyId: string): Promise<unknown>;
}

type PreflightCreateKmsClient = (opts: {
  env: NodeJS.ProcessEnv;
}) => PreflightKmsClient;

interface WorkerDeps {
  logger: WorkerLogger;
  provisioningJobService: WorkerService;
  dockerNodeManager: WorkerNodeManager;
  getNodeAutoscaler: WorkerNodeAutoscaler;
  WarmPoolManager: WorkerWarmPoolManager;
  getHetznerPoolContainerCreator: WorkerWarmPoolCreator;
  containersEnv: WorkerContainersEnv;
  resolveImageDigest: WorkerResolveImageDigest;
  agentSandboxesRepository: WorkerAgentSandboxesRepository;
  jobsRepository: WorkerJobsRepository;
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
 * Node health-check cadence. 5 minutes matches the `agent-hot-pool`
 * CRON_FANOUT schedule. SSH uses `CONTAINERS_SSH_KEY` from this host.
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
      import("@elizaos/cloud-shared/lib/services/containers/node-autoscaler"),
      import("@elizaos/cloud-shared/lib/services/containers/agent-warm-pool"),
      import(
        "@elizaos/cloud-shared/lib/services/containers/agent-warm-pool-creator"
      ),
      import("@elizaos/cloud-shared/lib/config/containers-env"),
      import("@elizaos/cloud-shared/lib/services/containers/registry-probe"),
      import("@elizaos/cloud-shared/db/repositories/agent-sandboxes"),
      import("@elizaos/cloud-shared/db/repositories/jobs"),
    ]).then(
      ([
        jobsModule,
        loggerModule,
        nodeMgrModule,
        autoscalerModule,
        warmPoolModule,
        warmPoolCreatorModule,
        containersEnvModule,
        registryProbeModule,
        agentSandboxesModule,
        jobsRepoModule,
      ]) => ({
        provisioningJobService: jobsModule.provisioningJobService,
        logger: loggerModule.logger,
        dockerNodeManager: nodeMgrModule.dockerNodeManager,
        getNodeAutoscaler: autoscalerModule.getNodeAutoscaler,
        WarmPoolManager: warmPoolModule.WarmPoolManager,
        getHetznerPoolContainerCreator:
          warmPoolCreatorModule.getHetznerPoolContainerCreator,
        containersEnv: containersEnvModule.containersEnv,
        resolveImageDigest: registryProbeModule.resolveImageDigest,
        agentSandboxesRepository: agentSandboxesModule.agentSandboxesRepository,
        jobsRepository: jobsRepoModule.jobsRepository,
      }),
    );
  }
  return depsPromise;
}

let cachedWarmPoolManagerInstance: InstanceType<WorkerWarmPoolManager> | null =
  null;
async function getWarmPoolManager(): Promise<
  InstanceType<WorkerWarmPoolManager>
> {
  if (cachedWarmPoolManagerInstance) return cachedWarmPoolManagerInstance;
  const { WarmPoolManager, getHetznerPoolContainerCreator } = await loadDeps();
  cachedWarmPoolManagerInstance = new WarmPoolManager(
    getHetznerPoolContainerCreator(),
  );
  return cachedWarmPoolManagerInstance;
}

function resultContext(result: ProcessingResult): Record<string, unknown> {
  return {
    claimed: result.claimed,
    succeeded: result.succeeded,
    failed: result.failed,
    errors: result.errors,
  };
}

export async function assertProvisioningWorkerPreflight(
  opts: {
    env?: NodeJS.ProcessEnv;
    createKmsClient?: PreflightCreateKmsClient;
  } = {},
): Promise<void> {
  const env = opts.env ?? process.env;
  const createKmsClient =
    opts.createKmsClient ??
    (await import("@elizaos/security/kms")).createKmsClient;

  try {
    const kms = createKmsClient({ env });
    // Use the systemKey() helper so the key id matches the KEY_RE regex in
    // packages/security/src/kms/key-namespace.ts (`/v<digit>` suffix required).
    // Bare strings like "system:..." now throw `malformed key id` since the
    // strict namespace regex landed in 0330ba3d64.
    const { systemKey } = await import("@elizaos/security/kms");
    await kms.getOrCreateKey(systemKey("provisioning-worker-preflight"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      "Provisioning worker preflight failed: KMS is not usable. " +
        "Refusing to publish a healthy heartbeat or claim provisioning jobs. " +
        "Configure ELIZA_KMS_BACKEND=local with a persistent ELIZA_LOCAL_ROOT_KEY, " +
        "or wire a working Steward KMS client. " +
        `Cause: ${message}`,
    );
  }
}

async function processProvisioningWorkerCycle(
  batchSize = readWorkerConfig().batchSize,
): Promise<ProcessingResult> {
  const { provisioningJobService } = await loadDeps();
  return provisioningJobService.processPendingJobs(batchSize);
}

async function processHeartbeatCycle(
  concurrency = 5,
): Promise<HeartbeatResult> {
  const { provisioningJobService } = await loadDeps();
  return provisioningJobService.processRunningHeartbeats(concurrency);
}

interface NodeHealthSummary {
  total: number;
  healthy: number;
  unhealthy: number;
}

interface PrePullImagesSummary {
  attempted: number;
  failed: number;
}

interface NodeAutoscaleSummary {
  action:
    | "noop"
    | "scale_up"
    | "scale_down"
    | "scale_up_skipped"
    | "scale_up_failed"
    | "drain_failed";
  detail?: string;
}

interface PoolDrainSummary {
  drained: number;
}

/**
 * Health-checks every enabled `docker_nodes` row (SSH + `docker info`) and
 * persists the resulting status. Runs on the orchestrator host that already
 * holds `CONTAINERS_SSH_KEY`, so the node-status truth lives next to the
 * provisioner that acts on it.
 */
async function processNodeHealthCheckCycle(): Promise<NodeHealthSummary> {
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

/**
 * Reconcile the `allocated_count` column on each `docker_nodes` row against
 * the real number of provisioned sandboxes referencing the node. Previously
 * fired by `agent-hot-pool` cron forwarded to the mystery control-plane
 * host; folded here so the orchestrator owns the truth.
 */
async function processSyncAllocatedCountsCycle(): Promise<number> {
  const { dockerNodeManager } = await loadDeps();
  const changes = await dockerNodeManager.syncAllocatedCounts();
  return changes.size;
}

/**
 * Pre-pull the current agent image on every healthy node with spare
 * capacity. Keeps the warm pool / cold-start path fast. Gated by
 * `ELIZA_AGENT_HOT_POOL_PREPULL` (default on).
 */
async function processPrePullImagesCycle(): Promise<PrePullImagesSummary | null> {
  if (process.env.ELIZA_AGENT_HOT_POOL_PREPULL === "false") return null;
  const { dockerNodeManager, containersEnv } = await loadDeps();
  const image = containersEnv.defaultAgentImage();
  const result =
    await dockerNodeManager.prePullAgentImageOnAvailableNodes(image);
  const failed = result.filter((n) => n.status === "failed").length;
  return { attempted: result.length, failed };
}

/**
 * Evaluate capacity and scale Hetzner-cloud autoscaled nodes up or down.
 * Was forwarded to control-plane via `node-autoscale` cron; folded here.
 *
 * Requires `HCLOUD_TOKEN` + `CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY` on the
 * daemon host for scale-up to succeed. Without those, the cycle still
 * runs (decision + drain) but reports `scale_up_skipped`.
 */
async function processNodeAutoscaleCycle(): Promise<NodeAutoscaleSummary> {
  const { getNodeAutoscaler } = await loadDeps();
  const autoscaler = getNodeAutoscaler();
  const decision = await autoscaler.evaluateCapacity();

  if (!decision.shouldScaleUp && decision.shouldScaleDownNodeIds.length === 0) {
    return { action: "noop" };
  }

  if (decision.shouldScaleUp) {
    const publicKey = process.env.CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY?.trim();
    if (!publicKey) {
      return {
        action: "scale_up_skipped",
        detail: "CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY not set on daemon host",
      };
    }
    try {
      const provisioned = await autoscaler.provisionNode(
        {},
        {
          controlPlanePublicKey: publicKey,
          registrationUrl: process.env.CONTAINERS_BOOTSTRAP_CALLBACK_URL,
          registrationSecret: process.env.CONTAINERS_BOOTSTRAP_SECRET,
        },
      );
      return {
        action: "scale_up",
        detail: `${provisioned.nodeId} (${provisioned.hostname})`,
      };
    } catch (error) {
      return {
        action: "scale_up_failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Scale down path. Drain only the first candidate per cycle to avoid
  // draining the whole pool on a single cron tick if multiple nodes show
  // up as idle simultaneously.
  const target = decision.shouldScaleDownNodeIds[0];
  if (!target) {
    return { action: "noop" };
  }
  try {
    await autoscaler.drainNode(target, { deprovision: true });
    return { action: "scale_down", detail: target };
  } catch (error) {
    return {
      action: "drain_failed",
      detail: `${target}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

interface FleetUpgradeSummary {
  action: "noop" | "skip_no_digest" | "skip_capacity" | "enqueued";
  configuredImage?: string;
  targetDigest?: string | null;
  candidates?: number;
  enqueued?: number;
  inFlight?: number;
  detail?: string;
}

const MAX_INFLIGHT_UPGRADES = 3;

/**
 * Detect when the registry-side digest of the configured agent tag has moved
 * (e.g. a new `:develop` image was pushed) and enqueue blue/green
 * `agent_upgrade` jobs for every running agent still on the old digest.
 *
 * Rate-limited to at most `MAX_INFLIGHT_UPGRADES` upgrade jobs in flight at
 * any time so the fleet is never fully disrupted at once. The actual swap is
 * zero-downtime (a new container is provisioned on a different node, traffic
 * is atomically swapped, then the old container gets a 30s SIGTERM drain
 * before removal), so the rate limit is about resource pressure on
 * docker_nodes (each in-flight swap holds capacity on two nodes briefly),
 * not user-facing impact.
 *
 * Returns "skip_no_digest" when the registry probe can't resolve a digest —
 * e.g. the operator pinned a non-ghcr image like `eliza-agent:prod-good`, or
 * the registry is unreachable. The reconciler simply waits for the next tick.
 */
async function processFleetUpgradeCycle(): Promise<FleetUpgradeSummary> {
  const {
    containersEnv,
    resolveImageDigest,
    agentSandboxesRepository,
    jobsRepository,
    provisioningJobService,
  } = await loadDeps();

  const configuredImage = containersEnv.defaultAgentImage();
  const targetDigest = await resolveImageDigest(configuredImage);
  if (!targetDigest) {
    return {
      action: "skip_no_digest",
      configuredImage,
      targetDigest,
      detail: "registry probe returned null",
    };
  }

  const inFlight = await jobsRepository.countInFlightByType("agent_upgrade");
  const slack = MAX_INFLIGHT_UPGRADES - inFlight;
  if (slack <= 0) {
    return {
      action: "skip_capacity",
      configuredImage,
      targetDigest,
      inFlight,
    };
  }

  const candidates =
    await agentSandboxesRepository.listRunningWithDigestOtherThan(
      targetDigest,
      configuredImage,
      slack,
    );
  if (candidates.length === 0) {
    return { action: "noop", configuredImage, targetDigest, inFlight };
  }

  const { logger } = await loadDeps();
  let enqueued = 0;
  for (const c of candidates) {
    try {
      const result = await provisioningJobService.enqueueAgentUpgradeOnce({
        agentId: c.id,
        organizationId: c.organization_id,
        userId: c.user_id,
        fromDigest: c.image_digest,
        toDigest: targetDigest,
        dockerImage: configuredImage,
      });
      if (result.created) enqueued += 1;
    } catch (err) {
      logger.warn("[provisioning-worker] fleet-upgrade enqueue failed", {
        agentId: c.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    action: "enqueued",
    configuredImage,
    targetDigest,
    candidates: candidates.length,
    enqueued,
    inFlight,
  };
}

/**
 * Drain warm-pool sandboxes that have been idle past their TTL. Replaces the
 * `pool-drain-idle` cron path.
 */
async function processPoolDrainIdleCycle(): Promise<PoolDrainSummary> {
  const { containersEnv } = await loadDeps();
  const image = containersEnv.defaultAgentImage();
  const pool = await getWarmPoolManager();
  const result = await pool.drainIdle(image);
  return { drained: result.drained.length };
}

let running = true;
let lastInfraMaintenanceAt = 0;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function publishHeartbeat(logger: WorkerLogger): Promise<void> {
  try {
    const { publishProvisioningWorkerHeartbeat } = await import(
      "@elizaos/cloud-shared/lib/services/provisioning-worker-health"
    );
    await publishProvisioningWorkerHeartbeat();
  } catch (error) {
    logger.warn("[provisioning-worker] heartbeat publish failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function pollCycle(
  logger: WorkerLogger,
  config: ProvisioningWorkerConfig,
): Promise<void> {
  await assertProvisioningWorkerPreflight();
  await publishHeartbeat(logger);
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

  try {
    const decision = await processFleetUpgradeCycle();
    if (decision.action !== "noop") {
      logger.info("[provisioning-worker] fleet upgrade cycle complete", {
        action: decision.action,
        configuredImage: decision.configuredImage,
        targetDigest: decision.targetDigest,
        candidates: decision.candidates,
        enqueued: decision.enqueued,
        inFlight: decision.inFlight,
        detail: decision.detail,
      });
    }
  } catch (error) {
    logger.error("[provisioning-worker] fleet upgrade cycle failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Infra maintenance cycle runs on a longer interval than the heartbeat
  // (SSH + Docker probes per node are expensive). Bundles every job that
  // used to be forwarded from CF crons to the now-deprecated control-plane:
  //   - node health check  (was: /api/v1/cron/agent-hot-pool — healthCheckAll)
  //   - alloc reconciliation (was: agent-hot-pool — syncAllocatedCounts)
  //   - pre-pull warm image (was: agent-hot-pool — prePullAgentImageOnAvailableNodes)
  //   - node autoscale     (was: /api/v1/cron/node-autoscale)
  //   - warm pool drain    (was: /api/v1/cron/pool-drain-idle)
  // Folding them together avoids 3 parallel writers fighting over the same
  // docker_nodes rows and means there's exactly one host that owns the
  // truth: the orchestrator (this daemon). `lastInfraMaintenanceAt`
  // initializes to 0 so the first poll always runs — we want a fresh
  // node-status snapshot at worker startup.
  const now = Date.now();
  if (now - lastInfraMaintenanceAt >= config.nodeHealthIntervalMs) {
    lastInfraMaintenanceAt = now;
    await runInfraMaintenanceCycle(logger);
  }
}

async function runInfraMaintenanceCycle(logger: WorkerLogger): Promise<void> {
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

  try {
    const changes = await processSyncAllocatedCountsCycle();
    if (changes > 0) {
      logger.info("[provisioning-worker] alloc reconcile cycle complete", {
        changed: changes,
      });
    }
  } catch (error) {
    logger.error("[provisioning-worker] alloc reconcile cycle failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const summary = await processPrePullImagesCycle();
    if (summary) {
      logger.info("[provisioning-worker] pre-pull images cycle complete", {
        attempted: summary.attempted,
        failed: summary.failed,
      });
    }
  } catch (error) {
    logger.error("[provisioning-worker] pre-pull images cycle failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const decision = await processNodeAutoscaleCycle();
    if (decision.action !== "noop") {
      logger.info("[provisioning-worker] node autoscale cycle complete", {
        action: decision.action,
        detail: decision.detail,
      });
    }
  } catch (error) {
    logger.error("[provisioning-worker] node autoscale cycle failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const result = await processPoolDrainIdleCycle();
    if (result.drained > 0) {
      logger.info("[provisioning-worker] warm pool drain cycle complete", {
        drained: result.drained,
      });
    }
  } catch (error) {
    logger.error("[provisioning-worker] warm pool drain cycle failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Apps (Product 2): arm the node deploy backend so the daemon runs APP_DEPLOY +
 * CONTAINER_* jobs (provision an isolated per-tenant DB -> run an isolated
 * container with that DSN). Gated OFF by default — only when
 * `APPS_DEPLOY_ENABLED=1`. Additive + safe: when off, the cloud-api deploy
 * trigger is also gated off, so no APP_DEPLOY/CONTAINER_* jobs are ever enqueued,
 * the executor seam is never queried, and Product-1 (agents) is untouched.
 *
 * Defaults to the PREBUILT-image path proven on staging (no `buildExec`): images
 * resolve from `app.metadata.imageTag` / `APP_DEFAULT_IMAGE`. The cluster admin
 * DSN is env-sourced via `APPS_TENANT_ADMIN_DSN` (no `SECRETS_MASTER_KEY`).
 */
async function armAppsDeployBackendIfEnabled(
  logger: WorkerLogger,
): Promise<void> {
  if (process.env.APPS_DEPLOY_ENABLED !== "1") return;
  const { configureAppsDeployBackend } = await import(
    "@elizaos/cloud-shared/lib/services/apps-deploy-backend"
  );
  const port = process.env.APPS_DEPLOY_PORT
    ? Number(process.env.APPS_DEPLOY_PORT)
    : undefined;
  // When APPS_IMAGE_REGISTRY is set, the backend arms BUILD-FROM-REPO (builds the
  // user's repo on the app node via buildx and pushes to this registry — the
  // Vercel-like path). Unset → prebuilt images (imageTag/APP_DEFAULT_IMAGE).
  const registry = process.env.APPS_IMAGE_REGISTRY;
  configureAppsDeployBackend({ port, registry });
  logger.info("[provisioning-worker] apps deploy backend armed", {
    tenantDbAdminDsn: process.env.APPS_TENANT_ADMIN_DSN
      ? "env-sourced"
      : "encrypted",
    images: registry
      ? "build-from-repo"
      : "prebuilt (imageTag/APP_DEFAULT_IMAGE)",
    registry: registry ?? null,
    port: port ?? 3000,
  });
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

  await assertProvisioningWorkerPreflight();
  logger.info("[provisioning-worker] startup preflight passed");

  // Apps (Product 2): arm the deploy backend when enabled (gated; no-op by default).
  await armAppsDeployBackendIfEnabled(logger);

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
