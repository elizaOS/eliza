/**
 * NodeDiskManager — keeps agent-node Docker disk from filling up.
 *
 * THE GAP THIS CLOSES
 * Failed `docker pull`s (e.g. a flaky `ghcr.io/elizaos/eliza:develop` fetch)
 * leave half-written layers in containerd's ingest staging dir
 * (`/var/lib/containerd/.../ingest`). Retried every ~5 min by the pre-pull /
 * provision path, those stuck blobs accumulate until the node hits
 * `no space left on device` — at which point EVERY pull and EVERY new agent
 * provision on that node fails. Nothing in the control plane cleaned or even
 * detected it: the node-health check only probed `docker info`, so a full node
 * still reported `healthy` and the autoscaler never replaced it.
 *
 * This module adds the missing self-management, in two parts:
 *   1. A prune cycle: per HEALTHY node, read `df` for the docker data root; when
 *      usage crosses the high-water mark, reclaim space (label-filtered
 *      container/image/network/buildkit prunes, never volumes, never managed
 *      agent containers + clear stuck containerd ingest), with a cooldown so it
 *      doesn't prune every tick. Logs before/after `df`.
 *   2. A disk-aware health verdict (`diskHealthVerdict`): a node whose disk is
 *      critically full is `unhealthy` so the autoscaler drains/replaces it
 *      instead of believing a `docker info` that still answers on a full disk.
 *
 * ARCHITECTURE mirrors `orphan-container-reconciler.ts`: the pure decisions
 * (`decideDiskAction`, `parseDfUsedPercent`, `diskHealthVerdict`) do NO I/O so
 * they unit-test exhaustively; the SSH node-exec boundary is injected via
 * `DiskNode` so production reuses the SAME `DockerSSHClient` pool the daemon
 * already authenticates with `CONTAINERS_SSH_KEY` — this module never reads a
 * key or opens its own SSH path.
 *
 * SAFETY INVARIANTS:
 *   1. Only `status === "healthy"` nodes are pruned (the caller runs this AFTER
 *      the node health-check, so a node failing its probe is excluded).
 *   2. No volume prune anywhere — agent host volumes (persisted workspaces)
 *      are never touched. Container prune excludes anything labeled
 *      `ai.elizaos.managed-by`, so a stopped USER agent container is never
 *      reaped either (deleting it would force a full re-provision on next
 *      start).
 *   3. Stuck-ingest clearing only removes the containerd INGEST staging dir
 *      (half-written, not-yet-committed pull blobs); committed content blobs and
 *      running containers are never touched. It uses `find ... -mindepth 1
 *      -delete` scoped to the ingest subtree only (never `rm -rf <glob>`),
 *      bounded to the ingest dir and guarded so a missing dir is a no-op.
 *   4. Hard per-call SSH timeouts on the df read and the reclamation.
 *   5. A cooldown (`cooldownMs`) keyed per node so a node mid-cooldown is skipped
 *      even if still above the prune threshold — avoids prune-every-tick churn
 *      while a large pull is legitimately in flight.
 */

import { imageRepo } from "../../db/utils/docker-image-ref";
import { containersEnv } from "../config/containers-env";
import { logger } from "../utils/logger";
import { CONTAINER_LABEL_MANAGED_BY } from "./docker-sandbox-utils";
import { DockerSSHClient } from "./docker-ssh";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A node's disk usage, read from `df` for the docker data root. */
export interface DiskUsage {
  /** Percent of the filesystem used, 0..100. */
  usedPercent: number;
}

/** What the prune cycle decided to do for one node. */
export type DiskActionKind = "skip_below_threshold" | "skip_cooldown" | "prune";

export interface DiskAction {
  kind: DiskActionKind;
  /** Human-readable reason for the decision (logged). */
  reason: string;
}

/** Disk-aware health verdict for a node. */
export type DiskHealthVerdict = "ok" | "critical";

/**
 * Per-node SSH surface the disk manager needs. Injected so tests drive the
 * decision without real SSH; production wiring (`buildDiskNodes`) reuses the
 * shared `DockerSSHClient` pool.
 */
