/**
 * Reconciles managed agent and app containers against their durable database
 * ownership on the shared Docker pool. The sweep fails closed whenever age,
 * placement, health, or SSH evidence is incomplete, and removes only the
 * immutable container ID captured by the same listing it classified. Workload
 * adapters supply their name parser, status vocabulary, and ownership query.
 */

import { ElizaError } from "@elizaos/core/edge";
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
  /**
   * When the container was created (epoch ms), parsed from `docker ps`'s
   * CreatedAt. `wrong_node` reaping requires the container ITSELF to be older
   * than the grace window: during a re-placement the worker creates the
   * container on the NEW node before it updates the sandbox row, so a
   * seconds-old container paired with a stale row pointing elsewhere is a
   * provision in flight, not a twin. Unparseable/absent → never wrong_node-reaped.
   */
  createdAtMs?: number;
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
   * for node-aware reconcilers — an old container whose live row points at a
   * DIFFERENT node (`wrong_node`, the re-provision-left-a-twin case).
   */
  reason: "no_db_row" | "terminal_db_row" | "wrong_node";
}

/** Why a managed container was deliberately retained during this sweep. */
export type RetainedContainerReason =
  | "unmanaged_name"
  | "no_db_row_age_unknown"
  | "no_db_row_within_grace"
  | "live_db_row"
  | "node_context_unavailable"
  | "live_on_node"
  | "wrong_node_evidence_incomplete"
  | "wrong_node_age_unknown"
  | "wrong_node_container_within_grace";

/** Complete, observable classification for one container in a node listing. */
export type ContainerReconcileDecision =
  | {
      action: "retain";
      name: string;
      id: string;
      key: string | null;
      reason: RetainedContainerReason;
    }
  | {
      action: "reap";
      name: string;
      id: string;
      key: string;
      reason: OrphanContainer["reason"];
    };

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
   * `loadStatuses` to populate `nodeId`. Agents set this; apps (which
   * legitimately fan a name across rows) leave it off.
   */
  nodeAware?: boolean;
  /**
   * How long a container with no matching ownership row must exist before it
   * may be reaped. This protects the create-before-row-commit window for every
   * workload type, including apps. Defaults to
   * `DEFAULT_ROWLESS_GRACE_MS` when unset.
   */
  rowlessGraceMs?: number;
  /**
   * How old a wrong-node container must be before the twin is reaped (epoch-ms
   * delta against its immutable Docker `createdAtMs`). Guards the provision
   * race where a new container is healthy before the DB row catches up. Defaults
   * to `DEFAULT_NODE_MOVE_GRACE_MS` when node-aware and unset.
   */
  nodeMoveGraceMs?: number;

  /**
   * Invoked after a container is successfully reaped, with the decision key and
   * the node it was reaped from. The reap is the only place that PROVES a
   * container is absent, so this is where a caller can hand back durable state
   * that was deliberately held until absence was proven — e.g. an agent
   * deletion generation's node slot (#17185). Best-effort by contract: a
   * failure here is logged and never aborts the sweep.
   */
  onReaped?(key: string, nodeId: string): Promise<void>;
}

/**
 * A wrong-node container must have existed for at least this long before it is
 * reaped — long enough that a normal provision (create container → confirm
 * healthy → update row's node_id) has written the row, so the freshly healthy
 * NEW container is never mistaken for the twin during its own creation window.
 */
export const DEFAULT_NODE_MOVE_GRACE_MS = 5 * 60_000;

/**
 * A rowless container must outlive the normal create-and-commit window before
 * absence of durable ownership is treated as conclusive.
 */
export const DEFAULT_ROWLESS_GRACE_MS = 5 * 60_000;

