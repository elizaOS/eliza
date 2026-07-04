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
import type { AppOrphanReconcileResult } from "@elizaos/cloud-shared/lib/services/app-container-orphan-reconciler";
import type { OrphanReconcileResult } from "@elizaos/cloud-shared/lib/services/docker-node-workloads";
import {
  type ProvisioningJobType,
  resolveJobTypesForLanes,
} from "@elizaos/cloud-shared/lib/services/provisioning-job-types";
import type {
  HeartbeatResult,
  ProcessingResult,
  RecoveryResult,
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
type WorkerReconcileOrphanContainers =
  typeof import("@elizaos/cloud-shared/lib/services/docker-node-workloads").reconcileOrphanContainersOnNodes;
type WorkerReconcileOrphanAppContainers =
  typeof import("@elizaos/cloud-shared/lib/services/app-container-orphan-reconciler").reconcileOrphanAppContainersOnNodes;
type WorkerWithTimeout =
  typeof import("@elizaos/cloud-shared/lib/utils/with-timeout").withTimeout;
type WorkerProcessNodeDiskCleanup =
  typeof import("@elizaos/cloud-shared/lib/services/node-disk-manager").processNodeDiskCleanup;

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
  reconcileOrphanContainersOnNodes: WorkerReconcileOrphanContainers;
  reconcileOrphanAppContainersOnNodes: WorkerReconcileOrphanAppContainers;
  withTimeout: WorkerWithTimeout;
  processNodeDiskCleanup: WorkerProcessNodeDiskCleanup;
}

export interface ProvisioningWorkerConfig {
  pollIntervalMs: number;
  batchSize: number;
  runOnce: boolean;
  nodeHealthIntervalMs: number;
  /**
   * Job types this daemon claims, from `PROVISIONING_JOB_LANES`. Unset → ALL
   * (the single-daemon default; behavior unchanged). Pin to `agent` once a
   * dedicated apps-control daemon owns the `apps` lane so this control-plane
   * worker stops claiming (and failing) APP_DEPLOY/CONTAINER_* jobs it can't
   * reach the private tenant DB to run.
   */
  jobTypes: readonly ProvisioningJobType[];
  /**
   * When true (default), a watchdog-wedged worker exits with code 1 after
   * `watchdogConsecutiveTicks` consecutive stale heartbeat ticks so systemd
   * `Restart=always` relaunches it. Gated by `PROVISIONING_WORKER_SELF_RESTART`
   * (set to `0`/`false` to disable, e.g. during planned infra maintenance).
   */
  selfRestartEnabled: boolean;
  /**
   * Number of consecutive heartbeat ticks the watchdog must stay tripped before
   * the worker self-restarts. The watchdog trips at WATCHDOG_MAX_CYCLE_MS of no
   * completed cycle, and restart fires on the K-th consecutive tick after, so
   * the time from the last good cycle to exit(1) is
   * ≈ WATCHDOG_MAX_CYCLE_MS + (K-1) * HEARTBEAT_INTERVAL_MS (≈315s at K=2). The
   * extra ticks keep a one-off slow cycle from restart-looping; they are NOT a
   * "~2x window" multiplier.
   */
  watchdogConsecutiveTicks: number;
  /**
   * When true, the low-cadence orphan-container reconcilers sweep HEALTHY nodes
   * for leaked containers with no live DB row (or a terminal-state row) and
   * force-remove them — both the agent sweep (`agent-<id>` vs `agent_sandboxes`)
   * and the apps sweep (`app-<slug>` vs `containers`). Gated OFF by default via
   * `ORPHAN_RECONCILER_ENABLED=1` because they issue `docker rm -f` and should be
   * armed deliberately.
   */
  orphanReconcilerEnabled: boolean;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 3;

/**
 * Node health-check cadence. 5 minutes matches the `agent-hot-pool`
 * CRON_FANOUT schedule. SSH uses `CONTAINERS_SSH_KEY` from this host.
 */
const DEFAULT_NODE_HEALTH_INTERVAL_MS = 5 * 60_000;

/**
 * Default consecutive-tick threshold for the self-restart watchdog. At K=2 with
 * the 15s heartbeat tick and the 5min watchdog window, the worker restarts
 * ≈ WATCHDOG_MAX_CYCLE_MS + (K-1) * HEARTBEAT_INTERVAL_MS ≈ 315s after the last
 * good cycle (the watchdog window plus one extra 15s tick), not ~2x the window.
 */
const DEFAULT_WATCHDOG_CONSECUTIVE_TICKS = 2;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}

