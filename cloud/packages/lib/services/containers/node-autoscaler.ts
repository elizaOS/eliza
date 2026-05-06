/**
 * Node autoscaler.
 *
 * Decides when to scale the Hetzner-Docker pool up or down. Scope is
 * deliberately narrow: this module owns capacity evaluation and the
 * `provisionNode` / `drainNode` workflows. Concrete API + cron handlers
 * call these methods.
 *
 * Safety properties:
 *  - Stateful workloads with `volume_path` set are NEVER auto-evicted.
 *    Scale-down only deprovisions nodes that have zero containers (any
 *    status) pinned to them.
 *  - Provisioning is rate-limited per-call: each invocation provisions
 *    at most one node. The cron runs frequently enough that bursty
 *    demand still scales up within a couple of minutes.
 *  - Cooldown windows on both directions stop us oscillating between
 *    provision and drain.
 */

import { dockerNodesRepository } from "@/db/repositories/docker-nodes";
import type { DockerNode } from "@/db/schemas/docker-nodes";
import { containersEnv } from "@/lib/config/containers-env";
import {
  getHetznerCloudClient,
  HetznerCloudError,
  isHetznerCloudConfigured,
} from "@/lib/services/containers/hetzner-cloud-api";
import {
  buildContainerNodeUserData,
  type NodeBootstrapInput,
} from "@/lib/services/containers/node-bootstrap";
import {
  countAllocatedWorkloadsOnNode,
  countRetainedWorkloadsOnNode,
} from "@/lib/services/docker-node-workloads";
import { logger } from "@/lib/utils/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutoscalePolicy {
  /** Free slots that must remain across the pool before we provision a new node. */
  minFreeSlotsBuffer: number;
  /** Emergency floor for hot agent starts; bypasses cooldown if availability drops below it. */
  minHotAvailableSlots: number;
  /** Hard cap on enabled nodes; never provision past this number. */
  maxNodes: number;
  /** Cooldown after the most recent provision before another one is allowed. */
  scaleUpCooldownMs: number;
  /** Minimum age of an idle node before it becomes eligible for drain. */
  idleNodeMinAgeMs: number;
  /** Server type purchased for new bursts (e.g. "cax21" arm64, "cpx31" x86). */
  defaultServerType: string;
  /** Datacenter for new bursts (e.g. "fsn1", "nbg1"). */
  defaultLocation: string;
  /** Image used for the OS install (cloud-init compatible). */
  defaultImage: string;
  /** Default per-node capacity (slot count) for newly provisioned nodes. */
  defaultCapacity: number;
}

export const DEFAULT_AUTOSCALE_POLICY: AutoscalePolicy = {
  minFreeSlotsBuffer: 4,
  minHotAvailableSlots: 1,
  maxNodes: 12,
  scaleUpCooldownMs: 5 * 60 * 1000,
  idleNodeMinAgeMs: 30 * 60 * 1000,
  defaultServerType: "cax21",
  defaultLocation: "fsn1",
  defaultImage: "ubuntu-24.04",
  defaultCapacity: 8,
};

export interface CapacityDecision {
  totalCapacity: number;
  totalAllocated: number;
  totalAvailable: number;
  enabledNodeCount: number;
  healthyNodeCount: number;
  shouldScaleUp: boolean;
  shouldScaleDownNodeIds: string[];
  reason: string;
}

export interface ProvisionRequest {
  /** Logical id assigned to the new node (defaults to a generated value). */
  nodeId?: string;
  serverType?: string;
  location?: string;
  image?: string;
  capacity?: number;
  /** Override prepull set; defaults to the configured default agent image. */
  prePullImages?: string[];
  /** Free-form labels attached to the Hetzner server (for bookkeeping). */
  labels?: Record<string, string>;
}

export interface ProvisionResult {
  nodeId: string;
  hostname: string;
  hcloudServerId: number;
  rootPassword: string | null;
}

export interface DrainOptions {
  /**
   * If true, deprovision the underlying Hetzner Cloud server after the
   * node is fully empty. Otherwise the node is just marked disabled.
   */
  deprovision?: boolean;
}

// ---------------------------------------------------------------------------
// NodeAutoscaler
// ---------------------------------------------------------------------------

export class NodeAutoscaler {
  constructor(
    private readonly policy: AutoscalePolicy = DEFAULT_AUTOSCALE_POLICY,
    private readonly nowFn: () => number = () => Date.now(),
  ) {}