export interface DiskNode {
  node_id: string;
  hostname: string;
  status: string;
  /**
   * Read disk usage for the docker data root over SSH. Returns null when the
   * read failed (SSH blip / `df` error) so the caller can skip the node rather
   * than misread a failure as 0% and never prune — or as 100% and flap it
   * unhealthy.
   */
  readDiskUsage(): Promise<DiskUsage | null>;
  /**
   * Reclaim space over SSH: `docker system prune -af` (no `--volumes`), clear
   * stuck containerd ingest, and buildkit prune. Returns the disk usage AFTER
   * reclamation (re-read `df`), or null if the post-read failed.
   */
  reclaim(): Promise<DiskUsage | null>;
  /**
   * Prune stale, unused managed-agent image refs for the configured repository.
   * This runs on a slower cadence than emergency disk reclaim so large nodes do
   * not silently retain hundreds of GB of superseded runtime images.
   */
  pruneStaleAgentImages(command: string): Promise<void>;
}

export interface NodeDiskCleanupReport {
  /** Healthy nodes inspected. */
  nodesScanned: number;
  /** Nodes skipped (not healthy, or the df read failed). */
  nodesSkipped: number;
  /** Nodes that were pruned this cycle. */
  pruned: number;
  /** Nodes whose reclamation threw. */
  pruneFailed: number;
  /** Nodes where the stale managed-agent image prune command ran. */
  staleAgentImagePruned: number;
  /** Nodes where stale managed-agent image pruning threw. */
  staleAgentImagePruneFailed: number;
  /** Per-node detail for observability. */
  details: Array<{
    nodeId: string;
    hostname: string;
    action: DiskActionKind | "read_failed";
    staleAgentImageAction?: "prune" | "skip_interval" | "failed";
    usedPercentBefore?: number;
    usedPercentAfter?: number;
    reclaimedPercent?: number;
  }>;
}

// ---------------------------------------------------------------------------
// Pure helpers (no I/O — unit-tested in node-disk-manager.test.ts)
// ---------------------------------------------------------------------------

/**
 * Parse the used-percent out of `df -P <path>` output. Tolerant of the
 * one-line-header + one-data-line layout, `[stderr]`-prefixed lines from the
 * SSH client, and trailing whitespace. Returns null when no `NN%` field is
 * found (so the caller skips rather than guessing).
 *
 * `df -P` (POSIX) guarantees a single data line even for long device names, so
 * we take the LAST non-stderr, non-header line and read its `Capacity` column
 * (the token ending in `%`).
 */
export function parseDfUsedPercent(output: string): number | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("[stderr]"));

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    // Skip the df header row.
    if (/^Filesystem\b/i.test(line)) continue;
    const match = line.match(/(\d+)%/);
    if (match?.[1] !== undefined) {
      const pct = Number.parseInt(match[1], 10);
      if (Number.isFinite(pct) && pct >= 0 && pct <= 100) return pct;
    }
  }
  return null;
}

/**
 * Pure prune decision for one node. NO I/O.
 *
 *   - usage below the prune threshold        → `skip_below_threshold`
 *   - usage at/above threshold but in cooldown → `skip_cooldown`
 *   - usage at/above threshold and cooled down → `prune`
 *
 * The cooldown is keyed off `lastPrunedAt` (ms epoch, or null when never
 * pruned). `now - lastPrunedAt < cooldownMs` means still cooling down.
 */
export function decideDiskAction(input: {
  usedPercent: number;
  pruneThresholdPct: number;
  lastPrunedAt: number | null;
  cooldownMs: number;
  now: number;
}): DiskAction {
  const { usedPercent, pruneThresholdPct, lastPrunedAt, cooldownMs, now } = input;

  if (usedPercent < pruneThresholdPct) {
    return {
      kind: "skip_below_threshold",
      reason: `disk ${usedPercent}% < prune threshold ${pruneThresholdPct}%`,
    };
  }

  if (lastPrunedAt !== null && now - lastPrunedAt < cooldownMs) {
    const remainingMs = cooldownMs - (now - lastPrunedAt);
    return {
      kind: "skip_cooldown",
      reason: `disk ${usedPercent}% >= ${pruneThresholdPct}% but pruned ${Math.round(
        (now - lastPrunedAt) / 1000,
      )}s ago (cooldown ${Math.round(cooldownMs / 1000)}s, ${Math.round(
        remainingMs / 1000,
      )}s left)`,
    };
  }

  return {
    kind: "prune",
    reason: `disk ${usedPercent}% >= prune threshold ${pruneThresholdPct}%`,
  };
}

