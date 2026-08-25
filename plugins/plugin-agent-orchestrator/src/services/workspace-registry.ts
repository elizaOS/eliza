/**
 * Process-global accounting ledger for every scratch/workspace directory the
 * orchestrator creates on disk, and the disk-backpressure gate that runs before
 * a new one is provisioned. It is the single lifecycle owner that spans the two
 * otherwise-disjoint disk consumers — `AcpService` per-session scratch dirs and
 * `CodingWorkspaceService` git clones/worktrees — so a shared total-workspace
 * cap and a free-disk floor can be enforced across both.
 *
 * Safety invariant (the reason #13803 was closed): reclaimability is derived
 * ONLY from a record this registry wrote in `register()` at creation time. A
 * path the ledger never saw is never touched, and reclaim never infers
 * ownership from a `task-*` path shape — that inference is exactly what could
 * delete a caller-owned `$ELIZA_WORKSPACE_DIR/task-foo`. Deletion authority is
 * per-record: only `git-workspace` records are reclaimed by this registry (that
 * clone path has no other GC on the cap); `acp-scratch` records are
 * accounting-only — `AcpService`'s session-store-owned GC (proven by
 * `ACP_METADATA_ISOLATED_WORKDIR`) remains their sole deleter, and this ledger
 * merely flips their `live` flag so they stop counting against the cap.
 */
import type { Dirent } from "node:fs";
import { readdir, rm, stat, statfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ElizaError } from "@elizaos/core";

export type WorkspaceKind = "acp-scratch" | "git-workspace";

export interface WorkspaceRecord {
  /** Absolute, resolved directory path — the ledger key. */
  readonly path: string;
  readonly kind: WorkspaceKind;
  /** Owning session id (ACP) or workspace id (git) — for diagnostics only. */
  readonly ownerId: string;
  readonly createdAt: number;
  /**
   * True while the owner is still using the dir. A live record is never
   * reclaimed and always counts against the cap; teardown flips it to false.
   */
  live: boolean;
}

export interface DiskBudgetConfig {
  /**
   * Total bytes the sum of all registered workspace dirs may occupy before a
   * new provision forces reclaim of terminal git workspaces. `undefined`
   * disables the total cap (free-disk floor still applies).
   */
  readonly capBytes?: number;
  /**
   * Minimum free bytes that must remain on the target filesystem AFTER the new
   * dir is created. A provision is refused when the filesystem is below this
   * floor and reclaim cannot recover enough. `undefined` disables the floor.
   */
  readonly minFreeBytes?: number;
}

/** 20 GiB default total cap; a busy swarm of clones stays well under this. */
export const DEFAULT_WORKSPACE_DISK_CAP_BYTES = 20 * 1024 * 1024 * 1024;
/** 2 GiB default free-disk floor; below this, clones/mkdirs are refused. */
export const DEFAULT_WORKSPACE_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

export interface BudgetDecision {
  readonly allowed: boolean;
  /** Bytes freed by reclaiming terminal git workspaces during this check. */
  readonly reclaimedBytes: number;
  /** Number of terminal git-workspace dirs reclaimed. */
  readonly reclaimedCount: number;
  /** Free bytes on the target filesystem after any reclaim. */
  readonly freeBytes: number;
  /** Sum of registered workspace bytes after any reclaim. */
  readonly usedBytes: number;
  /** Populated only when `allowed` is false. */
  readonly reason?: "cap-exceeded" | "free-disk-floor";
}

type Logger = (
  level: "debug" | "info" | "warn",
  message: string,
  context?: Record<string, unknown>,
) => void;

/**
 * Recursively sum regular-file sizes under `dir`. Symlinks are stat'd with
 * `lstat` semantics via `stat`'s follow — but directory recursion uses
 * `withFileTypes` and never follows symlinked directories, so a workspace that
 * symlinks a shared store is not double-counted or walked out of bounds. A
 * vanished entry (concurrent teardown) contributes zero rather than throwing;
 * the caller is measuring a best-effort footprint, not auditing.
 */
export async function measureDirBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // A dir that vanished or is unreadable contributes nothing measurable.
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      total += await measureDirBytes(full);
      continue;
    }
    try {
      const st = await stat(full);
      total += st.size;
    } catch {
      // Raced with teardown — skip.
    }
  }
  return total;
}

/**
 * Free bytes on the filesystem backing `path`, or `undefined` when the platform
 * cannot report it. `undefined` is an explicit "unknown" (never fabricated as
 * plenty-of-space): the caller treats an unknown reading as a hard refusal when
 * a floor is configured, so a broken `statfs` fails closed, not open.
 *
 * The backpressure gate measures a workspace root BEFORE that root (or its
 * `task-*` child) is created, and `statfs` throws `ENOENT` on a path that does
 * not exist yet — so a not-yet-created target is measured against the nearest
 * existing ancestor, which is on the same filesystem that will host it. Without
 * this walk, the very first spawn on a cold machine (where `$TMPDIR/eliza-acp`
 * has never been created) would be refused as if the disk were full. A
 * genuinely unreadable filesystem still yields `undefined` (every ancestor up
 * to the root throws), preserving the fail-closed contract.
 */
