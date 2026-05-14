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