  /**
   * Inspect current pool state and return a decision: should we scale up,
   * should we drain anyone, or are we steady? Pure read; no side effects.
   */
  async evaluateCapacity(): Promise<CapacityDecision> {
    const nodes = await dockerNodesRepository.findAll();
    const enabled = nodes.filter((n) => n.enabled);
    const healthyEnabled = enabled.filter((n) => n.status === "healthy");
    const allocatedByNode = new Map(
      await Promise.all(
        healthyEnabled.map(
          async (node) =>
            [node.node_id, await countAllocatedWorkloadsOnNode(node.node_id)] as const,
        ),
      ),
    );

    const totalCapacity = healthyEnabled.reduce((sum, n) => sum + n.capacity, 0);
    const totalAllocated = healthyEnabled.reduce(
      (sum, n) => sum + (allocatedByNode.get(n.node_id) ?? n.allocated_count),
      0,
    );
    const totalAvailable = healthyEnabled.reduce(
      (sum, n) =>
        sum + Math.max(0, n.capacity - (allocatedByNode.get(n.node_id) ?? n.allocated_count)),
      0,
    );

    const recentlyProvisioned = enabled.some(
      (n) => this.nowFn() - n.created_at.getTime() < this.policy.scaleUpCooldownMs,
    );

    const belowHotFloor = totalAvailable < this.policy.minHotAvailableSlots;
    const belowBuffer = totalAvailable < this.policy.minFreeSlotsBuffer;
    const shouldScaleUp =
      enabled.length < this.policy.maxNodes &&
      belowBuffer &&
      (!recentlyProvisioned || belowHotFloor);

    const drainCandidates = await this.findDrainCandidates(enabled);

    let reason = "steady";
    if (shouldScaleUp) {
      reason = belowHotFloor
        ? `available ${totalAvailable} < hot floor ${this.policy.minHotAvailableSlots}`
        : `available ${totalAvailable} < buffer ${this.policy.minFreeSlotsBuffer} (cooldown ok)`;
    } else if (drainCandidates.length > 0) {
      reason = `${drainCandidates.length} idle node(s) eligible for drain`;
    } else if (recentlyProvisioned && belowBuffer) {
      reason = "would scale up but cooldown active";
    }

    return {
      totalCapacity,
      totalAllocated,
      totalAvailable,
      enabledNodeCount: enabled.length,
      healthyNodeCount: healthyEnabled.length,
      shouldScaleUp,
      shouldScaleDownNodeIds: drainCandidates.map((n) => n.node_id),
      reason,
    };
  }

  /**
   * Provision a new Hetzner Cloud server, run the cloud-init bootstrap,
   * and insert a docker_nodes row in `unknown` status. The node still
   * needs to come online — health checks flip it to `healthy`.
   *
   * Throws if HCLOUD_TOKEN is not configured.
   */
  async provisionNode(
    request: ProvisionRequest,
    bootstrap: Pick<
      NodeBootstrapInput,
      "controlPlanePublicKey" | "registrationUrl" | "registrationSecret"
    >,
  ): Promise<ProvisionResult> {
    if (!isHetznerCloudConfigured()) {
      throw new HetznerCloudError(
        "missing_token",
        "Cannot provision a node: HCLOUD_TOKEN is not set.",
      );
    }
    if (bootstrap.controlPlanePublicKey.trim().length === 0) {
      throw new HetznerCloudError(
        "invalid_input",
        "controlPlanePublicKey is required to provision a node",
      );
    }

    const nodeId = request.nodeId ?? generateNodeId();
    const serverType = request.serverType ?? this.policy.defaultServerType;
    const location = request.location ?? this.policy.defaultLocation;
    const image = request.image ?? this.policy.defaultImage;
    const capacity = request.capacity ?? this.policy.defaultCapacity;
    const prePullImages = request.prePullImages ?? [containersEnv.defaultAgentImage()];

    const userData = buildContainerNodeUserData({
      nodeId,
      controlPlanePublicKey: bootstrap.controlPlanePublicKey,
      registrationUrl: bootstrap.registrationUrl,
      registrationSecret: bootstrap.registrationSecret,
      prePullImages,
      capacity,
    });

    const client = getHetznerCloudClient();
    const labels = {
      "managed-by": "eliza-cloud",
      "node-id": nodeId,
      ...request.labels,
    };

    const provisioned = await client.createServer({
      name: nodeId,
      serverType,
      location,
      image,
      userData,
      labels,
    });

    const ip =
      provisioned.server.public_net.ipv4?.ip ??
      provisioned.server.public_net.ipv6?.ip ??
      provisioned.server.name;

    // Insert the row in `unknown` status — the cloud-init bootstrap is
    // still running; the periodic health check will flip it to healthy.
    await dockerNodesRepository.create({
      node_id: nodeId,
      hostname: ip,
      ssh_port: 22,
      capacity,
      enabled: true,
      status: "unknown",
      allocated_count: 0,
      ssh_user: "root",
      metadata: {
        provider: "hetzner-cloud",
        hcloudServerId: provisioned.server.id,
        serverType,
        location,
        image,
        provisionedAt: new Date().toISOString(),
      },
    });

    logger.info("[autoscaler] Provisioned new container node", {
      nodeId,
      hcloudServerId: provisioned.server.id,
      ip,
      serverType,
      location,
    });

    return {
      nodeId,
      hostname: ip,
      hcloudServerId: provisioned.server.id,
      rootPassword: provisioned.rootPassword,
    };
  }

