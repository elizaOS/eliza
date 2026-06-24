/**
 * Orphan APP-container reconciler (Apps / Product 2).
 *
 * The sibling of the AGENT orphan reconciler in `docker-node-workloads.ts`, for
 * the OTHER kind of workload on the shared Hetzner-Docker pool: user-deployed
 * APP containers (the `containers` table, NOT `agent_sandboxes`).
 *
 * THE GAP THIS CLOSES
 * App-container teardown (`appCleanupService` / the CONTAINER_DELETE executor)
 * only runs on an EXPLICIT app delete. A mid-deploy crash or a partial failure
 * can leave an `app-<slug>` container running on a node with no live DB row (or
 * a DB row left in a dead terminal state) — it holds a compute slot and host
 * volume forever because nothing in the deploy lifecycle will ever reap it
 * again. Agents already get a periodic sweep for exactly this; apps did not.
 * This reconciler closes that gap with a low-cadence sweep over HEALTHY nodes,
 * mirroring the agent reconciler's proven safety model EXACTLY.
 *
 * SAFETY INVARIANTS (identical to the agent reconciler — a wrong reaper kills a
 * live customer app):
 *   1. Only `status === "healthy"` nodes are touched.
 *   2. If the SSH container listing returns null (listing failed) → SKIP the
 *      node, never reap (a misread empty list must not reap live containers).
 *   3. Reap by the IMMUTABLE container ID captured in the same listing — NEVER
 *      by name (avoids the delete+recreate race where the name resolves to the
 *      new live container).
 *   4. Hard per-call SSH timeouts on both the list and the rm.
 *   5. Every reap, skip, and failure is logged.
 *   6. When unsure whether a container is an orphan → DO NOT reap.
 *
 * HOW APP CONTAINERS DIFFER FROM AGENTS
 *   - App containers are named `app-<first 12 of app id>` (see
 *     `containerNameForApp` in `app-deploy-runner.ts`); the name is written
 *     verbatim to `containers.name`. The diff key is therefore the container
 *     NAME itself, not an id parsed out of the name (agents key on the agent id
 *     embedded in `agent-<id>`).
 *   - The backing row lives in `containers`, with the status vocab
 *     pending | building | deploying | running | stopped | failed | deleting |
 *     deleted. A container is LIVE (do NOT reap) when its row is in
 *     pending/building/deploying/running/deleting (`deleting` = a delete job is
 *     in flight and owns teardown — reaping under it would race the worker). It
 *     is an ORPHAN (reap) when its row is MISSING (`no_db_row`) or in a dead
 *     terminal state stopped/failed/deleted (`terminal_db_row`).
 *
 * Non-`app-`-prefixed containers on a shared node (agents `agent-…`, the older
 * direct `cloud-container-…` provider path, infra containers like postgres) are
 * never matched by the `--filter name=app-` listing and never touched here.
 */

import { inArray } from "drizzle-orm";
import { dbRead } from "../../db/helpers";
import { dockerNodesRepository } from "../../db/repositories/docker-nodes";
import { containers } from "../../db/schemas/containers";
import { logger } from "../utils/logger";
import { shellQuote } from "./docker-sandbox-utils";
import { DockerSSHClient } from "./docker-ssh";

/**
 * The prefix every Apps/Product-2 container name carries. Kept in lockstep with
 * `containerNameForApp` (`app-<slug>`) in `app-deploy-runner.ts`. Defined here
 * (rather than imported) so this safety-critical reaper has no dependency on the
 * deploy-runner module graph; if that prefix ever changes, the two must change
 * together.
 */
export const APP_CONTAINER_NAME_PREFIX = "app-";

/**
 * `containers.status` values that mean the container should NOT be running. A
 * container backing a row in one of these states is reapable just like one with
 * no row at all: the deploy lifecycle has decided this app has no live
 * container, so a leftover Docker process is a leak.
 *
 * `stopped` and `failed` are the recovery cases — they exist precisely because a
 * deploy ended (cleanly or in error) without the host container being removed.
 * `deleted` is the hard-terminal state. `deleting` is NOT included: a delete job
 * is actively in flight and owns the teardown; reaping under it would race the
 * worker (the exact mirror of the agent reconciler excluding `deletion_pending`).
 */
const TERMINAL_CONTAINER_STATUSES = new Set<string>(["stopped", "failed", "deleted"]);

/** A container seen on a node, parsed from `docker ps -a`. */
export interface NodeAppContainerRef {
  /** Container name, e.g. `app-<slug>`. */
  name: string;
  /** Docker container id (used for the `docker rm -f` target). */
  id: string;
}

/**
 * A `containers` row as far as orphan reconciliation cares: its name and
 * current status. A row counts as "live" when its status is not terminal.
 */
