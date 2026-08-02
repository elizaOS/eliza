/**
 * Supplies workload accounting and agent-specific ownership resolution for the
 * shared Docker-node control plane. The orphan-reaper adapter preserves both
 * canonical and cleanup-fenced physical container names because warm claims
 * and blue/green swaps can make either name differ from the sandbox row ID.
 */
import { ElizaError } from "@elizaos/core";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { ensureAgentSandboxSchema } from "../../db/ensure-agent-sandbox-schema";
import { dbRead, dbWrite } from "../../db/helpers";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { containers } from "../../db/schemas/containers";
import {
  countAllocatedWorkloadsOnNodeWithDatabase,
  TERMINAL_SANDBOX_STATUS_SET,
  TERMINAL_SANDBOX_STATUSES,
} from "./docker-node-workload-queries";
import { AGENT_CONTAINER_NAME_PREFIX } from "./docker-sandbox-utils";
import {
  DEFAULT_NODE_MOVE_GRACE_MS,
  DEFAULT_ROWLESS_GRACE_MS,
  type LiveContainerRef,
  type OrphanReconcileResult,
  type OrphanReconcilerConfig,
  reconcileOrphanContainersOnNodes as reconcileOrphanContainersOnNodesShared,
} from "./orphan-container-reconciler";

export type { OrphanReconcileResult } from "./orphan-container-reconciler";

async function countRows(query: Promise<Array<{ count: number }>>): Promise<number> {
  const [row] = await query;
  if (!row) {
    throw new ElizaError("Workload count query returned no aggregate row", {
      code: "DOCKER_NODE_WORKLOAD_COUNT_MISSING",
    });
  }
  return row.count;
}

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

/**
 * Active compute slots on a Docker node.
 *
 * Stopped containers are intentionally excluded here because their Docker
 * process has been removed and `allocated_count` should represent live slot
 * pressure, not retained storage.
 *
 * The agent side excludes the same {@link TERMINAL_SANDBOX_STATUSES} the orphan
 * reconciler uses to decide a container "should NOT be running" — a row in one
 * of those states holds no live slot — EXCEPT where a deletion generation still
 * records ownership of one. A `deletion_failed` row exists precisely because
 * teardown did not succeed, so while its container is still out there it does
 * occupy a slot, and counting it is what stops a delete that cannot prove
 * absence from freeing a live sibling's capacity (#17185). That does not
 * reintroduce the inflation of #15378, because ownership is not open-ended: the
 * orphan reaper releases it in the same sweep that removes the container, so an
 * abandoned deletion stops counting the moment its container is proven gone.
 * `disconnected` is deliberately NOT excluded: it is non-terminal (the
 * container is up but unreachable) and still occupies the slot.
 */