  /**
   * Drain a node: disable so no new containers land on it, then either
   * leave it idle or deprovision the underlying server once it is empty.
   *
   * Stateful containers (volume_path != null) on the node block
   * deprovision until the operator migrates or deletes them. The method
   * surfaces this as a structured error so the operator UI can show a
   * useful message.
   */
  async drainNode(nodeId: string, options: DrainOptions = {}): Promise<void> {
    const node = await dockerNodesRepository.findByNodeId(nodeId);
    if (!node) {
      throw new HetznerCloudError("not_found", `node ${nodeId} not registered`);
    }

    if (node.enabled) {
      await dockerNodesRepository.update(node.id, { enabled: false });
      logger.info("[autoscaler] Disabled node for drain", { nodeId });
    }

    const retainedWorkloads = await countRetainedWorkloadsOnNode(nodeId);
    if (retainedWorkloads > 0) {
      logger.info("[autoscaler] Node still has retained workloads, leaving disabled until empty", {
        nodeId,
        remaining: retainedWorkloads,
      });
      return;
    }

    if (options.deprovision !== true) return;

    const hcloudServerId = getHcloudServerId(node);
    if (!hcloudServerId) {
      logger.warn("[autoscaler] Cannot deprovision: no hcloudServerId on node metadata", {
        nodeId,
      });
      return;
    }

    if (!isHetznerCloudConfigured()) {
      logger.warn("[autoscaler] HCLOUD_TOKEN not set; cannot delete Hetzner server", {
        nodeId,
        hcloudServerId,
      });
      await dockerNodesRepository.delete(node.id);
      return;
    }

    const client = getHetznerCloudClient();
    try {
      await client.deleteServer(hcloudServerId);
    } catch (err) {
      if (err instanceof HetznerCloudError && err.code === "not_found") {
        logger.info("[autoscaler] Hetzner server already gone", { nodeId, hcloudServerId });
      } else {
        throw err;
      }
    }

    await dockerNodesRepository.delete(node.id);
    logger.info("[autoscaler] Deprovisioned node", { nodeId, hcloudServerId });
  }

  /**
   * Drain candidates: enabled nodes with zero containers (status filter
   * already enforced upstream by the count query) AND created long enough
   * ago that we are not deprovisioning a node that has just barely come
   * online before any container could land on it.
   */
  private async findDrainCandidates(enabled: DockerNode[]): Promise<DockerNode[]> {
    if (enabled.length <= 1) return [];

    const ageThreshold = this.nowFn() - this.policy.idleNodeMinAgeMs;
    const oldEnough = enabled.filter(
      (n) => isAutoscaledHetznerNode(n) && n.created_at.getTime() < ageThreshold,
    );
    if (oldEnough.length === 0) return [];

    const counts = await Promise.all(
      oldEnough.map(async (node) => ({
        node,
        count: await countRetainedWorkloadsOnNode(node.node_id),
      })),
    );
    return counts.filter((c) => c.count === 0).map((c) => c.node);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateNodeId(): string {
  // Short hex id with a deterministic prefix — easy to scan in the dashboard.
  const random = Math.random().toString(16).slice(2, 10);
  return `node-${random}`;
}

function getHcloudServerId(node: DockerNode): number | undefined {
  const meta = (node.metadata ?? {}) as Record<string, unknown>;
  return typeof meta.hcloudServerId === "number" ? meta.hcloudServerId : undefined;
}

function isAutoscaledHetznerNode(node: DockerNode): boolean {
  const meta = (node.metadata ?? {}) as Record<string, unknown>;
  return meta.provider === "hetzner-cloud" && getHcloudServerId(node) !== undefined;
}

let cachedAutoscaler: NodeAutoscaler | null = null;

export function getNodeAutoscaler(): NodeAutoscaler {
  if (!cachedAutoscaler) cachedAutoscaler = new NodeAutoscaler();
  return cachedAutoscaler;
}
