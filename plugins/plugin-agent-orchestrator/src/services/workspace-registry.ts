/**
 * Process-wide registry of on-disk coding-agent workspace directories, and the
 * disk-backpressure primitives that guard their creation. Both mechanisms that
 * put subagent scratch space on disk — `AcpService` per-session `task-<id>`
 * dirs and `CodingWorkspaceService` git clones/worktrees — register here so a
 * single lifecycle owner can answer two questions the individual services can't
 * on their own: how much workspace disk is currently committed across all of
 * them (the cap check) and which directories are still live (so a GC sweep
 * never reclaims a running session's dir).
 *
 * The registry is intentionally a module-level singleton, not a service: it is
 * shared across every service instance in the process (multi-tenant hosts, test
 * runners) exactly like `AcpService.liveInstances`, and the disk it protects is
 * a per-host resource, not a per-runtime one.
 *
 * Nothing here does its own `fs.rm` of a registered dir — deletion stays with
 * whichever service owns the directory (it holds the path-safety context). The
 * registry only tracks membership and computes budget/free-disk verdicts.
 */

import { statfs } from "node:fs/promises";
import { resolve } from "node:path";

export interface WorkspaceRegistryEntry {
  /** Absolute, resolved path of the workspace directory. */
  path: string;
  /** Owning session or workspace id (used to correlate with live-session sets). */
  ownerId: string;
  /** Which mechanism provisioned it — for diagnostics only. */
  kind: "acp-scratch" | "git-workspace";
  createdAt: number;
  /** False once the owning session/workspace reached a terminal state. */
  live: boolean;
}

/** A mkdir/clone is refused if it would drop free disk below this floor. */
export const DEFAULT_MIN_FREE_DISK_BYTES = 2 * 1024 * 1024 * 1024;
/** Cap on the number of concurrently-registered workspace dirs. */
export const DEFAULT_WORKSPACE_MAX_ENTRIES = 64;

const registry = new Map<string, WorkspaceRegistryEntry>();

/**
 * Record (or refresh) a workspace directory as live. Keyed by resolved path so
 * a re-register of the same dir is idempotent — the owning service may call this
 * again after a rename/promote without leaking a stale entry.
 */
export function registerWorkspace(
  path: string,
  ownerId: string,
  kind: WorkspaceRegistryEntry["kind"],
): void {
  const resolved = resolve(path);
  const existing = registry.get(resolved);
  registry.set(resolved, {
    path: resolved,
    ownerId,
    kind,
    createdAt: existing?.createdAt ?? Date.now(),
    live: true,
  });
}

/** Drop a workspace entry once its directory has actually been removed. */
export function unregisterWorkspace(path: string): void {
  registry.delete(resolve(path));
}

/**
 * Mark a workspace's owner as terminated without removing the entry: the dir
 * may still exist on disk (pending its owner's guarded rm, or a crash before
 * it). GC and the LRU cap treat non-live entries as reclaimable.
 */
export function markWorkspaceTerminated(path: string): void {
  const resolved = resolve(path);
  const entry = registry.get(resolved);
  if (entry) entry.live = false;
}

/** Resolved paths of every directory whose owner is still live. */
export function liveWorkspacePaths(): Set<string> {
  const live = new Set<string>();
  for (const entry of registry.values()) {
    if (entry.live) live.add(entry.path);
  }
  return live;
}

/** Snapshot of all entries (test/diagnostic use). */
export function registeredWorkspaces(): WorkspaceRegistryEntry[] {
  return [...registry.values()];
}

/** Test hook: empty the registry so each test starts from a known state. */
export function _resetWorkspaceRegistry(): void {
  registry.clear();
}

/**
 * Free bytes on the filesystem backing `path`. Returns null when the platform
 * lacks `statfs` support or the path can't be stat'd — callers treat a null as
 * "unknown, don't block" so a precheck failure never wedges a legitimate spawn.
 */
export async function freeDiskBytes(path: string): Promise<number | null> {
  try {
    const st = await statfs(path);
    return st.bavail * st.bsize;
  } catch {
    // error-policy:J3 statfs is a best-effort probe; an unsupported platform or
    // unresolvable path yields an explicit "unknown" (null) the caller branches
    // on, never a fabricated free-space number.
    return null;
  }
}

export interface DiskPrecheckResult {
  ok: boolean;
  /** True when the total-workspace cap is exceeded (forced GC should run). */
  overCap: boolean;
  /** Non-live entries, oldest first — LRU eviction candidates when over budget. */
  evictable: WorkspaceRegistryEntry[];
  reason?: string;
}

/**
 * Decide whether a new workspace may be provisioned at `targetPath`.
 *
 * Two independent limits: a total committed-workspace count cap (registry size)
 * and a free-disk floor on the target filesystem. Either being violated returns
 * `ok:false`; `overCap` and the `evictable` (terminated, oldest-first) list let
 * the caller force a GC pass and retry rather than hard-failing outright. A
 * null free-disk reading (unsupported platform) does not block.
 */
export async function checkDiskBudget(
  targetPath: string,
  opts: {
    maxWorkspaces?: number;
    minFreeDiskBytes?: number;
  } = {},
): Promise<DiskPrecheckResult> {
  const maxWorkspaces = opts.maxWorkspaces ?? DEFAULT_WORKSPACE_MAX_ENTRIES;
  const minFreeDiskBytes = opts.minFreeDiskBytes ?? DEFAULT_MIN_FREE_DISK_BYTES;

  const evictable = [...registry.values()]
    .filter((e) => !e.live)
    .sort((a, b) => a.createdAt - b.createdAt);

  const overCap = registry.size >= maxWorkspaces;
  const free = await freeDiskBytes(targetPath);
  const lowDisk = free !== null && free < minFreeDiskBytes;

  if (overCap) {
    return {
      ok: false,
      overCap: true,
      evictable,
      reason: `workspace cap reached (${registry.size}/${maxWorkspaces})`,
    };
  }
  if (lowDisk) {
    return {
      ok: false,
      overCap: false,
      evictable,
      reason: `free disk ${free} below floor ${minFreeDiskBytes}`,
    };
  }
  return { ok: true, overCap: false, evictable };
}
