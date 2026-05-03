import { asc } from "drizzle-orm";
import { dbRead } from "@/db/helpers";
import { dockerNodesRepository } from "@/db/repositories/docker-nodes";
import { type AgentSandboxStatus, agentSandboxes } from "@/db/schemas/agent-sandboxes";
import type { DockerNodeStatus } from "@/db/schemas/docker-nodes";
import { DockerSSHClient } from "@/lib/services/docker-ssh";
import { logger } from "@/lib/utils/logger";

const HEARTBEAT_WARNING_MINUTES = 5;
const HEARTBEAT_STALE_MINUTES = 15;
const NODE_SATURATION_WARNING_PCT = 85;
const NODE_SATURATION_CRITICAL_PCT = 100;
const NODE_RESOURCE_WARNING_PCT = 85;
const NODE_RESOURCE_CRITICAL_PCT = 95;
const SSH_CONNECT_TIMEOUT_MS = 10_000;
const SSH_COMMAND_TIMEOUT_MS = 15_000;
const NODE_INSPECTION_TIMEOUT_MS = 25_000;
const MAX_CONCURRENT_SSH_SESSIONS = 5;
const SNAPSHOT_CACHE_TTL_MS = 30_000;

/** Simple concurrency limiter — runs at most `limit` tasks in parallel. */
async function pLimit<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const i = nextIndex++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** Wraps a promise with a timeout — rejects with an error if the deadline expires. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Best-effort in-process cache for repeated admin polling on the same warm instance.
 * Serverless cold starts will begin with an empty cache.
 */
let snapshotCache: {
  data: AdminInfrastructureSnapshot;
  expiresAt: number;
} | null = null;

type IncidentSeverity = "critical" | "warning" | "info";
type IncidentScope = "cluster" | "node" | "container";

export type ContainerLiveHealthStatus =
  | "healthy"
  | "warming"
  | "degraded"
  | "stale"
  | "missing"
  | "failed"
  | "stopped";

export interface ContainerHealthAssessment {
  status: ContainerLiveHealthStatus;
  severity: IncidentSeverity;
  reason: string;
}

interface RuntimeContainerRecord {
  name: string;
  id: string;
  image: string | null;
  state: string;
  status: string;
  runningFor: string | null;
  health: "healthy" | "unhealthy" | "starting" | null;
}

interface NodeRuntimeSnapshot {
  reachable: boolean;
  checkedAt: string;
  sshLatencyMs: number | null;
  dockerVersion: string | null;
  diskUsedPercent: number | null;
  memoryUsedPercent: number | null;
  loadAverage: string | null;
  actualContainerCount: number;
  runningContainerCount: number;
  containers: RuntimeContainerRecord[];
  error: string | null;
}

