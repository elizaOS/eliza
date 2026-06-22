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

import { dockerNodesRepository } from "../../../db/repositories/docker-nodes";
import type { DockerNode } from "../../../db/schemas/docker-nodes";
import { containersEnv } from "../../config/containers-env";
import { logger } from "../../utils/logger";
import {
  countAllocatedWorkloadsOnNode,
  countRetainedWorkloadsOnNode,
} from "../docker-node-workloads";
import {
  inferArchitectureFromHetznerServerType,
  inferNodeArchitectureFromMetadata,
  isArchitectureCompatibleWithPlatform,
} from "../docker-sandbox-utils";
import {
  type ComputeProvider,
  type ComputeServer,
  getComputeProvider,
  isComputeConfigured,
} from "./compute-provider";
import { HetznerCloudError } from "./hetzner-cloud-api";
import { buildContainerNodeUserData, type NodeBootstrapInput } from "./node-bootstrap";

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
  minFreeSlotsBuffer: containersEnv.autoscaleMinFreeSlotsBuffer(),
  minHotAvailableSlots: containersEnv.autoscaleMinHotAvailableSlots(),
  maxNodes: 12,
  scaleUpCooldownMs: 5 * 60 * 1000,
  idleNodeMinAgeMs: 30 * 60 * 1000,
  defaultServerType: containersEnv.defaultHcloudServerType(),
  defaultLocation: containersEnv.defaultHcloudLocation(),
  defaultImage: "ubuntu-24.04",
  defaultCapacity: containersEnv.defaultAutoscaleNodeCapacity(),
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

/**
 * Dependency-injection seam for {@link NodeAutoscaler}.
 *
 * In production these default (lazily) to the `ComputeProvider` selected by
 * `getComputeProvider()` (Hetzner unless `COMPUTE_PROVIDER=digitalocean`) and
 * the matching `isComputeConfigured()` check — so runtime behavior is
 * unchanged. Tests inject a deterministic fake (`InMemoryComputeProvider`) or a
 * real client pointed at a local Hetzner mock, with NO monkey-patching of the
 * provider singletons.
 *
 * Both are resolved lazily (`provider`/`isConfigured` are getters, called only
 * when an actual provision/drain runs) so simply constructing a
 * `NodeAutoscaler` never builds a Hetzner client or reads `HCLOUD_TOKEN`.
 */
export interface NodeAutoscalerDeps {
  /** The IaaS provider used for server create/delete. */
  provider: ComputeProvider;
  /** Whether the provider's elastic-provisioning surface is configured. */
  isConfigured(): boolean;
}

// ---------------------------------------------------------------------------
// NodeAutoscaler
// ---------------------------------------------------------------------------

export class NodeAutoscaler {
  /** Lazily-resolved compute provider (built once, on first provision/drain). */
  private readonly resolveProvider: () => ComputeProvider;
  /** Configured-check for the selected provider. */
  private readonly isConfigured: () => boolean;

  /**
   * @param policy autoscale thresholds (defaults to env-derived production policy)
   * @param nowFn injectable clock (defaults to `Date.now`)
   * @param deps  IaaS seam injection. Omit to use `getComputeProvider()` /
   *              `isComputeConfigured()` (production default: Hetzner). Pass a
   *              fake/mock-backed provider in tests — no monkey-patching needed.
   */
  constructor(
    private readonly policy: AutoscalePolicy = DEFAULT_AUTOSCALE_POLICY,
    private readonly nowFn: () => number = () => Date.now(),
    deps?: Partial<NodeAutoscalerDeps>,
  ) {
    // Memoize an injected provider; otherwise defer to the seam so a bare
    // `new NodeAutoscaler()` never constructs a Hetzner client up front.
    const injected = deps?.provider;
    this.resolveProvider = injected ? () => injected : () => getComputeProvider();
    this.isConfigured = deps?.isConfigured ?? isComputeConfigured;
  }