export interface LiveAppContainerRef {
  name: string;
  status: string;
}

/** A container the reconciler has decided to forcibly remove. */
export interface OrphanAppContainer {
  /** Container name (`app-<slug>`). */
  name: string;
  /** Docker container id, the `docker rm -f` target. */
  id: string;
  /** Why it was flagged: no DB row at all, or a row in a terminal state. */
  reason: "no_db_row" | "terminal_db_row";
}

/**
 * True for a name that belongs to the managed-app pattern (`app-<slug>`), so
 * unrelated containers on a shared node are never considered. A bare `app-`
 * with no slug is rejected (mirrors the agent reconciler rejecting `agent-`).
 */
export function isAppContainerName(name: string): boolean {
  return (
    name.startsWith(APP_CONTAINER_NAME_PREFIX) && name.length > APP_CONTAINER_NAME_PREFIX.length
  );
}

/**
 * Pure diff: given the containers present on a node and the `containers` rows
 * that exist for those container names, decide which containers to reap.
 *
 * A container is an orphan when EITHER:
 *   - no `containers` row exists for its name (`no_db_row`), OR
 *   - the row exists but its status is terminal (`terminal_db_row`) — the deploy
 *     lifecycle has decided this app has no live container.
 *
 * Containers whose name does not match the `app-<slug>` pattern are ignored
 * entirely — they belong to something else on the node.
 *
 * This function performs NO I/O so it can be unit-tested exhaustively.
 */
export function computeOrphanAppContainersToReap(
  containersOnNode: readonly NodeAppContainerRef[],
  liveContainers: readonly LiveAppContainerRef[],
): OrphanAppContainer[] {
  const statusByName = new Map<string, string>();
  for (const row of liveContainers) {
    statusByName.set(row.name, row.status);
  }

  const orphans: OrphanAppContainer[] = [];
  for (const container of containersOnNode) {
    if (!isAppContainerName(container.name)) continue;

    const status = statusByName.get(container.name);
    if (status === undefined) {
      orphans.push({ name: container.name, id: container.id, reason: "no_db_row" });
    } else if (TERMINAL_CONTAINER_STATUSES.has(status)) {
      orphans.push({ name: container.name, id: container.id, reason: "terminal_db_row" });
    }
  }
  return orphans;
}

/** Per-node SSH surface the reconciler needs. Lets tests inject a fake node. */
export interface AppOrphanReconcilerNode {
  node_id: string;
  hostname: string;
  status: string;
  /**
   * List `app-`-prefixed containers on the node over SSH. Returns null when the
   * listing failed (SSH blip) so the caller can skip the node rather than
   * misread an empty list as "no containers" and reap live work.
   */
  listAppContainers(): Promise<NodeAppContainerRef[] | null>;
  /**
   * Force-remove a container by its IMMUTABLE id over SSH. Must take the id, not
   * the name: the id pins the exact container observed in the listing, so a
   * concurrent recreate of the same `app-<slug>` name cannot be reaped by
   * mistake. Implementations must NOT switch to `docker rm -f <name>`.
   */
  removeContainer(containerId: string): Promise<void>;
}

export interface AppOrphanReconcileResult {
  /** Nodes inspected (HEALTHY only). */
  nodesScanned: number;
  /** Nodes skipped because the SSH container listing failed (or not healthy). */
  nodesSkipped: number;
  /** Containers successfully force-removed. */
  reaped: number;
  /** Containers identified as orphans but whose removal failed. */
  reapFailed: number;
}

/**
 * Reconcile orphan APP containers on a set of HEALTHY nodes. The caller is
 * responsible for passing ONLY nodes that node-health has just confirmed
 * reachable, so a transient SSH blip never causes a live container to be reaped.
 * Per node: list `app-` containers, diff against the live `containers` rows, and
 * force-remove every orphan.
 *
 * `loadLiveAppContainers` returns the `containers` rows (name + status) for the
 * container names seen on the node — injected so this stays pure-ish and
 * unit-testable without a DB. The default production wiring is in
 * `reconcileOrphanAppContainersOnNodes`.
 */