/**
 * Classify every listed container as retained or reapable.
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
 * For agents the storage key is `agent_sandboxes.id`, a PRIMARY KEY. Its loader
 * may nevertheless emit two live placement refs while a replacement fence owns
 * both the serving and replacement containers; either placement protects the
 * key on its exact node until fenced retirement completes.
 *
 * Containers whose name does not match the managed pattern are ignored
 * entirely — they belong to something else on the node.
 *
 * NODE-AWARE reaping (opt-in, `config.nodeAware`): a workload can have a live
 * (non-terminal) row that points at a DIFFERENT node than the one this container
 * sits on. That is the re-provision-left-a-twin case (#15228): the worker moved
 * the agent to a new node and never tore down the old container, which then
 * holds the headscale identity and makes the new registration flap. We reap the
 * twin ONLY when EVERY live row for the key points elsewhere AND the container
 * itself is older than `nodeMoveGraceMs` — so a newly created container that
 * is healthy before its own row updates during a normal provision is protected.
 * Database `updated_at` is deliberately not a clock for this decision because
 * healthy-agent heartbeats rewrite it continuously. When any live row points at
 * THIS node, the container is the canonical one and is kept.
 *
 * `nowMs` is injected so classification remains deterministic. Missing time is
 * treated as incomplete evidence and therefore retains the container.
 */
export function classifyContainersForReconciliation(
  containersOnNode: readonly NodeContainerRef[],
  liveRows: readonly LiveContainerRef[],
  config: Pick<
    OrphanReconcilerConfig,
    "keyOf" | "terminalStatuses" | "nodeAware" | "rowlessGraceMs" | "nodeMoveGraceMs"
  >,
  nodeId?: string,
  nowMs?: number,
): ContainerReconcileDecision[] {
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
  const rowlessGraceMs = config.rowlessGraceMs ?? DEFAULT_ROWLESS_GRACE_MS;
  const nodeMoveGraceMs = config.nodeMoveGraceMs ?? DEFAULT_NODE_MOVE_GRACE_MS;
  if (!Number.isFinite(rowlessGraceMs) || rowlessGraceMs < 0) {
    throw new ElizaError("Rowless reconciliation grace must be a non-negative duration", {
      code: "ORPHAN_RECONCILER_INVALID_GRACE",
      context: { graceKind: "rowless", graceMs: rowlessGraceMs },
    });
  }
  if (!Number.isFinite(nodeMoveGraceMs) || nodeMoveGraceMs < 0) {
    throw new ElizaError("Node-move reconciliation grace must be a non-negative duration", {
      code: "ORPHAN_RECONCILER_INVALID_GRACE",
      context: { graceKind: "node_move", graceMs: nodeMoveGraceMs },
    });
  }

  const decisions: ContainerReconcileDecision[] = [];
  for (const container of containersOnNode) {
    const key = config.keyOf(container.name);
    if (key === null) {
      decisions.push({
        action: "retain",
        name: container.name,
        id: container.id,
        key: null,
        reason: "unmanaged_name",
      });
      continue;
    }

    const rows = rowsByKey.get(key);
    if (rows === undefined || rows.length === 0) {
      // A missing row is also observable before an in-flight create commits.
      // Requiring a finite container age gives that write time to become
      // visible and makes malformed Docker timestamps non-destructive.
      if (
        container.createdAtMs === undefined ||
        !Number.isFinite(container.createdAtMs) ||
        nowMs === undefined ||
        !Number.isFinite(nowMs)
      ) {
        decisions.push({
          action: "retain",
          name: container.name,
          id: container.id,
          key,
          reason: "no_db_row_age_unknown",
        });
        continue;
      }
      if (nowMs - container.createdAtMs < rowlessGraceMs) {
        decisions.push({
          action: "retain",
          name: container.name,
          id: container.id,
          key,
          reason: "no_db_row_within_grace",
        });
        continue;
      }
      decisions.push({
        action: "reap",
        name: container.name,
        id: container.id,
        key,
        reason: "no_db_row",
      });
      continue;
    }
    if (rows.every((r) => config.terminalStatuses.has(r.status))) {
      // Reap ONLY when EVERY row is terminal — any live row protects the key.
      decisions.push({
        action: "reap",
        name: container.name,
        id: container.id,
        key,
        reason: "terminal_db_row",
      });
      continue;
    }

    // A live (non-terminal) row exists. In node-aware mode, this container is a
    // stale twin iff NONE of the live rows point at this node — the canonical
    // container lives elsewhere. The immutable Docker creation time protects a
    // newly created container while its row catches up; mutable row timestamps
    // cannot, because healthy-agent heartbeats refresh them indefinitely.
    if (!config.nodeAware) {
      decisions.push({
        action: "retain",
        name: container.name,
        id: container.id,
        key,
        reason: "live_db_row",
      });
      continue;
    }
    if (!nodeAware) {
      decisions.push({
        action: "retain",
        name: container.name,
        id: container.id,
        key,
        reason: "node_context_unavailable",
      });
      continue;
    }

    const liveRows_ = rows.filter((r) => !config.terminalStatuses.has(r.status));
    if (liveRows_.some((r) => r.nodeId === nodeId)) {
      decisions.push({
        action: "retain",
        name: container.name,
        id: container.id,
        key,
        reason: "live_on_node",
      });
      continue;
    }
    const completePlacements = liveRows_.filter(
      (row): row is LiveContainerRef & { nodeId: string } => row.nodeId !== undefined,
    );
    if (completePlacements.length !== liveRows_.length) {
      decisions.push({
        action: "retain",
        name: container.name,
        id: container.id,
        key,
        reason: "wrong_node_evidence_incomplete",
      });
      continue;
    }
    if (
      container.createdAtMs === undefined ||
      !Number.isFinite(container.createdAtMs) ||
      nowMs === undefined ||
      !Number.isFinite(nowMs)
    ) {
      decisions.push({
        action: "retain",
        name: container.name,
        id: container.id,
        key,
        reason: "wrong_node_age_unknown",
      });
      continue;
    }
    if (nowMs - container.createdAtMs < nodeMoveGraceMs) {
      decisions.push({
        action: "retain",
        name: container.name,
        id: container.id,
        key,
        reason: "wrong_node_container_within_grace",
      });
      continue;
    }
    decisions.push({
      action: "reap",
      name: container.name,
      id: container.id,
      key,
      reason: "wrong_node",
    });
  }
  return decisions;
}