export interface AdminInfrastructureContainer {
  id: string;
  sandboxId: string | null;
  agentName: string | null;
  organizationId: string | null;
  userId: string | null;
  nodeId: string | null;
  containerName: string | null;
  dbStatus: AgentSandboxStatus;
  liveHealth: ContainerLiveHealthStatus;
  liveHealthSeverity: IncidentSeverity;
  liveHealthReason: string;
  runtimeState: string | null;
  runtimeStatus: string | null;
  runtimePresent: boolean;
  dockerImage: string | null;
  bridgePort: number | null;
  webUiPort: number | null;
  headscaleIp: string | null;
  bridgeUrl: string | null;
  healthUrl: string | null;
  lastHeartbeatAt: string | null;
  heartbeatAgeMinutes: number | null;
  errorMessage: string | null;
  errorCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminInfrastructureNode {
  id: string;
  nodeId: string;
  hostname: string;
  sshPort: number;
  sshUser: string;
  capacity: number;
  allocatedCount: number;
  availableSlots: number;
  enabled: boolean;
  status: DockerNodeStatus;
  lastHealthCheck: string | null;
  utilizationPct: number;
  runtime: NodeRuntimeSnapshot;
  allocationDrift: number;
  alerts: string[];
  containers: AdminInfrastructureContainer[];
  ghostContainers: Array<{
    name: string;
    state: string;
    status: string;
  }>;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminInfrastructureIncident {
  severity: IncidentSeverity;
  scope: IncidentScope;
  title: string;
  detail: string;
  nodeId?: string;
  containerId?: string;
}

export interface AdminInfrastructureSummary {
  totalNodes: number;
  enabledNodes: number;
  healthyNodes: number;
  degradedNodes: number;
  offlineNodes: number;
  unknownNodes: number;
  totalCapacity: number;
  allocatedSlots: number;
  availableSlots: number;
  utilizationPct: number;
  saturatedNodes: number;
  nodesWithDrift: number;
  totalContainers: number;
  runningContainers: number;
  pendingContainers: number;
  provisioningContainers: number;
  stoppedContainers: number;
  errorContainers: number;
  disconnectedContainers: number;
  healthyContainers: number;
  attentionContainers: number;
  staleContainers: number;
  missingContainers: number;
  failedContainers: number;
  backlogCount: number;
}

export interface AdminInfrastructureSnapshot {
  refreshedAt: string;
  summary: AdminInfrastructureSummary;
  incidents: AdminInfrastructureIncident[];
  nodes: AdminInfrastructureNode[];
  containers: AdminInfrastructureContainer[];
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parsePercent(value: string): number | null {
  const parsed = Number.parseInt(value.replace(/%/g, "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseMemoryPercent(value: string): number | null {
  const [usedRaw, totalRaw] = value.split("|");
  const used = Number.parseInt(usedRaw ?? "", 10);
  const total = Number.parseInt(totalRaw ?? "", 10);

  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
    return null;
  }

  return Math.round((used / total) * 100);
}

function parseRuntimeContainers(output: string): RuntimeContainerRecord[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = "", id = "", image = "", state = "", status = "", runningFor = ""] =
        line.split("|");
      return {
        name,
        id,
        image: image || null,
        state: state.toLowerCase(),
        status,
        runningFor: runningFor || null,
        health: parseDockerHealth(status),
      } satisfies RuntimeContainerRecord;
    });
}

function parseDockerHealth(status: string): RuntimeContainerRecord["health"] {
  // Strip the common "health: " prefix from Docker status strings
  const normalized = status
    .toLowerCase()
    .replace(/^.*health:\s*/, "")
    .trim();
  if (normalized === "unhealthy" || normalized.startsWith("unhealthy")) return "unhealthy";
  if (normalized === "healthy" || normalized.startsWith("healthy")) return "healthy";
  if (normalized === "starting" || normalized.startsWith("starting")) return "starting";
  // Fallback: check the full string for keywords (handles non-standard formats)
  const full = status.toLowerCase();
  if (full.includes("unhealthy")) return "unhealthy";
  if (full.includes("healthy")) return "healthy";
  if (full.includes("starting")) return "starting";
  return null;
}

function getHeartbeatAgeMinutes(lastHeartbeatAt: string | null): number | null {
  if (!lastHeartbeatAt) return null;
  const parsed = new Date(lastHeartbeatAt).getTime();
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Math.round((Date.now() - parsed) / 60_000));
}

function buildResourceAlert(label: string, percent: number | null): string | null {
  if (percent === null) return null;
  if (percent >= NODE_RESOURCE_CRITICAL_PCT) return `${label} critical: ${percent}% used`;
  if (percent >= NODE_RESOURCE_WARNING_PCT) return `${label} warning: ${percent}% used`;
  return null;
}

function sortIncidents(a: AdminInfrastructureIncident, b: AdminInfrastructureIncident): number {
  const severityWeight: Record<IncidentSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };

  return severityWeight[a.severity] - severityWeight[b.severity] || a.title.localeCompare(b.title);
}