/** Parse an opt-OUT boolean env flag: anything but `0`/`false` keeps the default-on. */
function parseBooleanDefaultTrue(value: string | undefined): boolean {
  if (value === undefined) return true;
  const normalized = value.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false";
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
    jobTypes: resolveJobTypesForLanes(env.PROVISIONING_JOB_LANES),
    selfRestartEnabled: parseBooleanDefaultTrue(
      env.PROVISIONING_WORKER_SELF_RESTART,
    ),
    watchdogConsecutiveTicks: parsePositiveInt(
      env.PROVISIONING_WORKER_WATCHDOG_TICKS,
      DEFAULT_WATCHDOG_CONSECUTIVE_TICKS,
    ),
    orphanReconcilerEnabled: env.ORPHAN_RECONCILER_ENABLED === "1",
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
      import("@elizaos/cloud-shared/lib/services/docker-node-workloads"),
      import(
        "@elizaos/cloud-shared/lib/services/app-container-orphan-reconciler"
      ),
      import("@elizaos/cloud-shared/lib/utils/with-timeout"),
      import("@elizaos/cloud-shared/lib/services/node-disk-manager"),
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
        nodeWorkloadsModule,
        appOrphanReconcilerModule,
        withTimeoutModule,
        nodeDiskManagerModule,
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
        reconcileOrphanContainersOnNodes:
          nodeWorkloadsModule.reconcileOrphanContainersOnNodes,
        reconcileOrphanAppContainersOnNodes:
          appOrphanReconcilerModule.reconcileOrphanAppContainersOnNodes,
        withTimeout: withTimeoutModule.withTimeout,
        processNodeDiskCleanup: nodeDiskManagerModule.processNodeDiskCleanup,
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
  jobTypes?: readonly ProvisioningJobType[],
): Promise<ProcessingResult> {
  const { provisioningJobService } = await loadDeps();
  return provisioningJobService.processPendingJobs(batchSize, { jobTypes });
}

async function processHeartbeatCycle(
  concurrency = 5,
): Promise<HeartbeatResult> {
  const { provisioningJobService } = await loadDeps();
  return provisioningJobService.processRunningHeartbeats(concurrency);
}