export async function freeBytesFor(path: string): Promise<number | undefined> {
  let current = resolve(path);
  for (;;) {
    try {
      const st = await statfs(current);
      // bavail is blocks available to unprivileged users; bsize the block size.
      return st.bavail * st.bsize;
    } catch {
      const parent = dirname(current);
      // `dirname` is a fixed point at the filesystem root ("/" → "/", "C:\" →
      // "C:\"): once we can climb no further and still cannot stat, the reading
      // is genuinely unknown.
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

export class WorkspaceRegistry {
  private readonly records = new Map<string, WorkspaceRecord>();

  constructor(private readonly log: Logger = () => {}) {}

  /**
   * Record a dir the caller just created. Idempotent on path: re-registering an
   * existing path refreshes its owner/kind/live and keeps the original
   * `createdAt` so LRU order survives a re-register. Callers MUST call this only
   * after the mkdir/clone succeeded — an unregistered path is invisible to the
   * cap and never reclaimable, which is the intended fail-safe.
   */
  register(kind: WorkspaceKind, dir: string, ownerId: string): void {
    const path = resolve(dir);
    const existing = this.records.get(path);
    this.records.set(path, {
      path,
      kind,
      ownerId,
      createdAt: existing?.createdAt ?? Date.now(),
      live: true,
    });
  }

  /**
   * Flip a record to terminal. It stops counting toward the cap and becomes a
   * reclaim candidate (git-workspace only). A no-op for an unregistered path —
   * the registry never learns about dirs it did not create.
   */
  markTerminal(dir: string): void {
    const record = this.records.get(resolve(dir));
    if (record) {
      record.live = false;
    }
  }

  /** Drop a record entirely (the owner deleted the dir itself). */
  unregister(dir: string): void {
    this.records.delete(resolve(dir));
  }

  has(dir: string): boolean {
    return this.records.has(resolve(dir));
  }

  isLive(dir: string): boolean {
    return this.records.get(resolve(dir))?.live === true;
  }

  list(): WorkspaceRecord[] {
    return Array.from(this.records.values());
  }

  size(): number {
    return this.records.size;
  }

  /** Sum measured bytes across every currently-registered dir. */
  async usedBytes(): Promise<number> {
    let total = 0;
    for (const record of this.records.values()) {
      total += await measureDirBytes(record.path);
    }
    return total;
  }

  /**
   * Reclaim terminal `git-workspace` records, oldest first, until at least
   * `targetFreeBytes` have been freed (or no more candidates remain). Only dirs
   * this registry recorded are ever passed to `rm`; live records and
   * `acp-scratch` records are never touched here. Returns freed bytes + count.
   */
  private async reclaimTerminalGitWorkspaces(
    targetFreeBytes: number,
  ): Promise<{ freed: number; count: number }> {
    const candidates = Array.from(this.records.values())
      .filter((r) => r.kind === "git-workspace" && !r.live)
      .sort((a, b) => {
        const aTime = Number.isFinite(a.createdAt) ? a.createdAt : 0;
        const bTime = Number.isFinite(b.createdAt) ? b.createdAt : 0;
        return aTime - bTime;
      });
    let freed = 0;
    let count = 0;
    for (const record of candidates) {
      if (freed >= targetFreeBytes) break;
      const bytes = await measureDirBytes(record.path);
      try {
        await rm(record.path, { recursive: true, force: true });
      } catch (err) {
        // error-policy:J6 best-effort eviction; a locked/vanished dir is skipped
        // so the sweep continues and the cap is retried on the next provision.
        this.log("warn", "workspace registry: failed to evict terminal dir", {
          path: record.path,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      this.records.delete(record.path);
      freed += bytes;
      count += 1;
    }
    return { freed, count };
  }

  /**
   * Backpressure gate to run BEFORE creating a new workspace dir under
   * `targetRoot`. Enforces two independent limits: (1) the total registered-byte
   * cap, force-reclaiming terminal git workspaces (LRU) to get back under it;
   * (2) a free-disk floor on the filesystem backing `targetRoot`, likewise
   * reclaiming to recover headroom. An unknown free-disk reading fails closed
   * when a floor is set. Never deletes a live or unregistered dir.
   */
  async checkDiskBudget(
    targetRoot: string,
    config: DiskBudgetConfig,
  ): Promise<BudgetDecision> {
    let reclaimedBytes = 0;
    let reclaimedCount = 0;

    let used = await this.usedBytes();
    if (config.capBytes !== undefined && used > config.capBytes) {
      const { freed, count } = await this.reclaimTerminalGitWorkspaces(
        used - config.capBytes,
      );
      reclaimedBytes += freed;
      reclaimedCount += count;
      used = Math.max(0, used - freed);
      if (used > config.capBytes) {
        this.log("warn", "workspace registry: total cap exceeded", {
          usedBytes: used,
          capBytes: config.capBytes,
          reclaimedBytes,
        });
        return {
          allowed: false,
          reclaimedBytes,
          reclaimedCount,
          freeBytes: (await freeBytesFor(targetRoot)) ?? 0,
          usedBytes: used,
          reason: "cap-exceeded",
        };
      }
    }

    if (config.minFreeBytes !== undefined) {
      let free = await freeBytesFor(targetRoot);
      if (free === undefined || free < config.minFreeBytes) {
        const deficit =
          free === undefined ? config.minFreeBytes : config.minFreeBytes - free;
        const { freed, count } =
          await this.reclaimTerminalGitWorkspaces(deficit);
        reclaimedBytes += freed;
        reclaimedCount += count;
        free = await freeBytesFor(targetRoot);
      }
      if (free === undefined || free < config.minFreeBytes) {
        this.log("warn", "workspace registry: free-disk floor breached", {
          targetRoot,
          freeBytes: free,
          minFreeBytes: config.minFreeBytes,
          reclaimedBytes,
        });
        return {
          allowed: false,
          reclaimedBytes,
          reclaimedCount,
          freeBytes: free ?? 0,
          usedBytes: used,
          reason: "free-disk-floor",
        };
      }
      return {
        allowed: true,
        reclaimedBytes,
        reclaimedCount,
        freeBytes: free,
        usedBytes: used,
      };
    }

    return {
      allowed: true,
      reclaimedBytes,
      reclaimedCount,
      freeBytes: (await freeBytesFor(targetRoot)) ?? 0,
      usedBytes: used,
    };
  }
}

/**
 * The one place a refused {@link BudgetDecision} becomes a throwable error.
 * The message is deliberately human — an action-boundary catch relays
 * `error.message` toward chat, so byte counts, caps, and filesystem paths
 * must never ride in it. The technical fields live in the structured
 * `context` (for the action's error data / `reportError`) and are already
 * warn-logged by `checkDiskBudget` at refusal time.
 */
export function workspaceDiskBudgetError(
  decision: BudgetDecision,
  config: DiskBudgetConfig,
  targetRoot: string,
): ElizaError {
  return new ElizaError(
    "the workspace disk is nearly full, so a new coding workspace cannot be created right now",
    {
      code: "WORKSPACE_DISK_BUDGET_EXCEEDED",
      severity: "ephemeral",
      context: {
        reason: decision.reason ?? "unknown",
        usedBytes: decision.usedBytes,
        freeBytes: decision.freeBytes,
        capBytes: config.capBytes,
        minFreeBytes: config.minFreeBytes,
        reclaimedBytes: decision.reclaimedBytes,
        reclaimedCount: decision.reclaimedCount,
        targetRoot,
      },
    },
  );
}

/**
 * Parse a byte-count setting. Accepts a bare integer (bytes). Returns
 * `undefined` for absent/blank/non-positive input so a caller can distinguish
 * "unset → use default" from an explicit disable via `0`... which we treat as
 * unset too: disabling a disk floor is done by leaving it unset, not by 0.
 */
export function parseByteSetting(
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

/**
 * Resolve the shared disk-budget config from env-style settings. `capBytes` and
 * `minFreeBytes` fall back to the module defaults when unset; pass `"0"` is
 * treated as unset (see `parseByteSetting`), so tunables only ever raise or
 * lower a real limit, never silently remove it.
 */
export function resolveDiskBudgetConfig(
  read: (key: string) => string | undefined,
): DiskBudgetConfig {
  return {
    capBytes:
      parseByteSetting(read("ELIZA_WORKSPACE_DISK_CAP_BYTES")) ??
      DEFAULT_WORKSPACE_DISK_CAP_BYTES,
    minFreeBytes:
      parseByteSetting(read("ELIZA_WORKSPACE_MIN_FREE_BYTES")) ??
      DEFAULT_WORKSPACE_MIN_FREE_BYTES,
  };
}

let sharedRegistry: WorkspaceRegistry | undefined;

/**
 * Process-global registry shared by every AcpService and CodingWorkspaceService
 * instance so the cap spans all disk consumers in the process. A process-global
 * (not per-runtime) singleton is deliberate: multi-tenant hosts and hot-reload
 * cycles construct multiple service instances against ONE filesystem, and the
 * disk budget is a property of the filesystem, not of any one runtime.
 */
export function getSharedWorkspaceRegistry(log?: Logger): WorkspaceRegistry {
  if (!sharedRegistry) {
    sharedRegistry = new WorkspaceRegistry(log);
  }
  return sharedRegistry;
}

/** Test-only reset of the process-global registry. */
export function resetSharedWorkspaceRegistry(): void {
  sharedRegistry = undefined;
}
