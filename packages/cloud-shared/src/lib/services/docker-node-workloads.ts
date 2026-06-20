import { and, eq, inArray, sql } from "drizzle-orm";
import { dbRead } from "../../db/helpers";
import { dockerNodesRepository } from "../../db/repositories/docker-nodes";
import { agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { containers } from "../../db/schemas/containers";
import { logger } from "../utils/logger";
import { AGENT_CONTAINER_NAME_PREFIX, shellQuote } from "./docker-sandbox-utils";
import { DockerSSHClient } from "./docker-ssh";

async function countRows(query: Promise<Array<{ count: number }>>): Promise<number> {
  const [row] = await query;
  return row?.count ?? 0;
}

/**
 * Active compute slots on a Docker node.
 *
 * Stopped containers are intentionally excluded here because their Docker
 * process has been removed and `allocated_count` should represent live slot
 * pressure, not retained storage.
 */
export async function countAllocatedWorkloadsOnNode(nodeId: string): Promise<number> {
  const [containerCount, agentCount] = await Promise.all([
    countRows(
      dbRead
        .select({ count: sql<number>`count(*)::int` })
        .from(containers)
        .where(
          and(
            eq(containers.node_id, nodeId),
            sql`${containers.status} not in ('failed','stopped','deleted')`,
          ),
        ),
    ),
    countRows(
      dbRead
        .select({ count: sql<number>`count(*)::int` })
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.node_id, nodeId),
            sql`${agentSandboxes.status} not in ('stopped','error')`,
          ),
        ),
    ),
  ]);

  return containerCount + agentCount;
}

// ---------------------------------------------------------------------------
// Orphan-container reconciliation
//
// A container named `agent-<id>` on a node whose DB row has been deleted (or
// moved to a terminal state) is an orphan: it holds a compute slot and host
// volume forever because nothing in the provisioner lifecycle will ever reap
// it again. The agent_delete job removes the container as part of deletion,
// but if that SSH step fails terminally (deletion_failed) or the row is hard
// deleted out from under a still-running container, the leak goes unnoticed.
// This reconciler closes that gap with a low-cadence sweep over HEALTHY nodes.
// ---------------------------------------------------------------------------

/**
 * agent_sandboxes statuses that mean the container should NOT be running. A
 * container backing a row in one of these states is reapable just like one
 * with no row at all: the lifecycle has decided this agent has no live
 * container, so a leftover Docker process is a leak.
 *
 * `deletion_failed` is included deliberately — that state exists precisely
 * because the delete-time container teardown did not succeed, so reaping it
 * here is the recovery path. `deletion_pending` is NOT terminal: an
 * agent_delete job is actively in flight and owns the teardown; reaping under
 * it would race the worker.
 */
const TERMINAL_SANDBOX_STATUSES = new Set<string>([
  "stopped",
  "error",
  "sleeping",
  "deletion_failed",
]);

/** A container seen on a node, parsed from `docker ps -a`. */
export interface NodeContainerRef {
  /** Container name, e.g. `agent-<uuid>`. */
  name: string;
  /** Docker container id (used for the `docker rm -f` target). */
  id: string;
}

/**
 * A live agent_sandboxes row as far as orphan reconciliation cares: its id and
 * current status. A row counts as "live" when its status is not terminal.
 */
export interface LiveSandboxRef {
  id: string;
  status: string;
}

/** A container the reconciler has decided to forcibly remove. */
export interface OrphanContainer {
  /** Container name (`agent-<id>`). */
  name: string;
  /** Docker container id, the `docker rm -f` target. */
  id: string;
  /** Agent id extracted from the container name. */
  agentId: string;
  /** Why it was flagged: no DB row at all, or a row in a terminal state. */
  reason: "no_db_row" | "terminal_db_row";
}

/**
 * Extract the agent id from an `agent-<id>` container name, or null when the
 * name does not match the managed-agent pattern (so unrelated containers on a
 * shared node are never touched).
 */
export function agentIdFromContainerName(name: string): string | null {
  if (!name.startsWith(AGENT_CONTAINER_NAME_PREFIX)) return null;
  const agentId = name.slice(AGENT_CONTAINER_NAME_PREFIX.length);
  return agentId.length > 0 ? agentId : null;
}

/**
 * Pure diff: given the containers present on a node and the agent_sandboxes
 * rows that exist for those container names, decide which containers to reap.
 *
 * A container is an orphan when EITHER:
 *   - no agent_sandboxes row exists for its agent id, OR
 *   - the row exists but its status is terminal (the lifecycle has decided
 *     this agent has no live container).
 *
 * Containers whose name does not match the `agent-<id>` pattern are ignored
 * entirely — they belong to something else on the node.
 *
 * This function performs NO I/O so it can be unit-tested exhaustively.
 */
