/**
 * Scratch workspace lifecycle helpers remove temporary coding-agent directories
 * only after path resolution proves they sit under the configured workspace
 * base or an explicitly allowed root.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Remove a scratch directory safely — only if under baseDir or one of allowedDirs. */
export async function removeScratchDir(
  dirPath: string,
  baseDir: string,
  log: (msg: string) => void,
  allowedDirs?: string[],
): Promise<void> {
  const resolved = path.resolve(dirPath);

  // Safety: only remove if under baseDir or one of the allowed directories
  const expandTilde = (p: string) =>
    p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
  const allAllowed = [baseDir, ...(allowedDirs ?? [])];
  const isAllowed = allAllowed.some((dir) => {
    const resolvedDir = path.resolve(expandTilde(dir)) + path.sep;
    return (
      resolved.startsWith(resolvedDir) ||
      resolved === path.resolve(expandTilde(dir))
    );
  });

  if (!isAllowed) {
    log(
      `[CodingWorkspaceService] Refusing to remove dir outside allowed paths: ${resolved}`,
    );
    return;
  }
  try {
    await fs.promises.rm(resolved, { recursive: true, force: true });
    log(`Removed scratch dir ${resolved}`);
  } catch (err) {
    // error-policy:J6 best-effort scratch-dir teardown; rm failure is logged and non-fatal
    log(
      `[CodingWorkspaceService] Failed to remove scratch dir ${resolved}: ${err}`,
    );
  }
}

/** Garbage-collect orphaned workspace directories older than workspaceTtlMs. */
export async function gcOrphanedWorkspaces(
  baseDir: string,
  workspaceTtlMs: number,
  trackedWorkspaceIds: Set<string>,
  log: (msg: string) => void,
): Promise<void> {
  if (workspaceTtlMs === 0) {
    log("Workspace GC disabled (workspaceTtlMs=0)");
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(baseDir, { withFileTypes: true });
  } catch {
    // error-policy:J4 base dir absent (readdir failed) → nothing to GC; designed no-op
    // Base dir doesn't exist yet — nothing to clean
    return;
  }

  const now = Date.now();
  let removed = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    if (trackedWorkspaceIds.has(entry.name)) {
      skipped++;
      continue;
    }

    const dirPath = path.join(baseDir, entry.name);
    try {
      const stat = await fs.promises.stat(dirPath);
      const age = now - stat.mtimeMs;

      if (age > workspaceTtlMs) {
        await fs.promises.rm(dirPath, { recursive: true, force: true });
        removed++;
      } else {
        skipped++;
      }
    } catch (err) {
      // error-policy:J6 best-effort GC cleanup; per-entry stat/rm failure is logged and skipped so the loop continues
      // Stat or remove failed — skip
      log(`GC: skipping ${entry.name}: ${err}`);
      skipped++;
    }
  }

  if (removed > 0 || skipped > 0) {
    log(
      `Startup GC: removed ${removed} orphaned workspace(s), kept ${skipped}`,
    );
  }
}

/**
 * True only for an isolated per-session scratch dir the AcpService itself
 * created: `spawnSession` names an isolated workdir exactly `task-<sessionId>`
 * (`computeSessionWorkdir` with isolate=true) as a DIRECT child of a scratch
 * root. A cwd self-checkout, or a route/convention/explicit workdir, never
 * carries this basename — so this can never authorize removing a user's repo or
 * the runtime's own checkout. `sessionId` is an unguessable UUID, making the
 * basename match a strong ownership proof; the root check is defense in depth.
 */
export function isIsolatedScratchDir(
  workdir: string,
  sessionId: string,
  scratchRoots: readonly string[],
): boolean {
  const resolved = path.resolve(workdir);
  if (resolved === path.resolve(process.cwd())) return false;
  if (path.basename(resolved) !== `task-${sessionId}`) return false;
  const parent = path.dirname(resolved);
  return scratchRoots.some((root) => path.resolve(root) === parent);
}

/**
 * Reclaim per-session `task-<id>` scratch dirs left behind when a SIGKILL hit
 * mid-teardown so the terminal-event removal never ran. Scans each scratch root
 * and removes every `task-<id>` child whose id is not currently live; a
 * non-`task-` entry is never considered, so a configured root that also holds
 * real project checkouts is safe. Returns the number of dirs reclaimed.
 */
export async function reclaimOrphanedScratchDirs(
  scratchRoots: readonly string[],
  isLiveSessionId: (id: string) => boolean,
  log: (msg: string) => void,
): Promise<number> {
  const prefix = "task-";
  let removed = 0;
  const scanned = new Set<string>();
  for (const root of scratchRoots) {
    const resolvedRoot = path.resolve(root);
    if (scanned.has(resolvedRoot)) continue;
    scanned.add(resolvedRoot);

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(resolvedRoot, {
        withFileTypes: true,
      });
    } catch {
      // error-policy:J4 root absent (readdir failed) → nothing to reclaim; designed no-op
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const id = entry.name.slice(prefix.length);
      if (id.length === 0 || isLiveSessionId(id)) continue;
      const dir = path.join(resolvedRoot, entry.name);
      // Re-validate through the same ownership guard the teardown path uses.
      if (!isIsolatedScratchDir(dir, id, [resolvedRoot])) continue;
      try {
        await fs.promises.rm(dir, { recursive: true, force: true });
        removed++;
        log(`Startup scratch GC: reclaimed orphaned session dir ${dir}`);
      } catch (err) {
        // error-policy:J6 best-effort orphan reclaim; per-dir rm failure is logged and skipped so the scan continues
        log(`Startup scratch GC: failed to remove ${dir}: ${err}`);
      }
    }
  }
  return removed;
}