export async function countAllocatedWorkloadsOnNode(nodeId: string): Promise<number> {
  // This is the placement hot path (`getAvailableNode`, the autoscaler,
  // `syncAllocatedCounts`), and the query reads ownership columns added after
  // the base table. The provisioning worker deploys without a `migrate-db`
  // gate, so on a pre-migration rollout an unguarded read fails closed and NO
  // agent can be placed. Ensure is memoized per database URL, so the DDL runs
  // once per isolate; the residual per-call cost is the env lookup, not I/O.
  // Deliberately on this wrapper rather than the injected-database variant,
  // which stays hermetic for tests.
  await ensureAgentSandboxSchema();
  return countAllocatedWorkloadsOnNodeWithDatabase(dbRead, nodeId);
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
 * Load every owned placement for the agent_sandboxes rows matching the given
 * ids. A replacement fence owns a second real container until its exact remote
 * retirement and capacity release complete, so both primary and replacement
 * nodes must protect that key from the orphan reaper.
 *
 * Physical names are durable ownership keys in addition to the sandbox row ID.
 * A warm-claimed container keeps `agent-<pool id>` after the pool row is
 * deleted and the transient source ID is cleared. A cleanup-fenced container
 * likewise keeps its old physical name across a blue/green cutover. Each name
 * aliases only its own placement so unrelated containers on the other node do
 * not inherit protection. This destructive ownership check reads the primary:
 * replica lag must never turn a live row into an apparent orphan.
 */
export async function loadSandboxStatusesByIds(
  agentIds: readonly string[],
): Promise<LiveContainerRef[]> {
  if (agentIds.length === 0) return [];
  const queriedIds = new Set(agentIds);
  const queriedKeys = [...queriedIds];
  const queriedContainerNames = queriedKeys.map((id) => `${AGENT_CONTAINER_NAME_PREFIX}${id}`);
  const rows = await dbWrite
    .select({
      key: agentSandboxes.id,
      containerName: agentSandboxes.container_name,
      status: agentSandboxes.status,
      nodeId: agentSandboxes.node_id,
      updatedAt: agentSandboxes.updated_at,
      replacementNodeId: agentSandboxes.replacement_cleanup_node_id,
      replacementContainerName: agentSandboxes.replacement_cleanup_container_name,
      replacementCreatedAt: agentSandboxes.replacement_cleanup_created_at,
    })
    .from(agentSandboxes)
    .where(
      or(
        inArray(agentSandboxes.id, queriedKeys),
        inArray(agentSandboxes.container_name, queriedContainerNames),
        inArray(agentSandboxes.replacement_cleanup_container_name, queriedContainerNames),
      ),
    );
  return rows.flatMap((row) => {
    const placements: LiveContainerRef[] = [];
    const appendPlacement = (
      placement: LiveContainerRef,
      physicalContainerName: string | null,
    ): void => {
      placements.push(placement);
      const nameKey = physicalContainerName
        ? agentIdFromContainerName(physicalContainerName)
        : null;
      if (nameKey && nameKey !== row.key && queriedIds.has(nameKey)) {
        placements.push({ ...placement, key: nameKey });
      }
    };

    appendPlacement(
      {
        key: row.key,
        status: row.status,
        nodeId: row.nodeId ?? undefined,
        updatedAtMs: row.updatedAt ? new Date(row.updatedAt).getTime() : undefined,
      },
      row.containerName,
    );
    if (row.replacementNodeId) {
      appendPlacement(
        {
          key: row.key,
          status: "replacement_cleanup_owned",
          nodeId: row.replacementNodeId,
          updatedAtMs: row.replacementCreatedAt
            ? new Date(row.replacementCreatedAt).getTime()
            : undefined,
        },
        row.replacementContainerName,
      );
    }
    return placements;
  });
}

/**
 * The agent-specific deltas injected into the shared reconciler. Agents are
 * `nodeAware`: a sandbox has exactly one canonical node (`node_id`), so a
 * container found on any OTHER node is a stale twin from a re-provision that
 * moved the workload (#15228). Apps deliberately fan one name across rows and
 * are NOT node-aware.
 */
/**
 * Exported so a test can drive the REAL wiring rather than a copy: the contract
 * that `keyOf` yields an `agent_sandboxes.id` — which `onReaped` then feeds to a
 * CAS keyed on that column — is an assumption spanning two modules, and a copy
 * of the config in a test would assert nothing about the one production uses.
 */
export const AGENT_ORPHAN_RECONCILER_CONFIG: OrphanReconcilerConfig = {
  prefix: AGENT_CONTAINER_NAME_PREFIX,
  keyOf: agentIdFromContainerName,
  terminalStatuses: TERMINAL_SANDBOX_STATUS_SET,
  loadStatuses: loadSandboxStatusesByIds,
  logScope: "orphan-reconciler",
  nodeAware: true,
  rowlessGraceMs: DEFAULT_ROWLESS_GRACE_MS,
  nodeMoveGraceMs: DEFAULT_NODE_MOVE_GRACE_MS,
  // Reaping is the only step that PROVES an agent container is gone, so it is
  // where a deletion generation that could not prove absence finally hands its
  // node slot back (#17185).
  onReaped: async (agentId, nodeId) => {
    await agentSandboxesRepository.releaseDeletionAllocationOnReap(agentId, nodeId);
  },
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
  const [containerCount, agentCount, replacementCount] = await Promise.all([
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
    countRows(
      dbRead
        .select({ count: sql<number>`count(*)::int` })
        .from(agentSandboxes)
        .where(eq(agentSandboxes.replacement_cleanup_node_id, nodeId)),
    ),
  ]);

  return containerCount + agentCount + replacementCount;
}
