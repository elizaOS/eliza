// Coordinates cloud service docker node workloads behavior behind route handlers.
import { and, eq, inArray, sql } from "drizzle-orm";
import { dbRead } from "../../db/helpers";
import { agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { containers } from "../../db/schemas/containers";
import { AGENT_CONTAINER_NAME_PREFIX } from "./docker-sandbox-utils";
import {
  type LiveContainerRef,
  type OrphanReconcileResult,
  type OrphanReconcilerConfig,
  reconcileOrphanContainersOnNodes as reconcileOrphanContainersOnNodesShared,
} from "./orphan-container-reconciler";

// Re-export the shared result type so existing importers (the daemon) keep
// `OrphanReconcileResult` from this module.
export type { OrphanReconcileResult } from "./orphan-container-reconciler";

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
// Orphan AGENT-container reconciliation
//
// A container named `agent-<id>` on a node whose agent_sandboxes row has been
// deleted (or moved to a terminal state) is an orphan: it holds a compute slot
// and host volume forever because nothing in the provisioner lifecycle will
// ever reap it again. The agent_delete job removes the container as part of
// deletion, but if that SSH step fails terminally (deletion_failed) or the row
// is hard deleted out from under a still-running container, the leak goes
// unnoticed. This reconciler closes that gap with a low-cadence sweep over
// HEALTHY nodes.
//
// The orchestration, SSH wiring, timeouts, and reap-by-id rm are shared with
// the app reconciler in `orphan-container-reconciler.ts`. This module injects
// only the three agent-specific deltas: the `agent-` prefix, the `keyOf` that
// parses the id out of `agent-<id>`, and the agent terminal-status vocab (plus
// the agent_sandboxes status query and a log tag).
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

/**
 * Extract the agent id from an `agent-<id>` container name, or null when the
 * name does not match the managed-agent pattern (so unrelated containers on a
 * shared node are never touched). This is the agent reconciler's `keyOf`:
 * agents key the diff on the id embedded in the name (the PRIMARY KEY
 * `agent_sandboxes.id`), whereas apps key on the name itself.
 */
export function agentIdFromContainerName(name: string): string | null {
  if (!name.startsWith(AGENT_CONTAINER_NAME_PREFIX)) return null;
  const agentId = name.slice(AGENT_CONTAINER_NAME_PREFIX.length);
  return agentId.length > 0 ? agentId : null;
}

/**
 * Load (key, status) for the agent_sandboxes rows matching the given agent ids,
 * including terminal-state rows. The reconciler needs the status to tell a
 * missing row (`no_db_row`) apart from a terminal one (`terminal_db_row`).
 * `agent_sandboxes.id` is a PRIMARY KEY, so each key maps to at most one row.
 */
async function loadSandboxStatusesByIds(agentIds: readonly string[]): Promise<LiveContainerRef[]> {
  if (agentIds.length === 0) return [];
  return dbRead
    .select({ key: agentSandboxes.id, status: agentSandboxes.status })
    .from(agentSandboxes)
    .where(inArray(agentSandboxes.id, agentIds as string[]));
}

/** The three agent-specific deltas injected into the shared reconciler. */
const AGENT_ORPHAN_RECONCILER_CONFIG: OrphanReconcilerConfig = {
  prefix: AGENT_CONTAINER_NAME_PREFIX,
  keyOf: agentIdFromContainerName,
  terminalStatuses: TERMINAL_SANDBOX_STATUSES,
  loadStatuses: loadSandboxStatusesByIds,
  logScope: "orphan-reconciler",
};

/**
 * Production wiring for the orphan AGENT-container reconciler. Delegates to the
 * shared sweep with the agent deltas. The daemon imports this name.
 */
export function reconcileOrphanContainersOnNodes(): Promise<OrphanReconcileResult> {
  return reconcileOrphanContainersOnNodesShared(AGENT_ORPHAN_RECONCILER_CONFIG);
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