/**
 * Compatibility view for callers that only need containers approved for
 * removal. Reconciliation uses the full decision set so retained workloads
 * remain observable.
 */
export function computeOrphanContainersToReap(
  containersOnNode: readonly NodeContainerRef[],
  liveRows: readonly LiveContainerRef[],
  config: Pick<
    OrphanReconcilerConfig,
    "keyOf" | "terminalStatuses" | "nodeAware" | "rowlessGraceMs" | "nodeMoveGraceMs"
  >,
  nodeId?: string,
  nowMs?: number,
): OrphanContainer[] {
  return classifyContainersForReconciliation(
    containersOnNode,
    liveRows,
    config,
    nodeId,
    nowMs,
  ).flatMap((decision) =>
    decision.action === "reap"
      ? [
          {
            name: decision.name,
            id: decision.id,
            key: decision.key,
            reason: decision.reason,
          },
        ]
      : [],
  );
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
      logger.warn(`[${config.logScope}] Skipping unhealthy node`, {
        nodeId: node.node_id,
        hostname: node.hostname,
        nodeStatus: node.status,
      });
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

    const keys = [
      ...new Set(
        containersOnNode
          .map((container) => config.keyOf(container.name))
          .filter((key): key is string => key !== null),
      ),
    ];
    const liveRows = keys.length === 0 ? [] : await config.loadStatuses(keys);
    const decisions = classifyContainersForReconciliation(
      containersOnNode,
      liveRows,
      config,
      node.node_id,
      Date.now(),
    );
    for (const retained of decisions.filter((decision) => decision.action === "retain")) {
      logger.debug(`[${config.logScope}] Retained container`, {
        nodeId: node.node_id,
        hostname: node.hostname,
        containerName: retained.name,
        containerId: retained.id,
        key: retained.key,
        decision: retained.action,
        reason: retained.reason,
      });
    }

    for (const orphan of decisions.filter((decision) => decision.action === "reap")) {
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
        if (config.onReaped) {
          // error-policy:J6 best-effort teardown bookkeeping. Not J7: this is not
          // diagnostics — a swallowed failure holds a real node slot. It is
          // survivable only because the retry contract is explicit: the reap is
          // already counted and the remaining reaps must still run. Agent
          // deletion keeps a durable terminal tombstone, so its independent
          // low-frequency delete retry can observe container absence and spend
          // the idempotent release CAS after a bookkeeping failure here.
          await config.onReaped(orphan.key, node.node_id).catch((error: unknown) => {
            logger.warn(`[${config.logScope}] Post-reap bookkeeping failed`, {
              nodeId: node.node_id,
              key: orphan.key,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
        logger.info(`[${config.logScope}] Reaped orphan container`, {
          nodeId: node.node_id,
          hostname: node.hostname,
          containerName: orphan.name,
          containerId: orphan.id,
          key: orphan.key,
          decision: orphan.action,
          reason: orphan.reason,
        });
      } catch (error) {
        // error-policy:J1 each Docker removal is an independent transport
        // boundary; return its explicit failure count after processing the
        // remaining immutable IDs.
        result.reapFailed += 1;
        logger.warn(`[${config.logScope}] Failed to reap orphan container`, {
          nodeId: node.node_id,
          hostname: node.hostname,
          containerName: orphan.name,
          containerId: orphan.id,
          key: orphan.key,
          decision: orphan.action,
          reason: orphan.reason,
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

const DOCKER_CREATED_AT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\s+([+-])(\d{2})(\d{2})(?:\s+\S+)?$/;

function parseDockerCreatedAt(raw: string): number | undefined {
  const match = DOCKER_CREATED_AT_PATTERN.exec(raw.trim());
  if (!match) return undefined;
  const [
    ,
    yearRaw,
    monthRaw,
    dayRaw,
    hourRaw,
    minuteRaw,
    secondRaw,
    fraction = "",
    sign,
    offsetHourRaw,
    offsetMinuteRaw,
  ] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const millisecond = Number(fraction.padEnd(3, "0").slice(0, 3));
  const offsetHour = Number(offsetHourRaw);
  const offsetMinute = Number(offsetMinuteRaw);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return undefined;
  }

  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millisecond);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day
  ) {
    return undefined;
  }
  const offsetMs = (offsetHour * 60 + offsetMinute) * 60_000;
  return local.getTime() - (sign === "+" ? offsetMs : -offsetMs);
}

/**
 * Parses the exact Docker listing consumed by the reconciler. Malformed ages
 * remain represented without `createdAtMs`, which makes destructive decisions
 * fail closed instead of silently treating an unparseable timestamp as old.
 */
export function parseNodeContainerList(output: string, prefix: string): NodeContainerRef[] {
  const containers: NodeContainerRef[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.split("|");
    const [rawName = "", rawId = "", createdAtRaw = ""] = fields;
    const name = rawName.trim();
    if (!name.startsWith(prefix)) continue;
    const id = rawId.trim();
    if (fields.length !== 3 || !id) {
      throw new ElizaError("Docker returned an invalid managed-container listing row", {
        code: "ORPHAN_RECONCILER_INVALID_LISTING",
        context: { name, prefix, fieldCount: fields.length },
      });
    }
    const createdAtMs = parseDockerCreatedAt(createdAtRaw);
    containers.push({
      name,
      id,
      ...(createdAtMs === undefined ? {} : { createdAtMs }),
    });
  }
  return containers;
}

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
            `docker ps -a --format '{{.Names}}|{{.ID}}|{{.CreatedAt}}' --filter name=${shellQuote(config.prefix)}`,
            ORPHAN_LIST_TIMEOUT_MS,
          );
          return parseNodeContainerList(output, config.prefix);
        } catch (error) {
          // error-policy:J1 the SSH adapter translates a transport failure into
          // the explicit null signal that makes the sweep skip the whole node.
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