  /**
   * Inspect current pool state and return a decision: should we scale up,
   * should we drain anyone, or are we steady? Pure read; no side effects.
   */
  async evaluateCapacity(): Promise<CapacityDecision> {
    const nodes = await dockerNodesRepository.findAll();
    const enabled = nodes.filter((n) => n.enabled);
    const requiredPlatform = containersEnv.defaultAgentImagePlatform();
    const healthyEnabled = enabled.filter(
      (n) =>
        n.status === "healthy" &&
        isArchitectureCompatibleWithPlatform(
          inferNodeArchitectureFromMetadata(n.metadata),
          requiredPlatform,
        ),
    );
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

    const drainCandidates =
      shouldScaleUp || belowBuffer
        ? []
        : await this.findDrainCandidates(healthyEnabled, allocatedByNode, totalAvailable);

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
    if (!this.isConfigured()) {
      throw new HetznerCloudError(
        "missing_token",
        "Cannot provision a node: the compute provider is not configured (HCLOUD_TOKEN unset).",
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
    const networkIds = containersEnv.defaultHcloudNetworkIds();

    const userData = buildContainerNodeUserData({
      nodeId,
      controlPlanePublicKey: bootstrap.controlPlanePublicKey,
      registrationUrl: bootstrap.registrationUrl,
      registrationSecret: bootstrap.registrationSecret,
      prePullImages,
      prePullPlatform: containersEnv.defaultAgentImagePlatform(),
      capacity,
    });

    const client = this.resolveProvider();
    // `environment` + `tier` let the orchestrator scope server lookups via
    // Hetzner's label_selector (e.g. `environment=staging,tier=data-plane`) so
    // staging never touches a production node, and a runaway daemon can't
    // accidentally claim/drain a server from a sibling environment. Without
    // these labels every API-discovered node looks identical, which is how we
    // shipped a staging node tagged `environment=production` in the first
    // place. Caller overrides via `request.labels` win (test seams).
    const labels = {
      "managed-by": "eliza-cloud",
      "node-id": nodeId,
      environment: containersEnv.environment(),
      tier: "data-plane",
      ...request.labels,
    };

    const provisioned = await client.createServer({
      name: nodeId,
      serverType,
      location,
      image,
      userData,
      networkIds,
      labels,
    });

    const ip = extractServerAddress(provisioned.server);
    // The seam declares ids as `number | string`; we store/consume the server id
    // as a numeric `hcloudServerId` throughout (it feeds `deleteServer(number)`),
    // so normalize at this boundary. Hetzner/DO both mint numeric ids.
    const serverId = coerceServerId(provisioned.server.id);

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
        autoscaled: true,
        hcloudServerId: serverId,
        serverType,
        location,
        image,
        architecture: inferArchitectureFromHetznerServerType(serverType),
        provisionedAt: new Date().toISOString(),
      },
    });

    logger.info("[autoscaler] Provisioned new container node", {
      nodeId,
      hcloudServerId: serverId,
      ip,
      serverType,
      location,
    });