export function computeOrphanContainersToReap(
  containersOnNode: readonly NodeContainerRef[],
  liveSandboxes: readonly LiveSandboxRef[],
): OrphanContainer[] {
  const statusById = new Map<string, string>();
  for (const row of liveSandboxes) {
    statusById.set(row.id, row.status);
  }

  const orphans: OrphanContainer[] = [];
  for (const container of containersOnNode) {
    const agentId = agentIdFromContainerName(container.name);
    if (!agentId) continue;

    const status = statusById.get(agentId);
    if (status === undefined) {
      orphans.push({
        name: container.name,
        id: container.id,
        agentId,
        reason: "no_db_row",
      });
    } else if (TERMINAL_SANDBOX_STATUSES.has(status)) {
      orphans.push({
        name: container.name,
        id: container.id,
        agentId,
        reason: "terminal_db_row",
      });
    }
  }
  return orphans;
}

/** Per-node SSH surface the reconciler needs. Lets tests inject a fake node. */
export interface OrphanReconcilerNode {
  node_id: string;
  hostname: string;
  status: string;
  /**
   * List `agent-`-prefixed containers on the node over SSH. Returns null when
   * the listing failed (SSH blip) so the caller can skip the node rather than
   * misread an empty list as "no containers" and reap live work.
   */
  listAgentContainers(): Promise<NodeContainerRef[] | null>;
  /**
   * Force-remove a container by its IMMUTABLE id over SSH. Must take the id, not
   * the name: the id pins the exact container observed in the listing, so a
   * concurrent recreate of the same `agent-<id>` name cannot be reaped by
   * mistake. Implementations must NOT switch to `docker rm -f <name>`.
   */
  removeContainer(containerId: string): Promise<void>;
}

export interface OrphanReconcileResult {
  /** Nodes inspected (HEALTHY only). */
  nodesScanned: number;
  /** Nodes skipped because the SSH container listing failed. */
  nodesSkipped: number;
  /** Containers successfully force-removed. */
  reaped: number;
  /** Containers identified as orphans but whose removal failed. */
  reapFailed: number;
}

/**
 * Reconcile orphan containers on a set of HEALTHY nodes. The caller is
 * responsible for passing ONLY nodes that node-health has just confirmed
 * reachable, so a transient SSH blip never causes a live container to be
 * reaped. Per node: list `agent-` containers, diff against the live sandbox
 * ids, and force-remove every orphan.
 *
 * `loadLiveSandboxIds` returns the set of agent_sandboxes rows (id + status)
 * for the agent ids seen on the node — injected so this stays pure-ish and
 * unit-testable without a DB. The default production wiring is in
 * `reconcileOrphanContainersOnNodes`.
 */