/**
 * Pure disk-aware health verdict for a node. A node whose disk usage is at or
 * above the unhealthy threshold is `critical` — the caller marks it unhealthy so
 * the autoscaler drains/replaces it. Conservative: the unhealthy threshold sits
 * ABOVE the prune threshold, so a node only flaps unhealthy when prune alone
 * could not reclaim it back under water. A null usage (df read failed) is `ok`
 * — disk failure must never be the thing that flaps a node, the SSH/docker-info
 * probe already owns reachability.
 */
export function diskHealthVerdict(
  usedPercent: number | null,
  unhealthyThresholdPct: number,
): DiskHealthVerdict {
  if (usedPercent === null) return "ok";
  return usedPercent >= unhealthyThresholdPct ? "critical" : "ok";
}

// ---------------------------------------------------------------------------
// Reclamation shell command
// ---------------------------------------------------------------------------

/**
 * Hard per-call SSH budgets. The reclamation can churn a lot of layers, so it
 * gets a generous window; the df reads are quick.
 */
const DF_TIMEOUT_MS = 15_000;
const RECLAIM_TIMEOUT_MS = 5 * 60_000;

/**
 * The reclamation command run on a node when it crosses the prune threshold.
 *
 * Order matters:
 *   1. `docker container prune` filtered to EXCLUDE provisioner-managed
 *      containers (label `ai.elizaos.managed-by`, see docker-sandbox-utils) —
 *      reap stopped unmanaged debris (CI leftovers, hand-run containers) while
 *      never deleting a stopped user agent container. Deleting one forces a
 *      full re-provision on its next start — the churn class behind
 *      #15228/#15398. (Containers created before labeling shipped are not
 *      protected by the filter; they age out as the fleet re-provisions.)
 *   2. `docker image prune -af` — dangling + unreferenced images. Images used
 *      by ANY container (running or stopped, including the managed containers
 *      step 1 preserved) are never removed by docker.
 *   3. `docker network prune -f` — unused networks (docker refuses to remove
 *      networks with attached containers, so the shared agent bridge network
 *      is safe while in use; the provisioner also self-heals it on create).
 *   4. `docker builder prune -af` — drop the buildkit cache.
 *   5. Clear stuck containerd INGEST — the actual junk from failed pulls.
 *      Nothing above touches containerd's ingest staging dir, so half-written
 *      blobs from a `no space left on device` pull persist and re-accumulate.
 *      We remove ONLY the ingest subtree (not committed content), across both
 *      the moby and k8s.io namespaces, guarded so a missing dir is a no-op.
 *      `find ... -delete` is used (not `rm -rf <glob>`) so it is bounded to
 *      the ingest dir and never errors on an empty match.
 *
 * Steps 1–4 replace the previous single `docker system prune -af`, which had
 * no per-object filtering and would reap a stopped MANAGED agent container.
 * Volumes are still never touched (no volume prune anywhere).
 *
 * Every step is `|| true`-guarded so one failing step (e.g. buildkit not
 * present) does not abort the rest — best-effort reclamation.
 */
