/**
 * Incremental (diff) backups for managed Eliza agent sandboxes.
 *
 * A full backup serialises the entire {@link AgentBackupStateData}. For agents
 * that change a little between snapshots, storing a full copy every time is
 * wasteful. This module computes a compact {@link BackupDelta} against a parent
 * state and reconstructs a state by replaying a parent chain of deltas on top
 * of a base full backup.
 *
 * The format is intentionally field-oriented (not byte-level): the three parts
 * of an agent's state diff cleanly.
 *   - `workspaceFiles` — a path → content map; diff = changed/added paths plus
 *     a removed-path list.
 *   - `config` — a flat record; diff = changed/added top-level keys plus a
 *     removed-key list.
 *   - `memories` — an append-only log in the common case; diff = the count
 *     carried over from the parent plus the appended tail. If the parent prefix
 *     diverges (history was rewritten/compacted), the delta rebases by carrying
 *     the full list and a base count of 0.
 *
 * Reconstruction is exact: `applyBackupDelta(base, diffBackupState(base, next))`
 * deep-equals `next` for every input pair. This is the invariant the unit
 * tests pin.
 */

import { createHash } from "node:crypto";
import type { AgentBackupStateData } from "../../db/schemas/agent-sandboxes";

export type AgentBackupMemory = AgentBackupStateData["memories"][number];

export interface BackupDelta {
  /** Files added, or whose content changed, keyed by workspace-relative path. */
  filesChanged: Record<string, string>;
  /** File paths present in the parent state but absent in the child. */
  filesRemoved: string[];
  /** Top-level config keys added or whose value changed. */
  configChanged: Record<string, unknown>;
  /** Top-level config keys removed. */
  configRemoved: string[];
  /**
   * Number of leading memories shared with the parent. The child's memory log
   * is `parent.memories.slice(0, memoriesBaseCount)` followed by
   * `memoriesAppended`. When the parent prefix diverges this is 0 and
   * `memoriesAppended` carries the entire child log (a rebase).
   */
  memoriesBaseCount: number;
  /** Memories appended after the shared prefix. */
  memoriesAppended: AgentBackupMemory[];
}

const EMPTY_STATE: AgentBackupStateData = {
  memories: [],
  config: {},
  workspaceFiles: {},
};

/** A fresh, empty state — callers should not mutate the shared constant. */
export function emptyBackupState(): AgentBackupStateData {
  return { memories: [], config: {}, workspaceFiles: {} };
}

/**
 * Deterministic JSON with recursively sorted object keys. Used so two states
 * that differ only in key insertion order hash and compare equal.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function memoriesEqual(a: AgentBackupMemory, b: AgentBackupMemory): boolean {
  return a.role === b.role && a.text === b.text && a.timestamp === b.timestamp;
}

/** Longest shared prefix length of two memory logs. */
function sharedMemoryPrefix(parent: AgentBackupMemory[], child: AgentBackupMemory[]): number {
  const max = Math.min(parent.length, child.length);
  let i = 0;
  while (i < max && memoriesEqual(parent[i], child[i])) i++;
  return i;
}

/** Stable content hash of a state. Equal states (key order aside) hash equal. */
export function computeStateHash(state: AgentBackupStateData): string {
  return createHash("sha256").update(stableStringify(state)).digest("hex");
}

/** Compute the delta that turns `base` into `next`. */
export function diffBackupState(
  base: AgentBackupStateData,
  next: AgentBackupStateData,
): BackupDelta {
  const filesChanged: Record<string, string> = {};
  for (const [path, content] of Object.entries(next.workspaceFiles)) {
    if (base.workspaceFiles[path] !== content) filesChanged[path] = content;
  }
  const filesRemoved = Object.keys(base.workspaceFiles).filter(
    (path) => !(path in next.workspaceFiles),
  );

  const configChanged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next.config)) {
    if (!(key in base.config) || !valuesEqual(base.config[key], value)) {
      configChanged[key] = value;
    }
  }
  const configRemoved = Object.keys(base.config).filter((key) => !(key in next.config));

  // Append-only fast path; otherwise rebase by carrying the full child log.
  const prefix = sharedMemoryPrefix(base.memories, next.memories);
  const appendOnly = prefix === base.memories.length;
  const memoriesBaseCount = appendOnly ? prefix : 0;
  const memoriesAppended = appendOnly ? next.memories.slice(prefix) : next.memories.slice();

  return {
    filesChanged,
    filesRemoved,
    configChanged,
    configRemoved,
    memoriesBaseCount,
    memoriesAppended,
  };
}

/** Apply a delta to a base state, producing the child state. Pure. */
export function applyBackupDelta(base: AgentBackupStateData, delta: BackupDelta): AgentBackupStateData {
  const workspaceFiles: Record<string, string> = { ...base.workspaceFiles };
  for (const path of delta.filesRemoved) delete workspaceFiles[path];
  for (const [path, content] of Object.entries(delta.filesChanged)) workspaceFiles[path] = content;

  const config: Record<string, unknown> = { ...base.config };
  for (const key of delta.configRemoved) delete config[key];
  for (const [key, value] of Object.entries(delta.configChanged)) config[key] = value;

  const memories = base.memories.slice(0, delta.memoriesBaseCount).concat(delta.memoriesAppended);

  return { memories, config, workspaceFiles };
}

/**
 * Reconstruct a state by replaying an ordered chain of deltas (oldest first) on
 * top of a base full backup.
 */