export function classifyContainerHealth(params: {
  dbStatus: AgentSandboxStatus;
  runtime: RuntimeContainerRecord | null;
  lastHeartbeatAt: string | null;
  errorMessage: string | null;
}): ContainerHealthAssessment {
  const heartbeatAgeMinutes = getHeartbeatAgeMinutes(params.lastHeartbeatAt);
  const runtime = params.runtime;

  if (params.dbStatus === "error") {
    return {
      status: "failed",
      severity: "critical",
      reason: params.errorMessage || "Provisioning or runtime error recorded in control plane",
    };
  }

  if (params.dbStatus === "stopped" && !runtime) {
    return {
      status: "stopped",
      severity: "info",
      reason: "Container is intentionally stopped",
    };
  }

  if (!runtime) {
    if (params.dbStatus === "pending" || params.dbStatus === "provisioning") {
      return {
        status: "warming",
        severity: "info",
        reason: "Container is not on a node yet",
      };
    }

    return {
      status: "missing",
      severity: "critical",
      reason: "Database record exists but container is missing from the node",
    };
  }

  if (params.dbStatus === "stopped") {
    return {
      status: "degraded",
      severity: "warning",
      reason: "Control plane says stopped but container still exists on the node",
    };
  }

  if (runtime.state === "dead" || runtime.state === "exited") {
    return {
      status: "failed",
      severity: "critical",
      reason: runtime.status || "Container exited unexpectedly",
    };
  }

  if (runtime.state === "restarting") {
    return {
      status: "degraded",
      severity: "warning",
      reason: runtime.status || "Container is restarting",
    };
  }

  if (runtime.state === "created") {
    return {
      status: "warming",
      severity: "info",
      reason: "Container exists but has not started yet",
    };
  }

  if (runtime.health === "unhealthy") {
    return {
      status: "failed",
      severity: "critical",
      reason: runtime.status || "Docker health check reports unhealthy",
    };
  }

  if (runtime.health === "starting") {
    return {
      status: "warming",
      severity: "info",
      reason: runtime.status || "Docker health check is still warming up",
    };
  }

  if (params.dbStatus === "pending" || params.dbStatus === "provisioning") {
    return {
      status: "warming",
      severity: "info",
      reason: "Provisioning is still in progress",
    };
  }

  if (params.dbStatus === "disconnected") {
    return {
      status: "degraded",
      severity: "warning",
      reason: "Container is running but marked disconnected",
    };
  }

  if (heartbeatAgeMinutes === null) {
    return {
      status: "degraded",
      severity: "warning",
      reason: "No heartbeat has been recorded yet",
    };
  }

  if (heartbeatAgeMinutes >= HEARTBEAT_STALE_MINUTES) {
    // If the container is running and Docker health check says healthy,
    // downgrade severity — the heartbeat mechanism may be broken but the
    // container itself is functional.
    const runtimeHealthy = runtime?.state === "running" && runtime?.health === "healthy";
    return {
      status: "stale",
      severity: runtimeHealthy ? "warning" : "critical",
      reason: `Heartbeat is ${heartbeatAgeMinutes}m old${runtimeHealthy ? " (container is running and Docker-healthy)" : ""}`,
    };
  }

  if (heartbeatAgeMinutes >= HEARTBEAT_WARNING_MINUTES) {
    return {
      status: "degraded",
      severity: "warning",
      reason: `Heartbeat is delayed (${heartbeatAgeMinutes}m old)`,
    };
  }

  return {
    status: "healthy",
    severity: "info",
    reason: runtime.status || "Container is running normally",
  };
}