    return {
      nodeId,
      hostname: ip,
      hcloudServerId: serverId,
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

    if (!this.isConfigured()) {
      logger.warn("[autoscaler] compute provider not configured; cannot delete server", {
        nodeId,
        hcloudServerId,
      });
      await dockerNodesRepository.delete(node.id);
      return;
    }

    const client = this.resolveProvider();
    try {
      await client.deleteServer(hcloudServerId);
    } catch (err) {
      if (err instanceof HetznerCloudError && err.code === "not_found") {
        logger.info("[autoscaler] Hetzner server already gone", {
          nodeId,
          hcloudServerId,
        });
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
  private async findDrainCandidates(
    healthyEnabled: DockerNode[],
    allocatedByNode: Map<string, number>,
    totalAvailable: number,
  ): Promise<DockerNode[]> {
    if (healthyEnabled.length <= 1) return [];

    const ageThreshold = this.nowFn() - this.policy.idleNodeMinAgeMs;
    const oldEnough = healthyEnabled.filter(
      (n) => isAutoscaledHetznerNode(n) && n.created_at.getTime() < ageThreshold,
    );
    if (oldEnough.length === 0) return [];

    const preservationFloor = Math.max(
      this.policy.minFreeSlotsBuffer,
      this.policy.minHotAvailableSlots,
    );
    const counts = await Promise.all(
      oldEnough.map(async (node) => ({
        node,
        retainedCount: await countRetainedWorkloadsOnNode(node.node_id),
      })),
    );

    let remainingAvailable = totalAvailable;
    let remainingHealthyNodes = healthyEnabled.length;
    const drainCandidates: DockerNode[] = [];

    for (const { node, retainedCount } of counts) {
      if (retainedCount > 0) continue;

      const allocated = allocatedByNode.get(node.node_id) ?? node.allocated_count;
      if (allocated > 0) continue;

      const nodeAvailable = Math.max(0, node.capacity - allocated);
      if (remainingHealthyNodes <= 1) continue;
      if (remainingAvailable - nodeAvailable < preservationFloor) continue;

      drainCandidates.push(node);
      remainingAvailable -= nodeAvailable;
      remainingHealthyNodes -= 1;
    }

    return drainCandidates;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateNodeId(): string {
  // Short hex id with a deterministic prefix — easy to scan in the dashboard.
  // `Math.random().toString(16)` strips trailing zeros (e.g. 0.5 → "0.8"), so
  // `.slice(2, 10)` is not guaranteed to be 8 chars. Generate 4 random bytes
  // and hex-encode them for a stable 8-char suffix and stronger uniqueness.
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const random = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `eliza-core-${random}`;
}

/**
 * Normalize a provider server id (`number | string` at the seam) to the numeric
 * `hcloudServerId` the autoscaler persists and later passes to
 * `deleteServer(number)`. Both supported providers return numeric ids; a numeric
 * string is parsed, anything else throws so a malformed id never silently
 * becomes `NaN` in the DB.
 */
function coerceServerId(id: number | string): number {
  const n = typeof id === "number" ? id : Number(id);
  if (!Number.isFinite(n)) {
    throw new HetznerCloudError(
      "server_error",
      `Compute provider returned a non-numeric server id: ${String(id)}`,
    );
  }
  return n;
}

/**
 * Extract a reachable address for a freshly-provisioned server through the
 * provider-agnostic seam.
 *
 * The seam's `ComputeServer` only guarantees `id`/`name`/`status`; each provider
 * carries IPs in its own richer subtype (Hetzner: `public_net.ipv4.ip`;
 * DigitalOcean: `publicIp`). Rather than widen the seam or unsafe-cast the
 * concrete type back, we probe both known shapes at runtime with type guards and
 * fall back to the server name (Hetzner created the row in `unknown` status and
 * the health check fixes the hostname once the node registers). This keeps the
 * autoscaler decoupled from any single provider's wire shape.
 */
function extractServerAddress(server: ComputeServer): string {
  const hetznerIp = readHetznerPublicIp(server);
  if (hetznerIp) return hetznerIp;

  const publicIp = readStringField(server, "publicIp");
  if (publicIp) return publicIp;

  return server.name;
}

/** Hetzner's `public_net.ipv4.ip ?? public_net.ipv6.ip`, runtime-validated. */
function readHetznerPublicIp(server: ComputeServer): string | undefined {
  const publicNet = readRecordField(server, "public_net");
  if (!publicNet) return undefined;
  return readNestedIp(publicNet, "ipv4") ?? readNestedIp(publicNet, "ipv6");
}

function readNestedIp(publicNet: Record<string, unknown>, family: string): string | undefined {
  const entry = publicNet[family];
  if (entry === null || typeof entry !== "object") return undefined;
  const ip = (entry as Record<string, unknown>).ip;
  return typeof ip === "string" && ip.length > 0 ? ip : undefined;
}

function readRecordField(obj: object, key: string): Record<string, unknown> | undefined {
  const value = (obj as Record<string, unknown>)[key];
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function readStringField(obj: object, key: string): string | undefined {
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getHcloudServerId(node: DockerNode): number | undefined {
  const meta = (node.metadata ?? {}) as Record<string, unknown>;
  return typeof meta.hcloudServerId === "number" ? meta.hcloudServerId : undefined;
}

function isAutoscaledHetznerNode(node: DockerNode): boolean {
  const meta = (node.metadata ?? {}) as Record<string, unknown>;
  return (
    meta.provider === "hetzner-cloud" &&
    meta.autoscaled === true &&
    getHcloudServerId(node) !== undefined
  );
}

let cachedAutoscaler: NodeAutoscaler | null = null;

export function getNodeAutoscaler(): NodeAutoscaler {
  if (!cachedAutoscaler) cachedAutoscaler = new NodeAutoscaler();
  return cachedAutoscaler;
}