export async function reconcileOrphanContainers(
  nodes: readonly OrphanReconcilerNode[],
  loadLiveSandboxes: (agentIds: readonly string[]) => Promise<LiveSandboxRef[]>,
): Promise<OrphanReconcileResult> {
  const result: OrphanReconcileResult = {
    nodesScanned: 0,
    nodesSkipped: 0,
    reaped: 0,
    reapFailed: 0,
  };

  for (const node of nodes) {
    if (node.status !== "healthy") {
      // Defensive: callers should already filter, but never reap on a node
      // we have not confirmed reachable.
      result.nodesSkipped += 1;
      continue;
    }

    const containersOnNode = await node.listAgentContainers();
    if (containersOnNode === null) {
      // SSH listing failed — skip rather than risk reaping live containers off
      // a misread empty list.
      result.nodesSkipped += 1;
      logger.warn("[orphan-reconciler] Skipping node: container listing failed", {
        nodeId: node.node_id,
        hostname: node.hostname,
      });
      continue;
    }
    result.nodesScanned += 1;

    const agentIds = containersOnNode
      .map((c) => agentIdFromContainerName(c.name))
      .filter((id): id is string => id !== null);
    if (agentIds.length === 0) continue;

    const liveSandboxes = await loadLiveSandboxes(agentIds);
    const orphans = computeOrphanContainersToReap(containersOnNode, liveSandboxes);

    for (const orphan of orphans) {
      try {
        // Reap by the IMMUTABLE container ID (`orphan.id`), never the name. The
        // id was captured in the same SSH listing that found the orphan, so it
        // pins THAT exact container. This is what makes the reap safe against a
        // concurrent recreate: if an agent_delete + a fresh provision race and a
        // new `agent-<id>` container is created between the listing and the rm,
        // `docker rm -f <id>` still targets the dead container we observed and
        // leaves the live one alone. A future refactor to `docker rm -f <name>`
        // would reintroduce the live-container-reap race (the name resolves to
        // whichever container holds it NOW, i.e. the new live one) — DO NOT.
        await node.removeContainer(orphan.id);
        result.reaped += 1;
        logger.info("[orphan-reconciler] Reaped orphan container", {
          nodeId: node.node_id,
          hostname: node.hostname,
          containerName: orphan.name,
          agentId: orphan.agentId,
          reason: orphan.reason,
        });
      } catch (error) {
        result.reapFailed += 1;
        logger.warn("[orphan-reconciler] Failed to reap orphan container", {
          nodeId: node.node_id,
          hostname: node.hostname,
          containerName: orphan.name,
          agentId: orphan.agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return result;
}

/** Hard per-call SSH budgets so a hung node can never wedge the reconciler. */
const ORPHAN_LIST_TIMEOUT_MS = 15_000;
const ORPHAN_RM_TIMEOUT_MS = 30_000;

/**
 * Load (id, status) for the agent_sandboxes rows matching the given agent ids,
 * including terminal-state rows. The reconciler needs the status to tell a
 * missing row (`no_db_row`) apart from a terminal one (`terminal_db_row`).
 */
async function loadSandboxStatusesByIds(agentIds: readonly string[]): Promise<LiveSandboxRef[]> {
  if (agentIds.length === 0) return [];
  return dbRead
    .select({ id: agentSandboxes.id, status: agentSandboxes.status })
    .from(agentSandboxes)
    .where(inArray(agentSandboxes.id, agentIds as string[]));
}

/**
 * Production wiring for the orphan-container reconciler: enumerate enabled,
 * HEALTHY docker nodes and reconcile each over SSH. Built on the shared
 * `DockerSSHClient` pool so it reuses warm connections. Every SSH call is
 * hard-bounded so a single unresponsive node can never stall the sweep.
 *
 * Only `status === "healthy"` nodes are touched: the caller (the daemon's
 * infra-maintenance cycle) runs this AFTER the node health-check, so a node
 * that just failed its probe is excluded and a transient SSH blip never reaps
 * live containers.
 */
export async function reconcileOrphanContainersOnNodes(): Promise<OrphanReconcileResult> {
  const enabled = await dockerNodesRepository.findEnabled();
  const healthy = enabled.filter((node) => node.status === "healthy");

  const reconcilerNodes: OrphanReconcilerNode[] = healthy.map((node) => {
    const ssh = () =>
      DockerSSHClient.getClient(
        node.hostname,
        node.ssh_port ?? undefined,
        node.host_key_fingerprint ?? undefined,
        node.ssh_user ?? undefined,
      );
    return {
      node_id: node.node_id,
      hostname: node.hostname,
      status: node.status,
      async listAgentContainers(): Promise<NodeContainerRef[] | null> {
        try {
          const client = ssh();
          await client.connect();
          const output = await client.exec(
            `docker ps -a --format '{{.Names}}|{{.ID}}' --filter name=${shellQuote(AGENT_CONTAINER_NAME_PREFIX)}`,
            ORPHAN_LIST_TIMEOUT_MS,
          );
          return (
            output
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean)
              // `--filter name=` is a substring match, so re-check the prefix to
              // exclude any container that merely contains "agent-" mid-name.
              .filter((line) => line.startsWith(AGENT_CONTAINER_NAME_PREFIX))
              .map((line) => {
                const [name = "", id = ""] = line.split("|");
                return { name, id };
              })
              .filter((c) => c.name && c.id)
          );
        } catch (error) {
          logger.warn("[orphan-reconciler] Container listing failed over SSH", {
            nodeId: node.node_id,
            hostname: node.hostname,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      },
      async removeContainer(containerId: string): Promise<void> {
        const client = ssh();
        await client.connect();
        // rm by the immutable container ID (see OrphanReconcilerNode.removeContainer
        // and the reap loop): targeting the name would race a concurrent recreate
        // of the same agent and could reap a live container. Keep this `<id>`.
        await client.exec(`docker rm -f ${shellQuote(containerId)}`, ORPHAN_RM_TIMEOUT_MS);
      },
    };
  });

  return reconcileOrphanContainers(reconcilerNodes, loadSandboxStatusesByIds);
}

/**
 * Workloads or retained state that make a node unsafe to deprovision.
 *
 * Stopped user containers still count here because they may retain local host
 * volume data on the node even though they are not consuming an active slot.
 *
 * Warm-pool rows (pool_status = 'unclaimed') are stateless replicas — the
 * node-autoscaler may evict them when draining, the pool replenisher will
 * recreate them elsewhere — so they do NOT count as retained.
 */
export async function countRetainedWorkloadsOnNode(nodeId: string): Promise<number> {
  const [containerCount, agentCount] = await Promise.all([
    countRows(
      dbRead
        .select({ count: sql<number>`count(*)::int` })
        .from(containers)
        .where(
          and(
            eq(containers.node_id, nodeId),
            sql`${containers.status} not in ('failed','deleted')`,
          ),
        ),
    ),
    countRows(
      dbRead
        .select({ count: sql<number>`count(*)::int` })
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.node_id, nodeId),
            sql`${agentSandboxes.status} not in ('stopped','error')`,
            sql`(${agentSandboxes.pool_status} is null or ${agentSandboxes.pool_status} <> 'unclaimed')`,
          ),
        ),
    ),
  ]);

  return containerCount + agentCount;
}