export function reconstructFromChain(
  base: AgentBackupStateData,
  deltas: BackupDelta[],
): AgentBackupStateData {
  return deltas.reduce<AgentBackupStateData>(
    (state, delta) => applyBackupDelta(state, delta),
    base,
  );
}

/** True when the delta encodes no change relative to its parent. */
export function isEmptyDelta(delta: BackupDelta): boolean {
  return (
    Object.keys(delta.filesChanged).length === 0 &&
    delta.filesRemoved.length === 0 &&
    Object.keys(delta.configChanged).length === 0 &&
    delta.configRemoved.length === 0 &&
    delta.memoriesAppended.length === 0
  );
}

/** Serialized byte size of a full state (UTF-8). */
export function estimateStateBytes(state: AgentBackupStateData): number {
  return Buffer.byteLength(JSON.stringify(state), "utf8");
}

/** Serialized byte size of a delta (UTF-8). */
export function estimateDeltaBytes(delta: BackupDelta): number {
  return Buffer.byteLength(JSON.stringify(delta), "utf8");
}

/**
 * Decide whether the next snapshot should be stored as an incremental delta or
 * as a fresh full backup. Storing incrementally only pays off when the delta is
 * meaningfully smaller than a full copy and the parent chain is not so long
 * that restores get expensive. Returns the delta when incremental is chosen.
 */
export function planIncrementalBackup(params: {
  base: AgentBackupStateData;
  next: AgentBackupStateData;
  /** Number of deltas already chained on top of the base full backup. */
  chainDepth: number;
  /** Force a full backup past this chain depth. Default 20. */
  maxChainDepth?: number;
  /** Only go incremental when delta is at most this fraction of full. Default 0.5. */
  maxDeltaRatio?: number;
}): { kind: "full" } | { kind: "incremental"; delta: BackupDelta } {
  const maxChainDepth = params.maxChainDepth ?? 20;
  const maxDeltaRatio = params.maxDeltaRatio ?? 0.5;
  if (params.chainDepth >= maxChainDepth) return { kind: "full" };

  const delta = diffBackupState(params.base, params.next);
  const fullBytes = estimateStateBytes(params.next);
  const deltaBytes = estimateDeltaBytes(delta);
  if (fullBytes > 0 && deltaBytes <= fullBytes * maxDeltaRatio) {
    return { kind: "incremental", delta };
  }
  return { kind: "full" };
}

// ---------------------------------------------------------------------------
// Chain resolution + chain-safe pruning (pure; the repo layer supplies rows)
// ---------------------------------------------------------------------------

import type { AgentBackupKind } from "../../db/schemas/agent-sandboxes";

/** Minimal view of a backup row needed to reason about chains. */
export interface BackupChainNode {
  id: string;
  backupKind: AgentBackupKind;
  parentBackupId: string | null;
  createdAtMs: number;
}

/**
 * Resolve the ordered id chain (oldest full → … → target) needed to
 * reconstruct `targetId`. Walks `parentBackupId` until a `full` node. Throws if
 * the chain is broken (a referenced parent is missing or a cycle is detected),
 * because silently restoring a partial chain would corrupt agent state.
 */
export function resolveBackupChain(nodes: BackupChainNode[], targetId: string): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = targetId;
  while (cursor) {
    if (seen.has(cursor)) throw new Error(`Backup chain cycle at ${cursor}`);
    seen.add(cursor);
    const node = byId.get(cursor);
    if (!node) throw new Error(`Backup chain references missing backup ${cursor}`);
    chain.push(node.id);
    if (node.backupKind === "full") {
      chain.reverse();
      return chain;
    }
    if (!node.parentBackupId) {
      throw new Error(`Incremental backup ${node.id} has no parent`);
    }
    cursor = node.parentBackupId;
  }
  throw new Error(`Backup ${targetId} not found`);
}

/**
 * Depth of the incremental chain that would sit on top of `targetId` if a new
 * incremental were appended (i.e. how many incrementals precede the next one,
 * back to and excluding the base full). Used to cap chain length.
 */
export function incrementalChainDepth(nodes: BackupChainNode[], targetId: string): number {
  return resolveBackupChain(nodes, targetId).length - 1;
}

/**
 * Choose which backups to delete while keeping the newest `keep` restore points
 * AND every ancestor any retained backup still needs. The kept set is
 * downward-closed under the parent relation, so pruning can never strand an
 * incremental without its base. Returns the deletable ids.
 */
export function selectPrunableBackupIds(nodes: BackupChainNode[], keep: number): string[] {
  if (nodes.length <= keep) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const newestFirst = [...nodes].sort((a, b) => b.createdAtMs - a.createdAtMs);

  const keepSet = new Set<string>();
  for (const node of newestFirst.slice(0, Math.max(0, keep))) keepSet.add(node.id);

  // Pull every ancestor of a kept node into the keep set.
  for (const id of [...keepSet]) {
    let cursor: string | null = id;
    while (cursor) {
      const node = byId.get(cursor);
      if (!node || node.backupKind === "full") break;
      cursor = node.parentBackupId;
      if (cursor) keepSet.add(cursor);
    }
  }

  return newestFirst.filter((n) => !keepSet.has(n.id)).map((n) => n.id);
}

export const __testing = { canonicalize, stableStringify, sharedMemoryPrefix, EMPTY_STATE };
