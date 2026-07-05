/**
 * DockerNodeManager — Manages Docker VPS node pool for sandbox provisioning.
 *
 * Handles node selection (least-loaded), health checks, capacity reporting,
 * and allocation count synchronisation.
 *
 * Reference: eliza-cloud/backend/services/node-manager.ts
 */

import crypto from "node:crypto";
import { dockerNodesRepository } from "../../db/repositories/docker-nodes";
import type { DockerNode, DockerNodeStatus } from "../../db/schemas/docker-nodes";
import { containersEnv } from "../config/containers-env";
import { logger } from "../utils/logger";
import { countAllocatedWorkloadsOnNode } from "./docker-node-workloads";
import {
  dockerPlatformFlag,
  inferNodeArchitectureFromMetadata,
  isArchitectureCompatibleWithPlatform,
  normalizeDockerArchitecture,
  requiredArchitectureForPlatform,
  shellQuote,
} from "./docker-sandbox-utils";
import { DockerSSHClient } from "./docker-ssh";
import { type DiskHealthVerdict, diskHealthVerdict, probeNodeDiskUsage } from "./node-disk-manager";

// ---------------------------------------------------------------------------
// Pre-pull self-heal bookkeeping (see recoverAfterTimedOutPrePull)
// ---------------------------------------------------------------------------

/** Per-node consecutive pre-pull failures + last auto-heal timestamp. Cleared
 * on the first successful pull. In-memory: the provisioning worker is a single
 * long-lived process, and a restart is itself a clean slate. */
const prePullFailureState = new Map<
  string,
  { consecutiveFailures: number; lastSelfHealMs: number }
>();
/** Consecutive failed pre-pulls on a node before an auto docker restart. */
const PREPULL_SELF_HEAL_FAILURE_THRESHOLD = 2;
/** Minimum gap between auto docker restarts on the same node (anti-restart-loop). */
const PREPULL_SELF_HEAL_COOLDOWN_MS = 30 * 60 * 1000;
const PREPULL_PID_DIR = "/tmp";

// ---------------------------------------------------------------------------
// Health-check failure tracking (auto-disable a dead node)
// ---------------------------------------------------------------------------

/**
 * Consecutive failed health checks (across cycles) before a node is auto-disabled.
 *
 * Derived IN-MEMORY rather than via a new schema column: the provisioning
 * worker is a single long-lived process that owns the health loop, a restart is
 * a legitimate clean slate (the node gets re-probed and either re-fails toward
 * the threshold again or recovers), and this avoids a schema migration on the
 * hot health-check write path. Cleared on the first successful check.
 *
 * Overridable via `CONTAINERS_NODE_HEALTH_FAILURE_THRESHOLD` for ops tuning;
 * default 3 (≈ three full retry-exhausted cycles) balances not flapping on a
 * transient SSH hiccup against not stranding a genuinely dead node in rotation.
 */
const NODE_HEALTH_FAILURE_THRESHOLD = (() => {
  const raw = process.env.CONTAINERS_NODE_HEALTH_FAILURE_THRESHOLD;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 3;
})();

/** Per-node consecutive failed health checks. In-memory (see threshold docs). */
const nodeHealthFailureState = new Map<string, number>();

