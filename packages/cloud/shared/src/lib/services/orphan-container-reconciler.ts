/**
 * Shared orphan-container reconciler for the shared Hetzner-Docker pool.
 *
 * ONE generic sweep used by BOTH workload kinds that run on the pool:
 *   - AGENT containers (`agent-<id>`, backed by `agent_sandboxes`) — wired in
 *     `docker-node-workloads.ts`.
 *   - APP containers (`app-<slug>`, backed by `containers`) — wired in
 *     `app-container-orphan-reconciler.ts`.
 *
 * THE GAP THIS CLOSES
 * A managed container on a node whose DB row has been deleted (or moved to a
 * terminal state) is an orphan: it holds a compute slot and host volume forever
 * because nothing in the provisioner / deploy lifecycle will ever reap it again.
 * The delete job removes the container as part of deletion, but if that SSH step
 * fails terminally or the row is hard-deleted out from under a still-running
 * container, the leak goes unnoticed. This reconciler closes that gap with a
 * low-cadence sweep over HEALTHY nodes.
 *
 * SAFETY INVARIANTS (a wrong reaper kills a live customer workload):
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
 * THE ONLY THINGS THAT DIFFER between the agent and app paths are injected via
 * `OrphanReconcilerConfig`: the container-name `prefix`, the `keyOf` that maps a
 * name to its DB diff key (agents parse the id out of `agent-<id>`; apps use the
 * name itself), the `terminalStatuses` vocab, the `loadStatuses` DB query, and a
 * `logScope` tag. Everything else — the orchestration loop, the SSH wiring, the
 * timeouts, the reap-by-id rm — is identical and lives here once.
 */

import { dockerNodesRepository } from "../../db/repositories/docker-nodes";
import { logger } from "../utils/logger";
import { shellQuote } from "./docker-sandbox-utils";
import { DockerSSHClient } from "./docker-ssh";

/** A container seen on a node, parsed from `docker ps -a`. */
export interface NodeContainerRef {
  /** Container name, e.g. `agent-<uuid>` or `app-<slug>`. */
  name: string;
  /** Docker container id (used for the `docker rm -f` target). */
  id: string;
}

/**
 * A live DB row as far as orphan reconciliation cares: its diff key and current
 * status. A key counts as "live" when ANY of its rows is non-terminal.
 */
export interface LiveContainerRef {
  /** Diff key — the agent id (agents) or the container name (apps). */
  key: string;
  status: string;
  /**
   * The node this row's canonical container lives on. Only populated (and only
   * consulted) by node-aware reconcilers: a container on node X whose live row
   * points at a DIFFERENT node is a stale twin left behind by a re-provision
   * that moved the workload (see `wrong_node`). Absent for apps.
   */
  nodeId?: string;
  /**
   * When this row was last written (epoch ms). Node-aware reaping only trusts a
   * `nodeId` mismatch once the row has been stable for `nodeMoveGraceMs`, so a
   * container observed mid-provision (its healthy on node X before the row is
   * updated to X) is never mistaken for a stale twin. Absent for apps.
   */
  updatedAtMs?: number;
}

/** A container the reconciler has decided to forcibly remove. */
export interface OrphanContainer {
  /** Container name (`agent-<id>` / `app-<slug>`). */
  name: string;
  /** Docker container id, the `docker rm -f` target. */
  id: string;
  /** Diff key this container mapped to (agent id, or the name itself). */
  key: string;
  /**
   * Why it was flagged: no DB row at all, every row in a terminal state, or —
   * for node-aware reconcilers — a live row that has stably pointed at a
   * DIFFERENT node (`wrong_node`, the re-provision-left-a-twin case).
   */
  reason: "no_db_row" | "terminal_db_row" | "wrong_node";
}