async function processRecoveryCycle(concurrency = 5): Promise<RecoveryResult> {
  const { provisioningJobService } = await loadDeps();
  return provisioningJobService.processDisconnectedRecovery(concurrency);
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

interface NodeDiskCleanupSummary {
  nodesScanned: number;
  nodesSkipped: number;
  pruned: number;
  pruneFailed: number;
}

/**
 * Prune Docker disk on HEALTHY nodes that crossed the high-water mark. Reclaims
 * with `docker system prune -af` (no `--volumes`) + clears stuck containerd
 * ingest from failed pulls + buildkit prune, with a per-node cooldown so it does
 * not prune every tick. This is the missing self-management that keeps a node
 * from filling up on retried failed image pulls (`no space left on device`) and
 * breaking dedicated-agent provisioning. Runs over the same SSH pool the daemon
 * already authenticates with `CONTAINERS_SSH_KEY`; ON by default (thresholds in
 * `containers-env.ts`).
 */
async function processNodeDiskCleanupCycle(): Promise<NodeDiskCleanupSummary> {
  const { processNodeDiskCleanup } = await loadDeps();
  const report = await processNodeDiskCleanup();
  return {
    nodesScanned: report.nodesScanned,
    nodesSkipped: report.nodesSkipped,
    pruned: report.pruned,
    pruneFailed: report.pruneFailed,
  };
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

/**
 * FIX 3: sweep HEALTHY nodes for `agent-<id>` containers with no live DB row
 * (or a terminal-state row) and force-remove them. The reconciler itself only
 * touches nodes whose status is `healthy`, which the preceding node-health
 * check just refreshed, so a transient SSH blip can never reap live containers.
 */
async function processOrphanReconcilerCycle(): Promise<OrphanReconcileResult> {
  const { reconcileOrphanContainersOnNodes } = await loadDeps();
  return reconcileOrphanContainersOnNodes();
}

/**
 * Apps (Product 2) sibling of the agent orphan reconciler: sweep HEALTHY nodes
 * for `app-<slug>` containers with no live `containers` row (or a terminal-state
 * row) and force-remove them. App-container teardown only runs on an explicit
 * app delete, so a mid-deploy crash or partial failure leaks an app container on
 * a node forever; this closes that gap. Same safety model as the agent sweep:
 * it only touches `healthy` nodes (refreshed by the preceding node-health check),
 * skips a node whose listing failed, and reaps by the immutable container id.
 */
async function processAppOrphanReconcilerCycle(): Promise<AppOrphanReconcileResult> {
  const { reconcileOrphanAppContainersOnNodes } = await loadDeps();
  return reconcileOrphanAppContainersOnNodes();
}

let running = true;
let lastInfraMaintenanceAt = 0;

/**
 * Heartbeat cadence — independent of the work cycle. The liveness key lives
 * 60s in Redis (PROVISIONING_WORKER_HEARTBEAT_TTL_S); publishing every 15s
 * leaves room for 3 missed publishes before the gate trips. Decoupling this
 * from `pollCycle` is THE fix: a slow agent-delete or node health-check can no
 * longer starve the heartbeat and make cloud-api reject every provision.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * If the work cycle stops completing for this long, the worker is wedged
 * (e.g. Redis healthy but Neon/SSH hung). We deliberately STOP publishing the
 * heartbeat so cloud-api fails CLOSED — `checkProvisioningWorkerHealth` sees
 * the stale key and 503s new provisions instead of routing them to a worker
 * that can't make progress — and the loud error log flags it for a human.
 *
 * On top of failing-closed, the worker self-restarts: once the watchdog stays
 * tripped for `watchdogConsecutiveTicks` consecutive heartbeat ticks, it logs
 * loudly and `process.exit(1)`s so systemd `Restart=always` relaunches it. The
 * K-tick gate keeps a slow-but-healthy cycle from restart-looping. Gated by
 * `PROVISIONING_WORKER_SELF_RESTART` (default on) so it can be disabled.
 *
 * Timing (FIX G): the watchdog trips once a cycle has not completed for
 * WATCHDOG_MAX_CYCLE_MS. The self-restart then fires on the K-th consecutive
 * heartbeat tick AFTER it trips, so the wall-clock from the last good cycle to
 * exit(1) is
 *   ≈ WATCHDOG_MAX_CYCLE_MS + (K-1) * HEARTBEAT_INTERVAL_MS
 * For the defaults (300s + (2-1)*15s) that is ≈ 315s — NOT ~600s / "~2x the
 * window". The first wedged tick only arms the counter (no restart); the K-th
 * tick fires it.
 */
const WATCHDOG_MAX_CYCLE_MS = 5 * 60_000;

/**
 * Per-phase wall-clock budget. Each cycle phase (provisioning, node health,
 * autoscale, …) is wrapped in `withTimeout` so a single hung phase — a Neon
 * stall or an unresponsive node's SSH probe — frees fast instead of running
 * unbounded. `withTimeout` only frees the awaiter — every leaf already has its
 * own hard SSH/HTTP/Redis timeout, so a freed phase leaves no truly-unbounded
 * I/O. This is the fast per-phase wedge signal; the cycle-wide budget below is
 * what actually keeps the watchdog invariant from being violated.
 */
const PHASE_TIMEOUT_MS = 60_000;

/**
 * Whole-WORK-cycle wall-clock budget (FIX E). The 4 WORK phases run on the
 * watchdog's critical path, so SUM(their budgets) + the poll interval MUST stay
 * below WATCHDOG_MAX_CYCLE_MS — otherwise a slow-but-progressing cycle could
 * exceed the window and the worker would self-restart (the exact false positive
 * the design claims to prevent: 4 × 90s = 360s > 300s under the old per-phase
 * 90s budgets). Instead of summing N per-phase timeouts, the whole WORK group
 * is bounded ONCE by this budget. Picked comfortably below the watchdog window:
 *   WORK_CYCLE_TIMEOUT_MS + DEFAULT_POLL_INTERVAL_MS = 240s + 30s = 270s < 300s.
 * Adding a 5th WORK phase therefore cannot re-break the invariant — the group
 * budget is fixed. `assertWatchdogInvariant()` pins this at module load and the
 * unit test pins it too (FIX F).
 */
const WORK_CYCLE_TIMEOUT_MS = 4 * 60_000;

/**
 * The watchdog invariant, surfaced for the unit test (FIX F) so adding a phase
 * or bumping a timeout can't silently violate it. The work cycle is bounded as
 * a GROUP by WORK_CYCLE_TIMEOUT_MS, so that single budget (plus the poll gap)
 * is what must fit inside the watchdog window — not the per-phase budgets.
 */
export const WORKER_TIMING = {
  watchdogMaxCycleMs: WATCHDOG_MAX_CYCLE_MS,
  workCycleTimeoutMs: WORK_CYCLE_TIMEOUT_MS,
  phaseTimeoutMs: PHASE_TIMEOUT_MS,
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  defaultPollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
} as const;

/**
 * Guard the watchdog invariant at module load: the WORK cycle's wall-clock
 * budget plus the time the loop sleeps between cycles must finish well before
 * the watchdog declares the worker wedged. A future edit that bumps
 * WORK_CYCLE_TIMEOUT_MS or lowers WATCHDOG_MAX_CYCLE_MS into violation throws
 * loudly at startup instead of shipping a worker that self-restarts mid-cycle.
 */
function assertWatchdogInvariant(): void {
  if (
    WORK_CYCLE_TIMEOUT_MS + DEFAULT_POLL_INTERVAL_MS >=
    WATCHDOG_MAX_CYCLE_MS
  ) {
    throw new Error(
      "[provisioning-worker] watchdog invariant violated: " +
        `WORK_CYCLE_TIMEOUT_MS (${WORK_CYCLE_TIMEOUT_MS}) + DEFAULT_POLL_INTERVAL_MS ` +
        `(${DEFAULT_POLL_INTERVAL_MS}) must be < WATCHDOG_MAX_CYCLE_MS (${WATCHDOG_MAX_CYCLE_MS}). ` +
        "A slow-but-progressing work cycle would otherwise trip the watchdog and self-restart.",
    );
  }
}
assertWatchdogInvariant();

/**
 * Liveness gate. The heartbeat interval publishes ONLY when this is true.
 * Set true immediately after `assertProvisioningWorkerPreflight()` succeeds,
 * false on any throw. Default false so a KMS-dead worker never advertises
 * healthy before the first preflight has run.
 */
let preflightOk = false;

/** Wall-clock of the last `pollCycle` that returned. Drives the watchdog. */
let lastCycleCompletedAt = Date.now();

/** In-flight guard so a hung Redis write can't pile up unresolved publishes. */
let heartbeatPublishInFlight = false;

/**
 * Consecutive heartbeat ticks the watchdog has been tripped. Reset to 0 on any
 * tick where the work cycle is progressing. Drives the self-restart decision.
 */
let consecutiveWatchdogTicks = 0;

/**
 * Pure decision for FIX 1's self-restart: given how many consecutive ticks the
 * watchdog has been tripped, whether the feature is enabled, and the K
 * threshold, decide whether the worker should exit(1) now. Exported for unit
 * testing the K-consecutive-tick trigger without spawning a process.
 */
export function evaluateSelfRestart(deps: {
  watchdogTripped: boolean;
  consecutiveTicks: number;
  selfRestartEnabled: boolean;
  threshold: number;
}): { nextConsecutiveTicks: number; shouldRestart: boolean } {
  if (!deps.watchdogTripped) {
    return { nextConsecutiveTicks: 0, shouldRestart: false };
  }
  const nextConsecutiveTicks = deps.consecutiveTicks + 1;
  const shouldRestart =
    deps.selfRestartEnabled && nextConsecutiveTicks >= deps.threshold;
  return { nextConsecutiveTicks, shouldRestart };
}

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

/**
 * Decide whether the heartbeat may be published this tick, and publish it.
 * Gated on three independent conditions, all of which must hold:
 *   1. `preflightOk` — KMS is usable (a KMS-dead worker must never advertise
 *      healthy, mirroring the old in-cycle preflight gate).
 *   2. the watchdog has not tripped — the work cycle is still progressing.
 *   3. no publish is already in flight — a slow/hung Redis write must not pile
 *      up unresolved promises.
 * Exported for unit testing the gate logic.
 */
export async function maybePublishHeartbeat(
  logger: WorkerLogger,
  deps: {
    preflightOk: boolean;
    lastCycleCompletedAt: number;
    now?: number;
    publish?: (logger: WorkerLogger) => Promise<void>;
  },
): Promise<{ published: boolean; watchdogTripped: boolean }> {
  const now = deps.now ?? Date.now();
  const publish = deps.publish ?? publishHeartbeat;

  if (now - deps.lastCycleCompletedAt > WATCHDOG_MAX_CYCLE_MS) {
    logger.error(
      "[provisioning-worker] WATCHDOG: work cycle has not completed in over " +
        `${Math.round(WATCHDOG_MAX_CYCLE_MS / 1000)}s — worker appears wedged. ` +
        "Withholding heartbeat so cloud-api fails closed (stops routing provisions here); restart this worker.",
      {
        lastCycleCompletedAt: new Date(deps.lastCycleCompletedAt).toISOString(),
      },
    );
    return { published: false, watchdogTripped: true };
  }

  // KMS-dead worker must never advertise healthy.
  if (!deps.preflightOk) {
    return { published: false, watchdogTripped: false };
  }

  await publish(logger);
  return { published: true, watchdogTripped: false };
}

/**
 * Loudly log and exit so systemd `Restart=always` relaunches the worker. Split
 * out so the side-effecting `process.exit` is in one place and the rest of the
 * tick logic stays pure/testable. Allows injecting `exit` in tests.
 */
function triggerSelfRestart(
  logger: WorkerLogger,
  consecutiveTicks: number,
  exit: (code: number) => never = process.exit,
): never {
  logger.error(
    "[provisioning-worker] WATCHDOG self-restart: work cycle wedged for " +
      `${consecutiveTicks} consecutive heartbeat ticks (>=${Math.round(
        WATCHDOG_MAX_CYCLE_MS / 1000,
      )}s stale). Exiting(1) so systemd relaunches a fresh worker.`,
    {
      event: "worker.self_restart",
      consecutiveWatchdogTicks: consecutiveTicks,
      lastCycleCompletedAt: new Date(lastCycleCompletedAt).toISOString(),
    },
  );
  return exit(1);
}

/**
 * Start the independent heartbeat timer. Decoupled from `pollCycle` so a slow
 * work item can never starve the liveness key. The in-flight guard skips a
 * tick rather than queueing a second publish behind a hung Redis write.
 *
 * Each tick also advances the self-restart watchdog: when the heartbeat is
 * withheld because the work cycle is wedged, the consecutive-tick counter
 * climbs; once it crosses `config.watchdogConsecutiveTicks`, the worker
 * self-restarts (FIX 1).
 */
function startHeartbeatInterval(
  logger: WorkerLogger,
  config: ProvisioningWorkerConfig,
): NodeJS.Timeout {
  const tick = () => {
    if (heartbeatPublishInFlight) return;
    heartbeatPublishInFlight = true;
    void maybePublishHeartbeat(logger, {
      preflightOk,
      lastCycleCompletedAt,
    })
      .then(({ watchdogTripped }) => {
        const { nextConsecutiveTicks, shouldRestart } = evaluateSelfRestart({
          watchdogTripped,
          consecutiveTicks: consecutiveWatchdogTicks,
          selfRestartEnabled: config.selfRestartEnabled,
          threshold: config.watchdogConsecutiveTicks,
        });
        consecutiveWatchdogTicks = nextConsecutiveTicks;
        // Don't self-restart (exit 1) while draining: a SIGTERM that flips
        // `running` should exit 0, not be turned into a wedge-restart.
        if (shouldRestart && running) {
          triggerSelfRestart(logger, nextConsecutiveTicks);
        }
      })
      .finally(() => {
        heartbeatPublishInFlight = false;
      });
  };
  const timer = setInterval(tick, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return timer;
}

/**
 * Run one cycle phase under a hard wall-clock budget (FIX 2). The phase is
 * wrapped in `withTimeout` (so a hung phase frees the cycle) and its result is
 * handed to `onResult` for logging; any throw — including the timeout — is
 * caught and logged so one phase failing never aborts the rest of the cycle.
 */
async function runBoundedPhase<T>(
  logger: WorkerLogger,
  label: string,
  phase: () => Promise<T>,
  onResult: (result: T) => void,
): Promise<void> {
  const { withTimeout } = await loadDeps();
  try {
    const result = await withTimeout(
      phase(),
      PHASE_TIMEOUT_MS,
      `[provisioning-worker] ${label}`,
    );
    onResult(result);
  } catch (error) {
    logger.error(`[provisioning-worker] ${label} failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Run the 4 WORK phases (claim/complete jobs, agent heartbeats, recovery, fleet
 * upgrade) as a single group bounded by WORK_CYCLE_TIMEOUT_MS (FIX E). Bounding
 * the group once — rather than summing N per-phase 90s timeouts (4 × 90s = 360s
 * > the 300s watchdog window) — keeps the critical-path budget below
 * WATCHDOG_MAX_CYCLE_MS, so a slow-but-progressing cycle can't self-restart. The
 * group timeout is caught and logged so it frees the cycle without aborting the
 * rest of pollCycle; the per-phase timeouts inside still give a fast,
 * per-phase wedge signal.
 */
async function runWorkCycle(
  logger: WorkerLogger,
  config: ProvisioningWorkerConfig,
): Promise<void> {
  const { withTimeout } = await loadDeps();
  const work = (async () => {
    await runBoundedPhase(
      logger,
      "cycle",
      () => processProvisioningWorkerCycle(config.batchSize, config.jobTypes),
      (result) => {
        if (result.claimed > 0 || result.failed > 0) {
          logger.info(
            "[provisioning-worker] cycle complete",
            resultContext(result),
          );
        }
      },
    );

    await runBoundedPhase(
      logger,
      "heartbeat cycle",
      () => processHeartbeatCycle(),
      (heartbeats) => {
        if (heartbeats.total > 0) {
          logger.info("[provisioning-worker] heartbeat cycle complete", {
            total: heartbeats.total,
            succeeded: heartbeats.succeeded,
            failed: heartbeats.failed,
          });
        }
      },
    );

    await runBoundedPhase(
      logger,
      "recovery cycle",
      () => processRecoveryCycle(),
      (recovery) => {
        if (recovery.total > 0) {
          logger.info("[provisioning-worker] recovery cycle complete", {
            total: recovery.total,
            recovered: recovery.recovered,
            reprovisioned: recovery.reprovisioned,
            failed: recovery.failed,
          });
        }
      },
    );

    await runBoundedPhase(
      logger,
      "fleet upgrade cycle",
      () => processFleetUpgradeCycle(),
      (decision) => {
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
      },
    );
  })();

  try {
    await withTimeout(
      work,
      WORK_CYCLE_TIMEOUT_MS,
      "[provisioning-worker] work cycle",
    );
  } catch (error) {
    // A group-level timeout frees the cycle (every leaf is independently
    // bounded) so the watchdog clock advances and infra maintenance still runs.
    logger.error("[provisioning-worker] work cycle exceeded its budget", {
      error: error instanceof Error ? error.message : String(error),
      workCycleTimeoutMs: WORK_CYCLE_TIMEOUT_MS,
    });
  }
}

async function pollCycle(
  logger: WorkerLogger,
  config: ProvisioningWorkerConfig,
): Promise<void> {
  // Re-validate the preflight at the top of every cycle (cheap — a local KMS
  // getOrCreateKey). The heartbeat interval owns liveness now, but it only
  // publishes while `preflightOk` is true, so this is what keeps a KMS-dead
  // worker from advertising healthy. Set true ONLY immediately after success.
  try {
    await assertProvisioningWorkerPreflight();
    preflightOk = true;
  } catch (error) {
    preflightOk = false;
    logger.error(
      "[provisioning-worker] preflight failed; withholding heartbeat",
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return;
  }
  // ── WORK phases (on the watchdog's critical path) ────────────────────────
  // The WHOLE group is bounded ONCE by WORK_CYCLE_TIMEOUT_MS (FIX E) so the
  // critical-path budget stays below WATCHDOG_MAX_CYCLE_MS no matter how many
  // phases there are — 4 × per-phase 90s used to sum to 360s and could trip the
  // 300s watchdog on a slow-but-progressing cycle. Each phase keeps its own
  // (now-shorter) per-phase timeout as a fast individual-wedge signal; the group
  // bound is the authoritative one. A group-level timeout frees the cycle and is
  // logged, never aborting the rest of pollCycle (infra maintenance still runs).
  await runWorkCycle(logger, config);

  // Mark progress for the watchdog HERE — after the WORK cycle, BEFORE infra
  // maintenance (FIX 2). Infra maintenance (SSH + Docker probes across the
  // whole fleet) is slow and off the critical liveness path: a node-health or
  // orphan-reconcile sweep that drags on must not make a worker that is still
  // claiming and completing jobs look wedged. As long as the WORK cycle keeps
  // advancing this, the heartbeat interval keeps the worker healthy.
  lastCycleCompletedAt = Date.now();

  // ── Infra maintenance (off the watchdog path) ────────────────────────────
  // Runs on a longer interval than the heartbeat (SSH + Docker probes per node
  // are expensive). Bundles every job that used to be forwarded from CF crons
  // to the now-deprecated control-plane:
  //   - node health check  (was: /api/v1/cron/agent-hot-pool — healthCheckAll)
  //   - alloc reconciliation (was: agent-hot-pool — syncAllocatedCounts)
  //   - pre-pull warm image (was: agent-hot-pool — prePullAgentImageOnAvailableNodes)
  //   - node autoscale     (was: /api/v1/cron/node-autoscale)
  //   - warm pool drain    (was: /api/v1/cron/pool-drain-idle)
  //   - orphan reconcile   (FIX 3, gated by ORPHAN_RECONCILER_ENABLED)
  // Folding them together avoids 3 parallel writers fighting over the same
  // docker_nodes rows and means there's exactly one host that owns the
  // truth: the orchestrator (this daemon). `lastInfraMaintenanceAt`
  // initializes to 0 so the first poll always runs — we want a fresh
  // node-status snapshot at worker startup.
  const now = Date.now();
  if (now - lastInfraMaintenanceAt >= config.nodeHealthIntervalMs) {
    lastInfraMaintenanceAt = now;
    await runInfraMaintenanceCycle(logger, config);
  }
}

async function runInfraMaintenanceCycle(
  logger: WorkerLogger,
  config: ProvisioningWorkerConfig,
): Promise<void> {
  // Every phase is bounded by PHASE_TIMEOUT_MS via runBoundedPhase so an
  // unresponsive node's SSH probe can never stall the whole sweep.
  await runBoundedPhase(
    logger,
    "node health check cycle",
    () => processNodeHealthCheckCycle(),
    (summary) => {
      logger.info("[provisioning-worker] node health check cycle complete", {
        total: summary.total,
        healthy: summary.healthy,
        unhealthy: summary.unhealthy,
      });
    },
  );

  // Disk retention runs right after the node-health check so it sees fresh node
  // status (only `healthy` nodes are pruned) and BEFORE the image pre-pull, so a
  // node we just reclaimed has room for the next warm-image pull instead of
  // failing it on `no space left on device`. Bounded by PHASE_TIMEOUT_MS like
  // every infra phase.
  await runBoundedPhase(
    logger,
    "node disk cleanup cycle",
    () => processNodeDiskCleanupCycle(),
    (summary) => {
      if (summary.pruned > 0 || summary.pruneFailed > 0) {
        logger.info("[provisioning-worker] node disk cleanup cycle complete", {
          event: "node_disk_cleanup.pruned",
          nodesScanned: summary.nodesScanned,
          nodesSkipped: summary.nodesSkipped,
          pruned: summary.pruned,
          pruneFailed: summary.pruneFailed,
        });
      }
    },
  );

  await runBoundedPhase(
    logger,
    "alloc reconcile cycle",
    () => processSyncAllocatedCountsCycle(),
    (changes) => {
      if (changes > 0) {
        logger.info("[provisioning-worker] alloc reconcile cycle complete", {
          changed: changes,
        });
      }
    },
  );

  await runBoundedPhase(
    logger,
    "pre-pull images cycle",
    () => processPrePullImagesCycle(),
    (summary) => {
      if (summary) {
        logger.info("[provisioning-worker] pre-pull images cycle complete", {
          attempted: summary.attempted,
          failed: summary.failed,
        });
      }
    },
  );

  await runBoundedPhase(
    logger,
    "node autoscale cycle",
    () => processNodeAutoscaleCycle(),
    (decision) => {
      if (decision.action !== "noop") {
        logger.info("[provisioning-worker] node autoscale cycle complete", {
          action: decision.action,
          detail: decision.detail,
        });
      }
    },
  );

  await runBoundedPhase(
    logger,
    "warm pool drain cycle",
    () => processPoolDrainIdleCycle(),
    (result) => {
      if (result.drained > 0) {
        logger.info("[provisioning-worker] warm pool drain cycle complete", {
          drained: result.drained,
        });
      }
    },
  );

  // FIX 3: orphan-container reconciliation. Runs LAST so it sees the fresh
  // node-status from the health check above — the reconciler only touches
  // HEALTHY nodes, so a node that just failed its probe is excluded and a
  // transient SSH blip never reaps live containers. Gated OFF by default.
  if (config.orphanReconcilerEnabled) {
    await runBoundedPhase(
      logger,
      "orphan reconciler cycle",
      () => processOrphanReconcilerCycle(),
      (result) => {
        logger.info("[provisioning-worker] orphan reconciler cycle complete", {
          event: "orphan_reconciler.reaped",
          nodesScanned: result.nodesScanned,
          nodesSkipped: result.nodesSkipped,
          reaped: result.reaped,
          reapFailed: result.reapFailed,
        });
      },
    );

    // Apps (Product 2) sibling sweep — same `healthy`-only, fresh-node-status,
    // reap-by-id model. Runs right after the agent sweep so it shares the same
    // freshly-refreshed node health and the same `docker rm -f` gating.
    await runBoundedPhase(
      logger,
      "app orphan reconciler cycle",
      () => processAppOrphanReconcilerCycle(),
      (result) => {
        logger.info(
          "[provisioning-worker] app orphan reconciler cycle complete",
          {
            event: "app_orphan_reconciler.reaped",
            nodesScanned: result.nodesScanned,
            nodesSkipped: result.nodesSkipped,
            reaped: result.reaped,
            reapFailed: result.reapFailed,
          },
        );
      },
    );
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
    // Surface the claim scope: empty PROVISIONING_JOB_LANES → all 18 types.
    // When a dedicated apps daemon ships, pin this one to `agent`.
    jobLanes: process.env.PROVISIONING_JOB_LANES || "(all)",
    jobTypeCount: config.jobTypes.length,
    selfRestartEnabled: config.selfRestartEnabled,
    watchdogConsecutiveTicks: config.watchdogConsecutiveTicks,
    orphanReconcilerEnabled: config.orphanReconcilerEnabled,
  });

  await assertProvisioningWorkerPreflight();
  preflightOk = true;
  logger.info("[provisioning-worker] startup preflight passed");

  // Apps (Product 2): arm the deploy backend when enabled (gated; no-op by default).
  await armAppsDeployBackendIfEnabled(logger);

  // Seed the watchdog clock so a slow first cycle can't trip it immediately.
  lastCycleCompletedAt = Date.now();

  if (config.runOnce) {
    // Publish once so a --once invocation still reports liveness, then run a
    // single cycle. No interval needed for the one-shot path.
    await publishHeartbeat(logger);
    await pollCycle(logger, config);
    return;
  }

  // Decouple liveness from the work cycle: an independent timer publishes the
  // heartbeat every HEARTBEAT_INTERVAL_MS regardless of how long a single
  // cycle takes. Publish once immediately so there's no cold gap before the
  // first tick.
  await publishHeartbeat(logger);
  const heartbeatTimer = startHeartbeatInterval(logger, config);

  try {
    while (running) {
      await pollCycle(logger, config);
      if (running) {
        await sleep(config.pollIntervalMs);
      }
    }
  } finally {
    clearInterval(heartbeatTimer);
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