export function __resetNodeHealthFailureStateForTests(): void {
  nodeHealthFailureState.clear();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NodeCapacityReport {
  nodeId: string;
  hostname: string;
  capacity: number;
  allocated: number;
  available: number;
  status: DockerNodeStatus;
  enabled: boolean;
  lastHealthCheck: Date | null;
}

export interface CapacitySummary {
  totalCapacity: number;
  totalAllocated: number;
  totalAvailable: number;
  nodes: NodeCapacityReport[];
}

export interface NodeSelectionOptions {
  /** Docker image platform the selected node must be able to run. */
  requiredPlatform?: string | null;
  /**
   * Skip this node when picking a target. Used by the fleet-upgrade handler
   * to force a blue/green swap onto a *different* node than the one the
   * agent is currently on, because Docker container names are unique per
   * docker daemon and the deterministic name `agent-${id}` would collide
   * if the blue landed on the same node as the old.
   */
  excludeNodeId?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Whether a node was provisioned by the autoscaler (Hetzner Cloud) and is
 * therefore safe to mark offline on health-check failure. Canonical cores
 * (manually-provisioned, no `provider` metadata, or any non-autoscaled
 * provider) are protected — they remain healthy in DB even if a transient
 * ssh probe fails, because flapping them removes real production capacity.
 *
 * Operators always have `enabled=false` to disable a node explicitly.
 */
function isAutoscaledNode(node: DockerNode): boolean {
  const meta = node.metadata as Record<string, unknown> | null | undefined;
  if (!meta || typeof meta !== "object") return false;
  return meta.provider === "hetzner-cloud" && meta.autoscaled === true;
}

function prePullPidFile(marker: string): string {
  return `${PREPULL_PID_DIR}/eliza-prepull-${marker}.pid`;
}

export function isPrePullTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Command timed out after");
}

export function buildTrackedPrePullCommand(
  image: string,
  platform: string | null | undefined,
  marker = crypto.randomUUID(),
): { command: string; pidFile: string } {
  const pidFile = prePullPidFile(marker);
  const pullCommand = ["docker pull", ...dockerPlatformFlag(platform), shellQuote(image)].join(" ");
  const script = [
    `pidfile=${shellQuote(pidFile)}`,
    'rm -f "$pidfile"',
    `(${pullCommand}) &`,
    "pid=$!",
    'printf "%s\\n" "$pid" > "$pidfile"',
    'wait "$pid"',
    "status=$?",
    'rm -f "$pidfile"',
    'exit "$status"',
  ].join("; ");
  return { command: `sh -c ${shellQuote(script)}`, pidFile };
}

export function buildPrePullReapCommand(pidFile: string, image: string): string {
  const quotedImage = shellQuote(image);
  const script = [
    `pidfile=${shellQuote(pidFile)}`,
    'if [ -s "$pidfile" ]; then',
    'pid="$(cat "$pidfile" 2>/dev/null || true)"',
    'case "$pid" in ""|*[!0-9]*) rm -f "$pidfile"; exit 0 ;; esac',
    'cmdline="$(tr "\\0" " " < "/proc/$pid/cmdline" 2>/dev/null || true)"',
    `if printf "%s\\n" "$cmdline" | grep -F "docker pull" >/dev/null && printf "%s\\n" "$cmdline" | grep -F -- ${quotedImage} >/dev/null; then`,
    'kill -9 "$pid" 2>/dev/null || true',
    "fi",
    'rm -f "$pidfile"',
    "fi",
  ].join("; ");
  return `sh -c ${shellQuote(script)}`;
}

export function buildPrePullSelfHealRecoverCommand(): string {
  return [
    "systemctl kill -s SIGKILL docker.service docker.socket 2>/dev/null",
    "sleep 2",
    "systemctl restart containerd 2>/dev/null",
    "sleep 4",
    "systemctl reset-failed docker.service 2>/dev/null",
    "systemctl start docker.service",
  ].join("; ");
}

export function __resetPrePullFailureStateForTests(): void {
  prePullFailureState.clear();
}

// ---------------------------------------------------------------------------
// DockerNodeManager
// ---------------------------------------------------------------------------

export class DockerNodeManager {
  private static instance: DockerNodeManager;

  private constructor() {}

  static getInstance(): DockerNodeManager {
    if (!DockerNodeManager.instance) {
      DockerNodeManager.instance = new DockerNodeManager();
    }
    return DockerNodeManager.instance;
  }

  // ---- Node Selection ---------------------------------------------------

  /**
   * Find the least-loaded healthy node with available capacity.
   * Returns null if no capacity is available.
   */
  async getAvailableNode(options: NodeSelectionOptions = {}): Promise<DockerNode | null> {
    const nodes = await dockerNodesRepository.findEnabled();
    const candidates = (
      await Promise.all(
        nodes.map(async (node) => {
          const allocated = await countAllocatedWorkloadsOnNode(node.node_id);
          const canProbeForCapacity = node.status !== "offline";
          return {
            node,
            allocated,
            available: canProbeForCapacity ? Math.max(0, node.capacity - allocated) : 0,
          };
        }),
      )
    )
      .filter((candidate) => candidate.available > 0)
      .filter((candidate) => candidate.node.node_id !== options.excludeNodeId)
      .sort((a, b) => b.available - a.available);

    for (const candidate of candidates) {
      if (!isNodeMetadataCompatible(candidate.node, options.requiredPlatform)) {
        logger.warn("[docker-node-manager] Skipping node with incompatible architecture", {
          nodeId: candidate.node.node_id,
          requiredPlatform: options.requiredPlatform,
          metadata: candidate.node.metadata,
        });
        continue;
      }
      if (!(await this.ensureNodeReady(candidate.node, options))) {
        continue;
      }
      logger.info(
        `[docker-node-manager] Selected node ${candidate.node.node_id} (${candidate.allocated}/${candidate.node.capacity} used)`,
      );
      return { ...candidate.node, allocated_count: candidate.allocated };
    }

    logger.warn("[docker-node-manager] No reachable healthy nodes with capacity");
    return null;
  }

  /**
   * Get node configuration by node_id.
   */
  async getNodeConfig(nodeId: string): Promise<DockerNode | null> {
    return dockerNodesRepository.findByNodeId(nodeId);
  }

  // ---- SSH client construction ------------------------------------------

  /**
   * Build a pooled SSH client for a node, wiring the Trust-On-First-Use
   * persist callback: when the node's `host_key_fingerprint` is NULL, the
   * client accepts the presented key on first connect and this callback pins it
   * to `docker_nodes` (idempotent, NULL-guarded in the repo) so every later
   * connect verifies against a real fingerprint. Passing `host_key_fingerprint`
   * from the row keeps strict verification once a pin exists.
   */
  private sshClientForNode(node: DockerNode): DockerSSHClient {
    return DockerSSHClient.getClient(
      node.hostname,
      node.ssh_port ?? undefined,
      node.host_key_fingerprint ?? undefined,
      node.ssh_user ?? undefined,
      node.host_key_fingerprint
        ? undefined
        : async (hostname, fingerprint) => {
            await dockerNodesRepository.setHostKeyFingerprint(node.node_id, fingerprint);
            logger.warn(
              `[docker-node-manager] TOFU-pinned host key for node ${node.node_id} (${hostname}): SHA256:${fingerprint}`,
            );
          },
    );
  }

  // ---- Health Checks ----------------------------------------------------

  /**
   * Run health checks on all enabled nodes.
   * SSH into each node, verify Docker daemon is responsive, update status.
   */
  async healthCheckAll(): Promise<Map<string, DockerNodeStatus>> {
    const nodes = await dockerNodesRepository.findEnabled();
    const results = new Map<string, DockerNodeStatus>();

    const checks = nodes.map(async (node) => {
      const status = await this.healthCheckNode(node);
      results.set(node.node_id, status);
    });

    await Promise.allSettled(checks);
    return results;
  }

  /**
   * Health-check a single node via SSH.
   * Verifies Docker daemon is running by executing `docker info --format '{{.ID}}'`.
   * Retries up to MAX_RETRIES times before marking the node offline.
   */
  async healthCheckNode(node: DockerNode): Promise<DockerNodeStatus> {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 3_000;
    // Worst-case per node: MAX_RETRIES * (SSH_TIMEOUT + RETRY_DELAY) ≈ 39s with defaults
    let lastError: string = "";

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const ssh = this.sshClientForNode(node);
        await ssh.connect();
        const dockerId = await ssh.exec("docker info --format '{{.ID}}'", 10_000);

        if (dockerId.trim()) {
          // Disk-aware verdict: a node whose Docker daemon answers but whose
          // disk is critically full still can't pull images or provision agents
          // (`no space left on device`). Mark it `degraded` so the scheduler
          // stops placing on it (available only counts `healthy`) and the
          // autoscaler sees lost capacity and provisions a replacement. Probed
          // AFTER `docker info` confirmed reachability; a failed df read is
          // treated as `ok` (returns null → `ok`) so disk never owns
          // reachability — the docker-info probe does.
          const diskStatus = await this.diskHealthStatus(node);
          if (diskStatus === "critical") {
            // Only autoscaler-managed nodes are safe to drain on disk pressure:
            // the autoscaler replaces them, so `degraded` trades a full node for
            // a fresh one. Canonical (operator-managed) cores are NEVER
            // autoscaler-replaced AND the disk-clean cycle skips non-healthy
            // nodes — so marking a canonical node `degraded` would strand it
            // full with no automated remediation. Keep it `healthy` so the
            // disk-clean manager prunes it next cycle (the real fix) and surface
            // the pressure loudly for operators.
            if (isAutoscaledNode(node)) {
              logger.warn(
                `[docker-node-manager] Node ${node.node_id} (${node.hostname}) is reachable but disk is critically full; marking degraded so it drains/replaces instead of taking new work.`,
              );
              await dockerNodesRepository.updateStatus(node.node_id, "degraded");
              return "degraded";
            }
            logger.warn(
              `[docker-node-manager] Canonical node ${node.node_id} (${node.hostname}) is reachable but disk is critically full; leaving healthy so the disk-clean cycle can reclaim space (canonical nodes are not autoscaler-replaced). Operators: free space or set enabled=false.`,
            );
          }
          // A reachable node clears any accumulated consecutive-failure count so
          // one recovered cycle undoes prior transient failures.
          nodeHealthFailureState.delete(node.node_id);
          await dockerNodesRepository.updateStatus(node.node_id, "healthy");
          return "healthy";
        } else {
          lastError = "Docker returned empty ID";
        }
      } catch (error: unknown) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < MAX_RETRIES) {
          logger.warn(
            `[docker-node-manager] Health check attempt ${attempt}/${MAX_RETRIES} failed for ${node.node_id}: ${lastError}, retrying in ${RETRY_DELAY_MS}ms`,
          );
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
      }
    }

    // All retries exhausted
    logger.warn(
      `[docker-node-manager] Health check failed for ${node.node_id} after ${MAX_RETRIES} attempts: ${lastError}`,
    );
    const status: DockerNodeStatus = lastError.includes("empty ID") ? "degraded" : "offline";

    // A `degraded` verdict means the daemon ANSWERED but returned no ID — the
    // node is reachable, just unhealthy. Persist it and let the disk-clean /
    // autoscaler paths handle it; it is not a "dead node" for auto-disable
    // purposes, so it never accrues toward the disable threshold. Because the
    // node WAS reachable this cycle, clear the consecutive-offline counter so a
    // reachable-but-degraded cycle breaks the "N consecutive UNREACHABLE checks"
    // streak (otherwise offline, offline, degraded, offline would wrongly disable).
    if (status === "degraded") {
      nodeHealthFailureState.delete(node.node_id);
      await dockerNodesRepository.updateStatus(node.node_id, "degraded");
      return "degraded";
    }

    // `offline` = unreachable. Previously we SUPPRESSED offline for canonical
    // (operator-managed) nodes to avoid flapping on a transient SSH hiccup —
    // but that let a genuinely-dead node keep reporting `healthy` forever, so
    // the scheduler kept routing agents onto a black hole. Replace that mask
    // with consecutive-failure tracking: persist `offline` every cycle, and
    // once a node has failed the reachability probe N cycles in a row (default
    // 3), auto-disable it (enabled=false) so it leaves rotation, with a loud
    // ERROR so operators are paged. A dead node must NEVER report healthy.
    const consecutive = (nodeHealthFailureState.get(node.node_id) ?? 0) + 1;
    nodeHealthFailureState.set(node.node_id, consecutive);

    if (consecutive >= NODE_HEALTH_FAILURE_THRESHOLD) {
      logger.error(
        `[docker-node-manager] Node ${node.node_id} (${node.hostname}) unreachable for ${consecutive} consecutive health checks (threshold ${NODE_HEALTH_FAILURE_THRESHOLD}); auto-disabling (enabled=false, status=offline) and routing it out of the pool. Last error: ${lastError}. Operator action required to re-enable.`,
        {
          nodeId: node.node_id,
          hostname: node.hostname,
          consecutiveFailures: consecutive,
          threshold: NODE_HEALTH_FAILURE_THRESHOLD,
        },
      );
      await dockerNodesRepository.markOfflineAndDisable(node.node_id);
      nodeHealthFailureState.delete(node.node_id);
      return "offline";
    }

    logger.warn(
      `[docker-node-manager] Node ${node.node_id} (${node.hostname}) unreachable (${consecutive}/${NODE_HEALTH_FAILURE_THRESHOLD} consecutive failures); marking offline. Will auto-disable if it keeps failing.`,
    );
    await dockerNodesRepository.updateStatus(node.node_id, "offline");
    return "offline";
  }

  /**
   * Disk-aware health sub-verdict for a node already confirmed reachable. Reads
   * `df` over the shared SSH pool and applies the pure {@link diskHealthVerdict}
   * against `NODE_DISK_UNHEALTHY_THRESHOLD_PCT`. A failed df read yields `ok`
   * (null usage) so disk never owns reachability — the `docker info` probe does.
   * Isolated so a df hiccup can never throw out of the health check.
   */
  async diskHealthStatus(node: DockerNode): Promise<DiskHealthVerdict> {
    try {
      const usedPercent = await probeNodeDiskUsage(node);
      return diskHealthVerdict(usedPercent, containersEnv.nodeDiskUnhealthyThresholdPct());
    } catch (error) {
      logger.warn("[docker-node-manager] Disk health probe failed; treating as ok", {
        nodeId: node.node_id,
        hostname: node.hostname,
        error: error instanceof Error ? error.message : String(error),
      });
      return "ok";
    }
  }

  /**
   * Single-attempt readiness probe used during scheduling. This prevents stale
   * healthy rows from receiving new work when SSH credentials or the Docker
   * daemon are no longer valid.
   */
  async ensureNodeReady(node: DockerNode, options: NodeSelectionOptions = {}): Promise<boolean> {
    try {
      const ssh = this.sshClientForNode(node);
      await ssh.connect();
      const dockerInfo = await ssh.exec("docker info --format '{{.ID}}|{{.Architecture}}'", 10_000);
      const { dockerId, architecture } = parseDockerInfoProbe(dockerInfo);
      if (dockerId.trim()) {
        if (
          !isArchitectureCompatibleWithPlatform(architecture, options.requiredPlatform) &&
          requiredArchitectureForPlatform(options.requiredPlatform)
        ) {
          logger.warn("[docker-node-manager] Node is reachable but incompatible with image", {
            nodeId: node.node_id,
            architecture,
            requiredPlatform: options.requiredPlatform,
          });
          return false;
        }
        await dockerNodesRepository.updateStatus(node.node_id, "healthy");
        return true;
      }
      if (isAutoscaledNode(node)) {
        await dockerNodesRepository.updateStatus(node.node_id, "degraded");
      } else {
        logger.warn(
          `[docker-node-manager] Suppressed degraded mark for canonical node ${node.node_id} (${node.hostname}); Docker probe returned empty ID`,
        );
      }
      logger.warn(`[docker-node-manager] Node ${node.node_id} Docker probe returned empty ID`);
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // See healthCheckNode for rationale: canonical nodes are never marked
      // offline from a transient ssh failure during scheduling.
      if (isAutoscaledNode(node)) {
        await dockerNodesRepository.updateStatus(node.node_id, "offline").catch((updateError) => {
          logger.warn("[docker-node-manager] Failed to mark node offline", {
            nodeId: node.node_id,
            error: updateError instanceof Error ? updateError.message : String(updateError),
          });
        });
      } else {
        logger.warn(
          `[docker-node-manager] Suppressed offline mark for canonical node ${node.node_id} (${node.hostname}): ${message}`,
        );
      }
      logger.warn(`[docker-node-manager] Node ${node.node_id} is not reachable: ${message}`);
      return false;
    }
  }

  // ---- Capacity Reporting -----------------------------------------------

  /**
   * Get a full capacity report across all nodes.
   */
  async getCapacityReport(): Promise<CapacitySummary> {
    const nodes = await dockerNodesRepository.findAll();
    const allocatedByNode = new Map(
      await Promise.all(
        nodes.map(
          async (node) =>
            [node.node_id, await countAllocatedWorkloadsOnNode(node.node_id)] as const,
        ),
      ),
    );

    const nodeReports: NodeCapacityReport[] = nodes.map((node) => ({
      nodeId: node.node_id,
      hostname: node.hostname,
      capacity: node.capacity,
      allocated: allocatedByNode.get(node.node_id) ?? node.allocated_count,
      available:
        node.enabled && node.status === "healthy"
          ? Math.max(0, node.capacity - (allocatedByNode.get(node.node_id) ?? node.allocated_count))
          : 0,
      status: node.status,
      enabled: node.enabled,
      lastHealthCheck: node.last_health_check,
    }));

    const enabledNodes = nodeReports.filter((n) => n.enabled && n.status === "healthy");

    return {
      totalCapacity: enabledNodes.reduce((sum, n) => sum + n.capacity, 0),
      totalAllocated: enabledNodes.reduce((sum, n) => sum + n.allocated, 0),
      totalAvailable: enabledNodes.reduce((sum, n) => sum + n.available, 0),
      nodes: nodeReports,
    };
  }

  // ---- Allocation Sync --------------------------------------------------

  /**
   * Count actual active workloads per node from the database and reconcile
   * allocated_count in docker_nodes.
   *
   * The Docker pool is shared by user `containers` and managed
   * `agent_sandboxes`; both must be counted or the scheduler can overfill a
   * node or drain a node that still has agent workloads.
   */
  async syncAllocatedCounts(): Promise<Map<string, { before: number; after: number }>> {
    const nodes = await dockerNodesRepository.findEnabled();
    const changes = new Map<string, { before: number; after: number }>();

    for (const node of nodes) {
      const actualCount = await countAllocatedWorkloadsOnNode(node.node_id);

      if (actualCount !== node.allocated_count) {
        logger.info(
          `[docker-node-manager] Sync ${node.node_id}: allocated_count ${node.allocated_count} → ${actualCount}`,
        );
        await dockerNodesRepository.setAllocatedCount(node.node_id, actualCount);
        changes.set(node.node_id, {
          before: node.allocated_count,
          after: actualCount,
        });
      }
    }

    if (changes.size > 0) {
      logger.info(`[docker-node-manager] Synced allocated counts for ${changes.size} node(s)`);
    }

    return changes;
  }

  /**
   * Pre-pull the agent image on healthy nodes with spare capacity so a
   * subsequent agent provision does not pay the Docker image cold-start cost.
   */
  async prePullAgentImageOnAvailableNodes(
    image = containersEnv.defaultAgentImage(),
    platform = containersEnv.defaultAgentImagePlatform(),
  ): Promise<
    Array<{
      nodeId: string;
      hostname: string;
      available: number;
      status: "pulled" | "skipped" | "failed";
      reason?: string;
      error?: string;
    }>
  > {
    const nodes = await dockerNodesRepository.findEnabled();

    return Promise.all(
      nodes.map(async (node) => {
        const allocated = await countAllocatedWorkloadsOnNode(node.node_id);
        const available = Math.max(0, node.capacity - allocated);

        if (node.status !== "healthy") {
          return {
            nodeId: node.node_id,
            hostname: node.hostname,
            available,
            status: "skipped" as const,
            reason: `node status is ${node.status}`,
          };
        }

        if (available <= 0) {
          return {
            nodeId: node.node_id,
            hostname: node.hostname,
            available,
            status: "skipped" as const,
            reason: "no spare slots",
          };
        }

        if (!isNodeMetadataCompatible(node, platform)) {
          return {
            nodeId: node.node_id,
            hostname: node.hostname,
            available,
            status: "skipped" as const,
            reason: `node architecture is incompatible with ${platform}`,
          };
        }

        const ssh = this.sshClientForNode(node);
        const prePull = buildTrackedPrePullCommand(image, platform);
        try {
          await ssh.connect();
          await ssh.exec(prePull.command, 5 * 60 * 1000);
          // Success: clear any prior wedge / self-heal bookkeeping for this node.
          prePullFailureState.delete(node.node_id);
          return {
            nodeId: node.node_id,
            hostname: node.hostname,
            available,
            status: "pulled" as const,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn("[docker-node-manager] Agent image pre-pull failed", {
            nodeId: node.node_id,
            image,
            error: message,
          });
          if (isPrePullTimeoutError(error)) {
            // A timed-out `docker pull` is NOT stopped by DockerSSHClient's
            // channel-close (that only sends SIGHUP, which a detached `docker
            // pull` ignores), so it can keep running. The tracked wrapper leaves
            // a PID file only for this pre-pull, so recovery does not kill
            // unrelated deployment pulls on the same node.
            await this.recoverAfterTimedOutPrePull(ssh, node, prePull.pidFile, image);
          } else {
            prePullFailureState.delete(node.node_id);
          }
          return {
            nodeId: node.node_id,
            hostname: node.hostname,
            available,
            status: "failed" as const,
            error: message,
          };
        }
      }),
    );
  }

  /**
   * Cleanup + optional self-heal after a pre-pull times out on a node.
   *
   * (a) SIGKILL only the PID recorded by the timed-out pre-pull wrapper, after
   *     verifying the process is still a `docker pull` for the same image.
   * (b) If a node keeps failing (its daemon is already wedged) and self-heal
   *     is enabled, restart docker once per cooldown to recover automatically
   *     instead of paging an operator. `live-restore` (node bootstrap
   *     daemon.json) keeps running agent containers alive across the restart.
   */
  private async recoverAfterTimedOutPrePull(
    ssh: DockerSSHClient,
    node: DockerNode,
    pidFile: string,
    image: string,
  ): Promise<void> {
    try {
      await ssh.exec(buildPrePullReapCommand(pidFile, image), 20_000);
    } catch (killError) {
      // error-policy:J6 best-effort timeout orphan cleanup; the pre-pull has
      // already failed and the next cycle can retry the scoped PID reap.
      logger.warn(
        "[docker-node-manager] Failed to reap orphaned docker pull after pre-pull failure",
        {
          nodeId: node.node_id,
          error: killError instanceof Error ? killError.message : String(killError),
        },
      );
    }

    // (b) Track consecutive failures; auto-recover a wedged daemon when enabled.
    const state = prePullFailureState.get(node.node_id) ?? {
      consecutiveFailures: 0,
      lastSelfHealMs: 0,
    };
    state.consecutiveFailures += 1;
    prePullFailureState.set(node.node_id, state);

    if (!containersEnv.prePullSelfHealRestartEnabled()) return;
    if (state.consecutiveFailures < PREPULL_SELF_HEAL_FAILURE_THRESHOLD) return;
    if (Date.now() - state.lastSelfHealMs < PREPULL_SELF_HEAL_COOLDOWN_MS) return;

    logger.error(
      "[docker-node-manager] Pre-pull wedged repeatedly; auto-restarting docker to self-heal",
      {
        nodeId: node.node_id,
        hostname: node.hostname,
        consecutiveFailures: state.consecutiveFailures,
      },
    );
    try {
      // Live staging showed graceful `systemctl restart docker` can hang when
      // dockerd/containerd content ingest is already wedged. Stamp the cooldown
      // before attempting the shared-host recovery, then force-kill dockerd and
      // bounce containerd; live-restore plus container shims keep agents alive.
      state.lastSelfHealMs = Date.now();
      prePullFailureState.set(node.node_id, state);
      await ssh.exec(buildPrePullSelfHealRecoverCommand(), 120_000);
      state.consecutiveFailures = 0;
      prePullFailureState.set(node.node_id, state);
    } catch (restartError) {
      // error-policy:J6 best-effort node self-heal; failure is visible in logs
      // and the cooldown/threshold state lets a later cycle retry.
      logger.error("[docker-node-manager] Self-heal docker restart failed", {
        nodeId: node.node_id,
        error: restartError instanceof Error ? restartError.message : String(restartError),
      });
    }
  }

  // ---- Runtime Container Inspection -------------------------------------

  /**
   * List running containers on a node via SSH.
   * Returns container names matching the sandbox pattern.
   */
  async getRuntimeContainers(
    node: DockerNode,
  ): Promise<{ name: string; id: string; state: string; status: string }[] | null> {
    try {
      const ssh = this.sshClientForNode(node);
      await ssh.connect();

      const output = await ssh.exec(
        "docker ps -a --format '{{.Names}}|{{.ID}}|{{.State}}|{{.Status}}'",
        15_000,
      );

      return output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [name = "", id = "", state = "", status = ""] = line.split("|");
          return { name, id, state: state.toLowerCase(), status };
        });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[docker-node-manager] Failed to list containers on ${node.node_id}: ${msg}`);
      return null;
    }
  }
}

export const dockerNodeManager = DockerNodeManager.getInstance();

function isNodeMetadataCompatible(
  node: DockerNode,
  requiredPlatform: string | undefined | null,
): boolean {
  if (!requiredArchitectureForPlatform(requiredPlatform)) return true;
  return isArchitectureCompatibleWithPlatform(
    inferNodeArchitectureFromMetadata(node.metadata),
    requiredPlatform,
  );
}

function parseDockerInfoProbe(output: string): {
  dockerId: string;
  architecture: ReturnType<typeof normalizeDockerArchitecture>;
} {
  const lines = output
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  let line = "";
  for (let index = lines.length - 1; index >= 0; index--) {
    const candidate = lines[index]!;
    if (!candidate.startsWith("[stderr]")) {
      line = candidate;
      break;
    }
  }
  const [dockerId = "", rawArchitecture = ""] = line.split("|");
  return {
    dockerId,
    architecture: normalizeDockerArchitecture(rawArchitecture),
  };
}