export async function reconcileOrphanAppContainers(
  nodes: readonly AppOrphanReconcilerNode[],
  loadLiveAppContainers: (names: readonly string[]) => Promise<LiveAppContainerRef[]>,
): Promise<AppOrphanReconcileResult> {
  const result: AppOrphanReconcileResult = {
    nodesScanned: 0,
    nodesSkipped: 0,
    reaped: 0,
    reapFailed: 0,
  };

  for (const node of nodes) {
    if (node.status !== "healthy") {
      // Defensive: callers should already filter, but never reap on a node we
      // have not confirmed reachable.
      result.nodesSkipped += 1;
      continue;
    }

    const containersOnNode = await node.listAppContainers();
    if (containersOnNode === null) {
      // SSH listing failed — skip rather than risk reaping live containers off a
      // misread empty list.
      result.nodesSkipped += 1;
      logger.warn("[app-orphan-reconciler] Skipping node: container listing failed", {
        nodeId: node.node_id,
        hostname: node.hostname,
      });
      continue;
    }
    result.nodesScanned += 1;

    const names = containersOnNode.map((c) => c.name).filter((name) => isAppContainerName(name));
    if (names.length === 0) continue;

    const liveContainers = await loadLiveAppContainers(names);
    const orphans = computeOrphanAppContainersToReap(containersOnNode, liveContainers);

    for (const orphan of orphans) {
      try {
        // Reap by the IMMUTABLE container ID (`orphan.id`), never the name. The
        // id was captured in the same SSH listing that found the orphan, so it
        // pins THAT exact container. This is what makes the reap safe against a
        // concurrent recreate: if a delete + a fresh deploy race and a new
        // `app-<slug>` container is created between the listing and the rm,
        // `docker rm -f <id>` still targets the dead container we observed and
        // leaves the live one alone. A future refactor to `docker rm -f <name>`
        // would reintroduce the live-container-reap race (the name resolves to
        // whichever container holds it NOW, i.e. the new live one) — DO NOT.
        await node.removeContainer(orphan.id);
        result.reaped += 1;
        logger.info("[app-orphan-reconciler] Reaped orphan app container", {
          nodeId: node.node_id,
          hostname: node.hostname,
          containerName: orphan.name,
          reason: orphan.reason,
        });
      } catch (error) {
        result.reapFailed += 1;
        logger.warn("[app-orphan-reconciler] Failed to reap orphan app container", {
          nodeId: node.node_id,
          hostname: node.hostname,
          containerName: orphan.name,
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
 * Load (name, status) for the `containers` rows matching the given container
 * names, including terminal-state rows. The reconciler needs the status to tell
 * a missing row (`no_db_row`) apart from a terminal one (`terminal_db_row`).
 */
async function loadContainerStatusesByNames(
  names: readonly string[],
): Promise<LiveAppContainerRef[]> {
  if (names.length === 0) return [];
  return dbRead
    .select({ name: containers.name, status: containers.status })
    .from(containers)
    .where(inArray(containers.name, names as string[]));
}

/**
 * Production wiring for the orphan APP-container reconciler: enumerate enabled,
 * HEALTHY docker nodes and reconcile each over SSH. Built on the shared
 * `DockerSSHClient` pool so it reuses warm connections. Every SSH call is
 * hard-bounded so a single unresponsive node can never stall the sweep.
 *
 * Only `status === "healthy"` nodes are touched: the caller (the daemon's
 * infra-maintenance cycle) runs this AFTER the node health-check, so a node that
 * just failed its probe is excluded and a transient SSH blip never reaps live
 * containers.
 */
export async function reconcileOrphanAppContainersOnNodes(): Promise<AppOrphanReconcileResult> {
  const enabled = await dockerNodesRepository.findEnabled();
  const healthy = enabled.filter((node) => node.status === "healthy");

  const reconcilerNodes: AppOrphanReconcilerNode[] = healthy.map((node) => {
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
      async listAppContainers(): Promise<NodeAppContainerRef[] | null> {
        try {
          const client = ssh();
          await client.connect();
          const output = await client.exec(
            `docker ps -a --format '{{.Names}}|{{.ID}}' --filter name=${shellQuote(APP_CONTAINER_NAME_PREFIX)}`,
            ORPHAN_LIST_TIMEOUT_MS,
          );
          return (
            output
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean)
              // `--filter name=` is a substring match, so re-check the prefix to
              // exclude any container that merely contains "app-" mid-name.
              .filter((line) => line.startsWith(APP_CONTAINER_NAME_PREFIX))
              .map((line) => {
                const [name = "", id = ""] = line.split("|");
                return { name, id };
              })
              .filter((c) => c.name && c.id)
          );
        } catch (error) {
          logger.warn("[app-orphan-reconciler] Container listing failed over SSH", {
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
        // rm by the immutable container ID (see AppOrphanReconcilerNode.removeContainer
        // and the reap loop): targeting the name would race a concurrent recreate
        // of the same app and could reap a live container. Keep this `<id>`.
        await client.exec(`docker rm -f ${shellQuote(containerId)}`, ORPHAN_RM_TIMEOUT_MS);
      },
    };
  });

  return reconcileOrphanAppContainers(reconcilerNodes, loadContainerStatusesByNames);
}