export function buildReclaimCommand(): string {
  return [
    // label!=<key> matches objects NOT carrying the key at all — i.e. only
    // unmanaged containers are pruned.
    `docker container prune -f --filter 'label!=${CONTAINER_LABEL_MANAGED_BY}' || true`,
    "docker image prune -af || true",
    "docker network prune -f || true",
    "docker builder prune -af || true",
    // Clear stuck containerd ingest (half-written pull blobs) in every namespace
    // dir, ONLY the ingest subtree. -mindepth 1 keeps the ingest dir itself.
    "for d in /var/lib/containerd/io.containerd.content.v1.content/ingest " +
      "/var/lib/docker/containerd/daemon/io.containerd.content.v1.content/ingest; do " +
      'if [ -d "$d" ]; then find "$d" -mindepth 1 -delete 2>/dev/null || true; fi; ' +
      "done",
  ].join("; ");
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface StaleAgentImagePruneOptions {
  repository: string;
  keepNewest: number;
  maxAgeHours: number;
}

/**
 * Build the narrow stale-image GC command for the managed-agent image repo.
 *
 * This does NOT use a broad `docker image prune -a`; it only considers refs in
 * the configured default-agent repository, preserves image IDs used by any
 * container, keeps the newest refs as a rollback cushion, and then removes only
 * refs older than the configured age floor.
 */
export function buildStaleAgentImagePruneCommand(options: StaleAgentImagePruneOptions): string {
  const repository = options.repository.trim();
  if (repository.length === 0) {
    throw new Error("stale agent image prune repository is required");
  }

  const keepNewest = Math.max(1, Math.floor(options.keepNewest));
  const maxAgeHours = Math.max(1, Math.floor(options.maxAgeHours));
  const repo = shellSingleQuote(repository);

  return [
    `repo=${repo}`,
    `keep_newest=${keepNewest}`,
    `max_age_hours=${maxAgeHours}`,
    'cutoff="$(date -u -d "$max_age_hours hours ago" +%s 2>/dev/null || true)"',
    'if [ -n "$cutoff" ]; then tmp="$(mktemp)"',
    'active="$(mktemp)"',
    'trap \'rm -f "$tmp" "$active"\' EXIT',
    "docker ps -a --format '{{.Image}}' | while IFS= read -r image; do " +
      '[ -n "$image" ] && docker image inspect --format \'{{.Id}}\' "$image" 2>/dev/null || true; ' +
      'done | sort -u > "$active"',
    "docker image ls \"$repo\" --format '{{.Repository}}:{{.Tag}}' | while IFS= read -r ref; do " +
      'case "$ref" in ""|*"<none>"*) continue;; esac; ' +
      'id="$(docker image inspect --format \'{{.Id}}\' "$ref" 2>/dev/null || true)"; ' +
      'created="$(docker image inspect --format \'{{.Created}}\' "$ref" 2>/dev/null || true)"; ' +
      'created_epoch="$(date -u -d "$created" +%s 2>/dev/null || true)"; ' +
      '[ -n "$id" ] && [ -n "$created_epoch" ] && printf "%s\\t%s\\t%s\\n" "$created_epoch" "$id" "$ref"; ' +
      'done | sort -rn > "$tmp"',
    "n=0",
    "while IFS=\"$(printf '\\t')\" read -r created_epoch id ref; do " +
      "n=$((n + 1)); " +
      '[ "$n" -le "$keep_newest" ] && continue; ' +
      '[ "$created_epoch" -ge "$cutoff" ] && continue; ' +
      'grep -qxF "$id" "$active" && continue; ' +
      'docker image rm -f "$ref" || true; ' +
      'done < "$tmp"',
    "fi",
  ].join("; ");
}

/** `df -P` for the docker data root — POSIX one-data-line output. */
function buildDfCommand(): string {
  // /var/lib/docker is the docker data root on the standard node layout; fall
  // back to / if it does not exist yet (fresh node). `df -P` is portable.
  return "df -P /var/lib/docker 2>/dev/null || df -P /";
}

// ---------------------------------------------------------------------------
// Cooldown state (per node, in-process)
// ---------------------------------------------------------------------------

/**
 * Last-pruned timestamp per node id. In-process only — the daemon is a single
 * long-lived process that owns docker_nodes truth, so a process restart simply
 * re-arms every node (worst case: one extra prune after a restart, which is
 * harmless). Kept module-local so the production wiring and the cycle share it.
 */
const lastPrunedAtByNode = new Map<string, number>();
const lastStaleAgentImagePrunedAtByNode = new Map<string, number>();

/** Test seam: reset the in-process cooldown state. */
export function __resetDiskCooldownStateForTests(): void {
  lastPrunedAtByNode.clear();
  lastStaleAgentImagePrunedAtByNode.clear();
}

// ---------------------------------------------------------------------------
// Cycle orchestration
// ---------------------------------------------------------------------------

export interface DiskCleanupConfig {
  pruneThresholdPct: number;
  cooldownMs: number;
  staleAgentImagePrune?: StaleAgentImagePruneOptions & {
    intervalMs: number;
    lastPrunedAt?: Map<string, number>;
  };
  /** Injected clock for deterministic tests. */
  now?: () => number;
  /**
   * Injected cooldown store. Defaults to the module-local map. Exposed so tests
   * drive cooldown deterministically without touching process state.
   */
  lastPrunedAt?: Map<string, number>;
}

/**
 * Run the disk cleanup decision + reclamation across a set of HEALTHY nodes.
 * Pure orchestration over the injected `DiskNode` boundary — no SSH here, so it
 * unit-tests with fake nodes. The production wiring is `processNodeDiskCleanup`.
 */
export async function cleanupNodeDisks(
  nodes: readonly DiskNode[],
  config: DiskCleanupConfig,
): Promise<NodeDiskCleanupReport> {
  const now = config.now ?? (() => Date.now());
  const cooldownStore = config.lastPrunedAt ?? lastPrunedAtByNode;
  const staleImageStore =
    config.staleAgentImagePrune?.lastPrunedAt ?? lastStaleAgentImagePrunedAtByNode;
  const staleImageCommand = config.staleAgentImagePrune
    ? buildStaleAgentImagePruneCommand(config.staleAgentImagePrune)
    : null;

  const report: NodeDiskCleanupReport = {
    nodesScanned: 0,
    nodesSkipped: 0,
    pruned: 0,
    pruneFailed: 0,
    staleAgentImagePruned: 0,
    staleAgentImagePruneFailed: 0,
    details: [],
  };

  for (const node of nodes) {
    if (node.status !== "healthy") {
      report.nodesSkipped += 1;
      continue;
    }

    const usage = await node.readDiskUsage();
    if (usage === null) {
      report.nodesSkipped += 1;
      report.details.push({
        nodeId: node.node_id,
        hostname: node.hostname,
        action: "read_failed",
      });
      logger.warn("[node-disk-manager] Skipping node: disk usage read failed", {
        nodeId: node.node_id,
        hostname: node.hostname,
      });
      continue;
    }
    report.nodesScanned += 1;
    const nodeNow = now();
    let staleAgentImageAction: "prune" | "skip_interval" | "failed" | undefined;

    if (config.staleAgentImagePrune && staleImageCommand) {
      const lastStalePrunedAt = staleImageStore.get(node.node_id) ?? null;
      if (
        lastStalePrunedAt !== null &&
        nodeNow - lastStalePrunedAt < config.staleAgentImagePrune.intervalMs
      ) {
        staleAgentImageAction = "skip_interval";
      } else {
        try {
          await node.pruneStaleAgentImages(staleImageCommand);
          staleImageStore.set(node.node_id, nodeNow);
          report.staleAgentImagePruned += 1;
          staleAgentImageAction = "prune";
        } catch (error) {
          report.staleAgentImagePruneFailed += 1;
          staleAgentImageAction = "failed";
          logger.warn("[node-disk-manager] Stale agent image prune failed", {
            nodeId: node.node_id,
            hostname: node.hostname,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const action = decideDiskAction({
      usedPercent: usage.usedPercent,
      pruneThresholdPct: config.pruneThresholdPct,
      lastPrunedAt: cooldownStore.get(node.node_id) ?? null,
      cooldownMs: config.cooldownMs,
      now: nodeNow,
    });

    if (action.kind !== "prune") {
      report.details.push({
        nodeId: node.node_id,
        hostname: node.hostname,
        action: action.kind,
        ...(staleAgentImageAction ? { staleAgentImageAction } : {}),
        usedPercentBefore: usage.usedPercent,
      });
      continue;
    }

    logger.info("[node-disk-manager] Pruning node disk", {
      nodeId: node.node_id,
      hostname: node.hostname,
      usedPercentBefore: usage.usedPercent,
      reason: action.reason,
    });

    try {
      const after = await node.reclaim();
      cooldownStore.set(node.node_id, nodeNow);
      report.pruned += 1;
      const reclaimed = after !== null ? usage.usedPercent - after.usedPercent : undefined;
      report.details.push({
        nodeId: node.node_id,
        hostname: node.hostname,
        action: "prune",
        ...(staleAgentImageAction ? { staleAgentImageAction } : {}),
        usedPercentBefore: usage.usedPercent,
        ...(after !== null ? { usedPercentAfter: after.usedPercent } : {}),
        ...(reclaimed !== undefined ? { reclaimedPercent: reclaimed } : {}),
      });
      logger.info("[node-disk-manager] Reclaimed node disk", {
        nodeId: node.node_id,
        hostname: node.hostname,
        usedPercentBefore: usage.usedPercent,
        usedPercentAfter: after?.usedPercent ?? null,
        reclaimedPercent: reclaimed ?? null,
      });
    } catch (error) {
      report.pruneFailed += 1;
      report.details.push({
        nodeId: node.node_id,
        hostname: node.hostname,
        action: "prune",
        ...(staleAgentImageAction ? { staleAgentImageAction } : {}),
        usedPercentBefore: usage.usedPercent,
      });
      logger.warn("[node-disk-manager] Disk reclamation failed", {
        nodeId: node.node_id,
        hostname: node.hostname,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Production wiring — reuses the shared DockerSSHClient pool
// ---------------------------------------------------------------------------

interface SshNode {
  node_id: string;
  hostname: string;
  status: string;
  ssh_port: number | null;
  host_key_fingerprint: string | null;
  ssh_user: string | null;
}

/**
 * Build the production `DiskNode` for a docker_nodes row. Reuses the warm
 * `DockerSSHClient` pool — the daemon already authenticates these with
 * `CONTAINERS_SSH_KEY`, so this never touches key material.
 */
export function buildDiskNode(node: SshNode): DiskNode {
  const ssh = () =>
    DockerSSHClient.getClient(
      node.hostname,
      node.ssh_port ?? undefined,
      node.host_key_fingerprint ?? undefined,
      node.ssh_user ?? undefined,
    );

  const readUsage = async (): Promise<DiskUsage | null> => {
    const client = ssh();
    await client.connect();
    const output = await client.exec(buildDfCommand(), DF_TIMEOUT_MS);
    const pct = parseDfUsedPercent(output);
    return pct === null ? null : { usedPercent: pct };
  };

  return {
    node_id: node.node_id,
    hostname: node.hostname,
    status: node.status,
    async readDiskUsage(): Promise<DiskUsage | null> {
      try {
        return await readUsage();
      } catch (error) {
        logger.warn("[node-disk-manager] df read failed over SSH", {
          nodeId: node.node_id,
          hostname: node.hostname,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
    async reclaim(): Promise<DiskUsage | null> {
      const client = ssh();
      await client.connect();
      await client.exec(buildReclaimCommand(), RECLAIM_TIMEOUT_MS);
      // Re-read df so the caller can log reclaimed space. A failed post-read is
      // not fatal — the reclamation already ran.
      try {
        return await readUsage();
      } catch {
        return null;
      }
    },
    async pruneStaleAgentImages(command: string): Promise<void> {
      const client = ssh();
      await client.connect();
      await client.exec(command, RECLAIM_TIMEOUT_MS);
    },
  };
}

/**
 * Probe a single node's disk usage over SSH. Used by the disk-aware health
 * check so the health verdict reads the SAME df the cleanup cycle does. Returns
 * null on any failure (the health check then treats disk as `ok` and lets the
 * docker-info probe own reachability).
 */
export async function probeNodeDiskUsage(node: SshNode): Promise<number | null> {
  const usage = await buildDiskNode(node).readDiskUsage();
  return usage?.usedPercent ?? null;
}

/**
 * Production entry point for the daemon's infra-maintenance cycle. Enumerates
 * enabled HEALTHY docker nodes and runs the cleanup decision + reclamation over
 * the shared SSH pool. Only `healthy` nodes are touched (the caller runs this
 * AFTER the node health-check), so a node failing its probe is never pruned.
 */
export async function processNodeDiskCleanup(): Promise<NodeDiskCleanupReport> {
  const { dockerNodesRepository } = await import("../../db/repositories/docker-nodes");
  const enabled = await dockerNodesRepository.findEnabled();
  const healthy = enabled.filter((node) => node.status === "healthy");
  const diskNodes = healthy.map((node) => buildDiskNode(node));
  return cleanupNodeDisks(diskNodes, {
    pruneThresholdPct: containersEnv.nodeDiskPruneThresholdPct(),
    cooldownMs: containersEnv.nodeDiskPruneCooldownMs(),
    staleAgentImagePrune: {
      repository: imageRepo(containersEnv.defaultAgentImage()),
      keepNewest: containersEnv.nodeDiskAgentImagePruneKeepNewest(),
      maxAgeHours: containersEnv.nodeDiskAgentImagePruneMaxAgeHours(),
      intervalMs: containersEnv.nodeDiskAgentImagePruneIntervalMs(),
    },
  });
}