async function inspectNodeRuntime(node: {
  node_id: string;
  hostname: string;
  ssh_port: number;
  ssh_user: string;
  host_key_fingerprint: string | null;
}): Promise<NodeRuntimeSnapshot> {
  const checkedAt = new Date().toISOString();
  const ssh = new DockerSSHClient({
    hostname: node.hostname,
    port: node.ssh_port,
    username: node.ssh_user,
    hostKeyFingerprint: node.host_key_fingerprint ?? undefined,
  });

  try {
    const sshStart = Date.now();
    await ssh.exec("echo ok", SSH_CONNECT_TIMEOUT_MS);
    const sshLatencyMs = Date.now() - sshStart;

    const [dockerVersionRaw, diskRaw, memoryRaw, loadAverageRaw, containersRaw] = await Promise.all(
      [
        ssh.exec("docker version --format '{{.Server.Version}}'", SSH_COMMAND_TIMEOUT_MS),
        ssh.exec("df -P / | tail -1 | awk '{print $5}'", SSH_COMMAND_TIMEOUT_MS),
        ssh.exec("free -b | awk '/Mem:/ {print $3\"|\"$2}'", SSH_COMMAND_TIMEOUT_MS),
        ssh.exec("cut -d' ' -f1-3 /proc/loadavg", SSH_COMMAND_TIMEOUT_MS),
        ssh.exec(
          "docker ps -a --filter name=agent- --format '{{.Names}}|{{.ID}}|{{.Image}}|{{.State}}|{{.Status}}|{{.RunningFor}}' 2>/dev/null || true",
          SSH_COMMAND_TIMEOUT_MS,
        ),
      ],
    );

    const containers = parseRuntimeContainers(containersRaw);

    return {
      reachable: true,
      checkedAt,
      sshLatencyMs,
      dockerVersion: dockerVersionRaw.trim() || null,
      diskUsedPercent: parsePercent(diskRaw),
      memoryUsedPercent: parseMemoryPercent(memoryRaw.trim()),
      loadAverage: loadAverageRaw.trim() || null,
      actualContainerCount: containers.length,
      runningContainerCount: containers.filter((container) => container.state === "running").length,
      containers,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("[admin-infrastructure] Failed to inspect node runtime", {
      nodeId: node.node_id,
      error: message,
    });

    return {
      reachable: false,
      checkedAt,
      sshLatencyMs: null,
      dockerVersion: null,
      diskUsedPercent: null,
      memoryUsedPercent: null,
      loadAverage: null,
      actualContainerCount: 0,
      runningContainerCount: 0,
      containers: [],
      error: message,
    };
  } finally {
    try {
      await ssh.disconnect();
    } catch {
      // ignore cleanup failures
    }
  }
}

function buildNodeAlerts(params: {
  node: Awaited<ReturnType<typeof dockerNodesRepository.findAll>>[number];
  runtime: NodeRuntimeSnapshot;
  allocationDrift: number;
  unhealthyContainerCount: number;
}): string[] {
  const alerts: string[] = [];
  const { node, runtime, allocationDrift, unhealthyContainerCount } = params;

  if (!node.enabled) {
    alerts.push("Node is disabled for new allocations");
  }

  if (!runtime.reachable) {
    alerts.push("Live SSH inspection failed");
    return alerts;
  }

  const saturation =
    node.capacity > 0 ? Math.round((node.allocated_count / node.capacity) * 100) : 0;
  if (saturation >= NODE_SATURATION_CRITICAL_PCT) {
    alerts.push(`Capacity exhausted (${saturation}% allocated)`);
  } else if (saturation >= NODE_SATURATION_WARNING_PCT) {
    alerts.push(`Capacity nearly full (${saturation}% allocated)`);
  }

  const diskAlert = buildResourceAlert("Disk", runtime.diskUsedPercent);
  if (diskAlert) alerts.push(diskAlert);

  const memoryAlert = buildResourceAlert("Memory", runtime.memoryUsedPercent);
  if (memoryAlert) alerts.push(memoryAlert);

  if (allocationDrift !== 0) {
    const driftDirection = allocationDrift > 0 ? `+${allocationDrift}` : `${allocationDrift}`;
    alerts.push(`Allocation drift ${driftDirection} vs control plane`);
  }

  if (unhealthyContainerCount > 0) {
    alerts.push(
      `${unhealthyContainerCount} container${unhealthyContainerCount === 1 ? "" : "s"} need attention`,
    );
  }

  return alerts;
}

export async function getAdminInfrastructureSnapshot(): Promise<AdminInfrastructureSnapshot> {
  if (snapshotCache && Date.now() < snapshotCache.expiresAt) {
    return snapshotCache.data;
  }

  const refreshedAt = new Date().toISOString();

  const [nodes, sandboxRows] = await Promise.all([
    dockerNodesRepository.findAll(),
    dbRead
      .select({
        id: agentSandboxes.id,
        sandboxId: agentSandboxes.sandbox_id,
        organizationId: agentSandboxes.organization_id,
        userId: agentSandboxes.user_id,
        agentName: agentSandboxes.agent_name,
        status: agentSandboxes.status,
        nodeId: agentSandboxes.node_id,
        containerName: agentSandboxes.container_name,
        bridgePort: agentSandboxes.bridge_port,
        webUiPort: agentSandboxes.web_ui_port,
        headscaleIp: agentSandboxes.headscale_ip,
        dockerImage: agentSandboxes.docker_image,
        bridgeUrl: agentSandboxes.bridge_url,
        healthUrl: agentSandboxes.health_url,
        lastHeartbeatAt: agentSandboxes.last_heartbeat_at,
        errorMessage: agentSandboxes.error_message,
        errorCount: agentSandboxes.error_count,
        createdAt: agentSandboxes.created_at,
        updatedAt: agentSandboxes.updated_at,
      })
      .from(agentSandboxes)
      .orderBy(asc(agentSandboxes.created_at)),
  ]);

  const sandboxesByNode = new Map<string, typeof sandboxRows>();
  const unassignedSandboxRows = [] as typeof sandboxRows;

  for (const row of sandboxRows) {
    if (!row.nodeId) {
      unassignedSandboxRows.push(row);
      continue;
    }

    const existing = sandboxesByNode.get(row.nodeId) ?? [];
    existing.push(row);
    sandboxesByNode.set(row.nodeId, existing);
  }

  const inspectedNodes = await pLimit(
    nodes.map((node) => async () => {
      const dbContainers = sandboxesByNode.get(node.node_id) ?? [];
      const runtime = await withTimeout(
        inspectNodeRuntime(node),
        NODE_INSPECTION_TIMEOUT_MS,
        `inspectNodeRuntime(${node.node_id})`,
      ).catch((error): NodeRuntimeSnapshot => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[admin-infrastructure] Node inspection timed out", {
          nodeId: node.node_id,
          error: message,
        });
        return {
          reachable: false,
          checkedAt: new Date().toISOString(),
          sshLatencyMs: null,
          dockerVersion: null,
          diskUsedPercent: null,
          memoryUsedPercent: null,
          loadAverage: null,
          actualContainerCount: 0,
          runningContainerCount: 0,
          containers: [],
          error: message,
        };
      });
      const runtimeByName = new Map(
        runtime.containers.map((container) => [container.name, container]),
      );

      const containers: AdminInfrastructureContainer[] = dbContainers.map((container) => {
        const runtimeMatch = container.containerName
          ? (runtimeByName.get(container.containerName) ?? null)
          : null;
        const health = classifyContainerHealth({
          dbStatus: container.status,
          runtime: runtimeMatch,
          lastHeartbeatAt: toIso(container.lastHeartbeatAt),
          errorMessage: container.errorMessage,
        });

        return {
          id: container.id,
          sandboxId: container.sandboxId,
          agentName: container.agentName,
          organizationId: container.organizationId,
          userId: container.userId,
          nodeId: container.nodeId,
          containerName: container.containerName,
          dbStatus: container.status,
          liveHealth: health.status,
          liveHealthSeverity: health.severity,
          liveHealthReason: health.reason,
          runtimeState: runtimeMatch?.state ?? null,
          runtimeStatus: runtimeMatch?.status ?? null,
          runtimePresent: !!runtimeMatch,
          dockerImage: container.dockerImage ?? runtimeMatch?.image ?? null,
          bridgePort: container.bridgePort,
          webUiPort: container.webUiPort,
          headscaleIp: container.headscaleIp,
          bridgeUrl: container.bridgeUrl,
          healthUrl: container.healthUrl,
          lastHeartbeatAt: toIso(container.lastHeartbeatAt),
          heartbeatAgeMinutes: getHeartbeatAgeMinutes(toIso(container.lastHeartbeatAt)),
          errorMessage: container.errorMessage,
          errorCount: container.errorCount ?? 0,
          createdAt: toIso(container.createdAt) ?? refreshedAt,
          updatedAt: toIso(container.updatedAt) ?? refreshedAt,
        };
      });

      const trackedContainerNames = new Set(
        containers
          .map((container) => container.containerName)
          .filter((value): value is string => Boolean(value)),
      );

      const ghostContainers = runtime.containers
        .filter((container) => !trackedContainerNames.has(container.name))
        .map((container) => ({
          name: container.name,
          state: container.state,
          status: container.status,
        }));

      const unhealthyContainerCount = containers.filter(
        (container) =>
          container.liveHealth !== "healthy" &&
          container.liveHealth !== "warming" &&
          container.liveHealth !== "stopped",
      ).length;

      // Use actual sandbox record count rather than the potentially-stale
      // allocated_count column stored in docker_nodes.
      const actualAllocatedCount = dbContainers.length;

      const allocationDrift = runtime.reachable
        ? runtime.actualContainerCount - actualAllocatedCount
        : 0;

      return {
        id: node.id,
        nodeId: node.node_id,
        hostname: node.hostname,
        sshPort: node.ssh_port,
        sshUser: node.ssh_user,
        capacity: node.capacity,
        allocatedCount: actualAllocatedCount,
        availableSlots: Math.max(0, node.capacity - actualAllocatedCount),
        enabled: node.enabled,
        status: node.status,
        lastHealthCheck: toIso(node.last_health_check),
        utilizationPct:
          node.capacity > 0 ? Math.round((node.allocated_count / node.capacity) * 100) : 0,
        runtime,
        allocationDrift,
        alerts: buildNodeAlerts({
          node,
          runtime,
          allocationDrift,
          unhealthyContainerCount,
        }),
        containers,
        ghostContainers,
        metadata: node.metadata,
        createdAt: toIso(node.created_at) ?? refreshedAt,
        updatedAt: toIso(node.updated_at) ?? refreshedAt,
      } satisfies AdminInfrastructureNode;
    }),
    MAX_CONCURRENT_SSH_SESSIONS,
  );

  const unassignedContainers: AdminInfrastructureContainer[] = unassignedSandboxRows.map(
    (container) => {
      const health = classifyContainerHealth({
        dbStatus: container.status,
        runtime: null,
        lastHeartbeatAt: toIso(container.lastHeartbeatAt),
        errorMessage: container.errorMessage,
      });

      return {
        id: container.id,
        sandboxId: container.sandboxId,
        agentName: container.agentName,
        organizationId: container.organizationId,
        userId: container.userId,
        nodeId: null,
        containerName: container.containerName,
        dbStatus: container.status,
        liveHealth: health.status,
        liveHealthSeverity: health.severity,
        liveHealthReason: health.reason,
        runtimeState: null,
        runtimeStatus: null,
        runtimePresent: false,
        dockerImage: container.dockerImage,
        bridgePort: container.bridgePort,
        webUiPort: container.webUiPort,
        headscaleIp: container.headscaleIp,
        bridgeUrl: container.bridgeUrl,
        healthUrl: container.healthUrl,
        lastHeartbeatAt: toIso(container.lastHeartbeatAt),
        heartbeatAgeMinutes: getHeartbeatAgeMinutes(toIso(container.lastHeartbeatAt)),
        errorMessage: container.errorMessage,
        errorCount: container.errorCount ?? 0,
        createdAt: toIso(container.createdAt) ?? refreshedAt,
        updatedAt: toIso(container.updatedAt) ?? refreshedAt,
      };
    },
  );

  const containers = [
    ...inspectedNodes.flatMap((node) => node.containers),
    ...unassignedContainers,
  ];
  const incidents: AdminInfrastructureIncident[] = [];

  for (const node of inspectedNodes) {
    if (!node.enabled) {
      incidents.push({
        severity: "info",
        scope: "node",
        nodeId: node.nodeId,
        title: `${node.nodeId} disabled`,
        detail: "Node is excluded from new allocations",
      });
    }

    if (!node.runtime.reachable) {
      incidents.push({
        severity: "critical",
        scope: "node",
        nodeId: node.nodeId,
        title: `${node.nodeId} unreachable`,
        detail: node.runtime.error || "Live SSH inspection failed",
      });
      continue;
    }

    if (node.utilizationPct >= NODE_SATURATION_CRITICAL_PCT) {
      incidents.push({
        severity: "critical",
        scope: "node",
        nodeId: node.nodeId,
        title: `${node.nodeId} at capacity`,
        detail: `${node.allocatedCount}/${node.capacity} slots allocated`,
      });
    } else if (node.utilizationPct >= NODE_SATURATION_WARNING_PCT) {
      incidents.push({
        severity: "warning",
        scope: "node",
        nodeId: node.nodeId,
        title: `${node.nodeId} nearing capacity`,
        detail: `${node.allocatedCount}/${node.capacity} slots allocated`,
      });
    }

    if (node.allocationDrift !== 0) {
      incidents.push({
        severity: Math.abs(node.allocationDrift) >= 2 ? "critical" : "warning",
        scope: "node",
        nodeId: node.nodeId,
        title: `${node.nodeId} allocation drift`,
        detail: `Control plane differs from runtime by ${node.allocationDrift > 0 ? `+${node.allocationDrift}` : node.allocationDrift} container(s)`,
      });
    }

    if (
      node.runtime.diskUsedPercent !== null &&
      node.runtime.diskUsedPercent >= NODE_RESOURCE_CRITICAL_PCT
    ) {
      incidents.push({
        severity: "critical",
        scope: "node",
        nodeId: node.nodeId,
        title: `${node.nodeId} disk pressure`,
        detail: `Disk usage at ${node.runtime.diskUsedPercent}%`,
      });
    }

    if (
      node.runtime.memoryUsedPercent !== null &&
      node.runtime.memoryUsedPercent >= NODE_RESOURCE_CRITICAL_PCT
    ) {
      incidents.push({
        severity: "critical",
        scope: "node",
        nodeId: node.nodeId,
        title: `${node.nodeId} memory pressure`,
        detail: `Memory usage at ${node.runtime.memoryUsedPercent}%`,
      });
    }

    for (const ghost of node.ghostContainers) {
      incidents.push({
        severity: "warning",
        scope: "node",
        nodeId: node.nodeId,
        title: `${node.nodeId} has ghost container`,
        detail: `${ghost.name} is running on the node but not tracked in the control plane`,
      });
    }
  }

  for (const container of containers) {
    if (
      container.liveHealth === "healthy" ||
      container.liveHealth === "warming" ||
      container.liveHealth === "stopped"
    ) {
      continue;
    }

    incidents.push({
      severity: container.liveHealthSeverity,
      scope: "container",
      nodeId: container.nodeId ?? undefined,
      containerId: container.id,
      title: `${container.agentName || container.containerName || container.id.slice(0, 8)} ${container.liveHealth}`,
      detail: container.liveHealthReason,
    });
  }

  const enabledNodes = inspectedNodes.filter((node) => node.enabled);
  const totalCapacity = enabledNodes.reduce((sum, node) => sum + node.capacity, 0);
  const allocatedSlots = enabledNodes.reduce((sum, node) => sum + node.allocatedCount, 0);
  const availableSlots = enabledNodes.reduce((sum, node) => sum + node.availableSlots, 0);

  const summary: AdminInfrastructureSummary = {
    totalNodes: inspectedNodes.length,
    enabledNodes: enabledNodes.length,
    healthyNodes: enabledNodes.filter((node) => node.status === "healthy").length,
    degradedNodes: enabledNodes.filter((node) => node.status === "degraded").length,
    offlineNodes: enabledNodes.filter((node) => node.status === "offline").length,
    unknownNodes: enabledNodes.filter((node) => node.status === "unknown").length,
    totalCapacity,
    allocatedSlots,
    availableSlots,
    utilizationPct: totalCapacity > 0 ? Math.round((allocatedSlots / totalCapacity) * 100) : 0,
    saturatedNodes: enabledNodes.filter(
      (node) => node.utilizationPct >= NODE_SATURATION_WARNING_PCT,
    ).length,
    nodesWithDrift: inspectedNodes.filter((node) => node.allocationDrift !== 0).length,
    totalContainers: containers.length,
    runningContainers: containers.filter((container) => container.dbStatus === "running").length,
    pendingContainers: containers.filter((container) => container.dbStatus === "pending").length,
    provisioningContainers: containers.filter((container) => container.dbStatus === "provisioning")
      .length,
    stoppedContainers: containers.filter((container) => container.dbStatus === "stopped").length,
    errorContainers: containers.filter((container) => container.dbStatus === "error").length,
    disconnectedContainers: containers.filter((container) => container.dbStatus === "disconnected")
      .length,
    healthyContainers: containers.filter((container) => container.liveHealth === "healthy").length,
    attentionContainers: containers.filter(
      (container) =>
        container.liveHealth !== "healthy" &&
        container.liveHealth !== "warming" &&
        container.liveHealth !== "stopped",
    ).length,
    staleContainers: containers.filter((container) => container.liveHealth === "stale").length,
    missingContainers: containers.filter((container) => container.liveHealth === "missing").length,
    failedContainers: containers.filter((container) => container.liveHealth === "failed").length,
    backlogCount: containers.filter(
      (container) => container.dbStatus === "pending" || container.dbStatus === "provisioning",
    ).length,
  };

  if (summary.backlogCount > summary.availableSlots && summary.availableSlots >= 0) {
    incidents.push({
      severity: "warning",
      scope: "cluster",
      title: "Provisioning backlog exceeds free capacity",
      detail: `${summary.backlogCount} containers are waiting or provisioning with ${summary.availableSlots} slots free`,
    });
  }

  if (enabledNodes.length === 0 && summary.totalNodes > 0) {
    incidents.push({
      severity: "critical",
      scope: "cluster",
      title: "No enabled Docker nodes available",
      detail:
        "Provisioning capacity is unavailable until at least one node is enabled for allocations",
    });
  } else if (summary.healthyNodes === 0 && summary.totalNodes > 0) {
    incidents.push({
      severity: "critical",
      scope: "cluster",
      title: "No healthy Docker nodes available",
      detail: "Provisioning capacity is effectively unavailable until a node recovers",
    });
  }

  const snapshot: AdminInfrastructureSnapshot = {
    refreshedAt,
    summary,
    incidents: incidents.sort(sortIncidents),
    nodes: inspectedNodes,
    containers: containers.sort((a, b) => {
      const severityWeight: Record<IncidentSeverity, number> = {
        critical: 0,
        warning: 1,
        info: 2,
      };

      return (
        severityWeight[a.liveHealthSeverity] - severityWeight[b.liveHealthSeverity] ||
        a.createdAt.localeCompare(b.createdAt)
      );
    }),
  };

  snapshotCache = {
    data: snapshot,
    expiresAt: Date.now() + SNAPSHOT_CACHE_TTL_MS,
  };
  return snapshot;
}