/** Per-node SSH surface the reconciler needs. Lets tests inject a fake node. */
export interface OrphanReconcilerNode {
  node_id: string;
  hostname: string;
  status: string;
  /**
   * List prefix-matching containers on the node over SSH. Returns null when the
   * listing failed (SSH blip) so the caller can skip the node rather than
   * misread an empty list as "no containers" and reap live work.
   */
  listContainers(): Promise<NodeContainerRef[] | null>;
  /**
   * Force-remove a container by its IMMUTABLE id over SSH. Must take the id, not
   * the name: the id pins the exact container observed in the listing, so a
   * concurrent recreate of the same name cannot be reaped by mistake.
   * Implementations must NOT switch to `docker rm -f <name>`.
   */
  removeContainer(containerId: string): Promise<void>;
}

export interface OrphanReconcileResult {
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
 * The per-workload deltas — the ONLY things that differ between the agent and
 * app reconcilers. Everything else in this module is shared verbatim.
 */
export interface OrphanReconcilerConfig {
  /** Container-name prefix to list and re-filter on (`agent-` / `app-`). */
  prefix: string;
  /**
   * Map a container name to its DB diff key, or null when the name does not
   * match the managed pattern (so unrelated containers are never touched).
   * Agents parse the id out of `agent-<id>`; apps use the name itself.
   */
  keyOf(name: string): string | null;
  /** DB statuses that mean the container should NOT be running (reapable). */
  terminalStatuses: ReadonlySet<string>;
  /**
   * Load (key, status) for the DB rows matching the given diff keys, including
   * terminal-state rows. The reconciler needs the status to tell a missing row
   * (`no_db_row`) apart from a terminal one (`terminal_db_row`). May return
   * MULTIPLE rows per key — the diff groups them and is fail-safe.
   */
  loadStatuses(keys: readonly string[]): Promise<LiveContainerRef[]>;
  /** Log tag, e.g. `orphan-reconciler` / `app-orphan-reconciler`. */
  logScope: string;
  /**
   * Opt in to node-aware reaping: also reap a container on node X when the
   * workload has a live row but every live row points at a DIFFERENT node (a
   * re-provision moved the workload and left this twin behind). Requires
   * `loadStatuses` to populate `nodeId` + `updatedAtMs`. Agents set this;
   * apps (which legitimately fan a name across rows) leave it off.
   */
  nodeAware?: boolean;
  /**
   * How long a `nodeId` mismatch must persist before the twin is reaped
   * (epoch-ms delta against the row's `updatedAtMs`). Guards the provision race
   * where a container is healthy on its new node before the DB row catches up.
   * Defaults to `DEFAULT_NODE_MOVE_GRACE_MS` when node-aware and unset.
   */
  nodeMoveGraceMs?: number;
}

/**
 * A stale twin must have been "wrong-noded" for at least this long before it is
 * reaped — long enough that a normal provision (create container → confirm
 * healthy → update row's node_id) has written the row, so the freshly-healthy
 * NEW container is never mistaken for the twin during its own creation window.
 */
export const DEFAULT_NODE_MOVE_GRACE_MS = 5 * 60_000;

/**
 * Pure diff: given the containers present on a node and the DB rows that exist
 * for those container keys, decide which containers to reap.
 *
 * A container is an orphan when EITHER:
 *   - no DB row exists for its key (`no_db_row`), OR
 *   - rows exist but EVERY one of them is terminal (`terminal_db_row`) — the
 *     lifecycle has decided this workload has no live container.
 *
 * FAIL-SAFE grouping (#9307): a single key can map to MULTIPLE DB rows. For
 * apps, `containers.name` has NO unique constraint — every deploy inserts a
 * fresh row and leaves prior rows behind in running/stopped/failed, so the row
 * set for one name is routinely a mix like `[running, stopped]`. We group all
 * statuses per key and reap ONLY when EVERY row is terminal: a name is LIVE
 * (never reaped) if ANY of its rows is non-terminal. This is order-independent,
 * so it does not matter that the `WHERE key IN (...)` query has no ORDER BY.
 *
 * For agents the key is `agent_sandboxes.id`, a PRIMARY KEY, so each key maps to
 * AT MOST ONE row — the per-key list is a singleton and `every(terminal)`
 * reduces to the single-row terminal check, i.e. identical reaping decisions to
 * the previous last-write-wins map. (Proof of behavior-preservation.)
 *
 * Containers whose name does not match the managed pattern are ignored
 * entirely — they belong to something else on the node.
 *
 * NODE-AWARE reaping (opt-in, `config.nodeAware`): a workload can have a live
 * (non-terminal) row that points at a DIFFERENT node than the one this container
 * sits on. That is the re-provision-left-a-twin case (#15228): the worker moved
 * the agent to a new node and never tore down the old container, which then
 * holds the headscale identity and makes the new registration flap. We reap the
 * twin ONLY when EVERY live row for the key points elsewhere AND the newest such
 * row has been stable for `nodeMoveGraceMs` — so a container that is merely
 * healthy-before-its-own-row-updates during a normal provision is protected.
 * When any live row points at THIS node, the container is the canonical one and
 * is kept.
 *
 * `nowMs` is injected (not read from the clock) so this function performs NO I/O
 * and can be unit-tested exhaustively.
 */
export function computeOrphanContainersToReap(
  containersOnNode: readonly NodeContainerRef[],
  liveRows: readonly LiveContainerRef[],
  config: Pick<
    OrphanReconcilerConfig,
    "keyOf" | "terminalStatuses" | "nodeAware" | "nodeMoveGraceMs"
  >,
  nodeId?: string,
  nowMs?: number,
): OrphanContainer[] {
  // Group the full row objects per key (a key can have >1 DB rows for apps —
  // there is no unique constraint on containers.name; for agents the key is a PK
  // so the list is always a singleton).
  const rowsByKey = new Map<string, LiveContainerRef[]>();
  for (const row of liveRows) {
    const list = rowsByKey.get(row.key) ?? [];
    list.push(row);
    rowsByKey.set(row.key, list);
  }

  const nodeAware = config.nodeAware === true && nodeId !== undefined;
  const graceMs = config.nodeMoveGraceMs ?? DEFAULT_NODE_MOVE_GRACE_MS;

  const orphans: OrphanContainer[] = [];
  for (const container of containersOnNode) {
    const key = config.keyOf(container.name);
    if (key === null) continue;

    const rows = rowsByKey.get(key);
    if (rows === undefined || rows.length === 0) {
      orphans.push({ name: container.name, id: container.id, key, reason: "no_db_row" });
      continue;
    }
    if (rows.every((r) => config.terminalStatuses.has(r.status))) {
      // Reap ONLY when EVERY row is terminal — any live row protects the key.
      orphans.push({ name: container.name, id: container.id, key, reason: "terminal_db_row" });
      continue;
    }

    // A live (non-terminal) row exists. In node-aware mode, this container is a
    // stale twin iff NONE of the live rows point at this node — the canonical
    // container lives elsewhere. Require the newest such mismatching row to have
    // been stable past the grace window before reaping.
    if (nodeAware) {
      const liveRows_ = rows.filter((r) => !config.terminalStatuses.has(r.status));
      const anyOnThisNode = liveRows_.some((r) => r.nodeId === nodeId);
      if (anyOnThisNode) continue;
      // Only reap if every live row carries a node (else we can't prove
      // elsewhere) and the freshest is older than the grace window.
      const stamps = liveRows_.map((r) => r.updatedAtMs);
      const allHaveNodeAndStamp = liveRows_.every(
        (r) => r.nodeId !== undefined && r.updatedAtMs !== undefined,
      );
      if (!allHaveNodeAndStamp) continue;
      const newest = Math.max(...(stamps as number[]));
      if (nowMs !== undefined && nowMs - newest >= graceMs) {
        orphans.push({ name: container.name, id: container.id, key, reason: "wrong_node" });
      }
    }
  }
  return orphans;
}

/**
 * Reconcile orphan containers on a set of HEALTHY nodes. The caller is
 * responsible for passing ONLY nodes that node-health has just confirmed
 * reachable, so a transient SSH blip never causes a live container to be reaped.
 * Per node: list prefix containers, diff against the live DB rows, and
 * force-remove every orphan.
 *
 * `config.loadStatuses` returns the DB rows (key + status) for the keys seen on
 * the node — injected so this stays pure-ish and unit-testable without a DB. The
 * default production wiring is in `reconcileOrphanContainersOnNodes`.
 */
export async function reconcileOrphanContainers(
  nodes: readonly OrphanReconcilerNode[],
  config: OrphanReconcilerConfig,
): Promise<OrphanReconcileResult> {
  const result: OrphanReconcileResult = {
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

    const containersOnNode = await node.listContainers();
    if (containersOnNode === null) {
      // SSH listing failed — skip rather than risk reaping live containers off a
      // misread empty list.
      result.nodesSkipped += 1;
      logger.warn(`[${config.logScope}] Skipping node: container listing failed`, {
        nodeId: node.node_id,
        hostname: node.hostname,
      });
      continue;
    }
    result.nodesScanned += 1;

    const keys = containersOnNode
      .map((c) => config.keyOf(c.name))
      .filter((key): key is string => key !== null);
    if (keys.length === 0) continue;

    const liveRows = await config.loadStatuses(keys);
    const orphans = computeOrphanContainersToReap(
      containersOnNode,
      liveRows,
      config,
      node.node_id,
      Date.now(),
    );

    for (const orphan of orphans) {
      try {
        // Reap by the IMMUTABLE container ID (`orphan.id`), never the name. The
        // id was captured in the same SSH listing that found the orphan, so it
        // pins THAT exact container. This is what makes the reap safe against a
        // concurrent recreate: if a delete + a fresh provision/deploy race and a
        // new container is created between the listing and the rm,
        // `docker rm -f <id>` still targets the dead container we observed and
        // leaves the live one alone. A future refactor to `docker rm -f <name>`
        // would reintroduce the live-container-reap race (the name resolves to
        // whichever container holds it NOW, i.e. the new live one) — DO NOT.
        await node.removeContainer(orphan.id);
        result.reaped += 1;
        logger.info(`[${config.logScope}] Reaped orphan container`, {
          nodeId: node.node_id,
          hostname: node.hostname,
          containerName: orphan.name,
          key: orphan.key,
          reason: orphan.reason,
        });
      } catch (error) {
        result.reapFailed += 1;
        logger.warn(`[${config.logScope}] Failed to reap orphan container`, {
          nodeId: node.node_id,
          hostname: node.hostname,
          containerName: orphan.name,
          key: orphan.key,
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
 * Production wiring for the orphan-container reconciler: enumerate enabled,
 * HEALTHY docker nodes and reconcile each over SSH. Built on the shared
 * `DockerSSHClient` pool so it reuses warm connections. Every SSH call is
 * hard-bounded so a single unresponsive node can never stall the sweep.
 *
 * Only `status === "healthy"` nodes are touched: the caller (the daemon's
 * infra-maintenance cycle) runs this AFTER the node health-check, so a node that
 * just failed its probe is excluded and a transient SSH blip never reaps live
 * containers.
 */
export async function reconcileOrphanContainersOnNodes(
  config: OrphanReconcilerConfig,
): Promise<OrphanReconcileResult> {
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
      async listContainers(): Promise<NodeContainerRef[] | null> {
        try {
          const client = ssh();
          await client.connect();
          const output = await client.exec(
            `docker ps -a --format '{{.Names}}|{{.ID}}' --filter name=${shellQuote(config.prefix)}`,
            ORPHAN_LIST_TIMEOUT_MS,
          );
          return (
            output
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean)
              // `--filter name=` is a substring match, so re-check the prefix to
              // exclude any container that merely contains the prefix mid-name.
              .filter((line) => line.startsWith(config.prefix))
              .map((line) => {
                const [name = "", id = ""] = line.split("|");
                return { name, id };
              })
              .filter((c) => c.name && c.id)
          );
        } catch (error) {
          logger.warn(`[${config.logScope}] Container listing failed over SSH`, {
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
        // of the same workload and could reap a live container. Keep this `<id>`.
        await client.exec(`docker rm -f ${shellQuote(containerId)}`, ORPHAN_RM_TIMEOUT_MS);
      },
    };
  });

  return reconcileOrphanContainers(reconcilerNodes, config);
}
