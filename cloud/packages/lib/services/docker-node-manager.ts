/**
 * DockerNodeManager — Manages Docker VPS node pool for sandbox provisioning.
 *
 * Handles node selection (least-loaded), health checks, capacity reporting,
 * and allocation count synchronisation.
 *
 * Reference: eliza-cloud/backend/services/node-manager.ts
 */

import { dockerNodesRepository } from "@/db/repositories/docker-nodes";
import type { DockerNode, DockerNodeStatus } from "@/db/schemas/docker-nodes";
import { countAllocatedWorkloadsOnNode } from "@/lib/services/docker-node-workloads";
import { DockerSSHClient } from "@/lib/services/docker-ssh";
import { logger } from "@/lib/utils/logger";
import { containersEnv } from "../config/containers-env";
import {
  dockerPlatformFlag,
  inferNodeArchitectureFromMetadata,
  isArchitectureCompatibleWithPlatform,
  normalizeDockerArchitecture,
  requiredArchitectureForPlatform,
  shellQuote,
} from "./docker-sandbox-utils";

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
        const ssh = DockerSSHClient.getClient(
          node.hostname,
          node.ssh_port ?? undefined,
          node.host_key_fingerprint ?? undefined,
          node.ssh_user ?? undefined,
        );
        await ssh.connect();
        const dockerId = await ssh.exec("docker info --format '{{.ID}}'", 10_000);

        if (dockerId.trim()) {
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

    // Canonical (operator-managed) nodes are never marked offline from
    // health-check failures. The autoscaler-provisioned hetzner-cloud nodes
    // are ephemeral and OK to flap; manually-provisioned cores host long-lived
    // production sandboxes, where a transient ssh hiccup should not pull the
    // node out of rotation. Operators retain explicit `enabled=false` to
    // disable nodes; status flapping is reserved for autoscaler-managed nodes.
    if (!isAutoscaledNode(node)) {
      logger.warn(
        `[docker-node-manager] Suppressed ${status} status for canonical node ${node.node_id} (${node.hostname}); leaving prior status (${node.status}) intact. Set enabled=false to remove from rotation.`,
      );
      return node.status;
    }

    await dockerNodesRepository.updateStatus(node.node_id, status);
    return status;
  }

  /**
   * Single-attempt readiness probe used during scheduling. This prevents stale
   * healthy rows from receiving new work when SSH credentials or the Docker
   * daemon are no longer valid.
   */
  async ensureNodeReady(node: DockerNode, options: NodeSelectionOptions = {}): Promise<boolean> {
    try {
      const ssh = DockerSSHClient.getClient(
        node.hostname,
        node.ssh_port ?? undefined,
        node.host_key_fingerprint ?? undefined,
        node.ssh_user ?? undefined,
      );
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

        try {
          const ssh = DockerSSHClient.getClient(
            node.hostname,
            node.ssh_port ?? undefined,
            node.host_key_fingerprint ?? undefined,
            node.ssh_user ?? undefined,
          );
          await ssh.connect();
          await ssh.exec(
            ["docker pull", ...dockerPlatformFlag(platform), shellQuote(image)].join(" "),
            5 * 60 * 1000,
          );
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

  // ---- Runtime Container Inspection -------------------------------------

  /**
   * List running containers on a node via SSH.
   * Returns container names matching the sandbox pattern.
   */
  async getRuntimeContainers(
    node: DockerNode,
  ): Promise<{ name: string; id: string; state: string; status: string }[] | null> {
    try {
      const ssh = DockerSSHClient.getClient(
        node.hostname,
        node.ssh_port ?? undefined,
        node.host_key_fingerprint ?? undefined,
        node.ssh_user ?? undefined,
      );
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
