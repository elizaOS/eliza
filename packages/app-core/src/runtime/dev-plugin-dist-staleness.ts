/**
 * Dev-host staleness check for workspace plugin dist/ bundles
 * (elizaOS/eliza#18737).
 *
 * Workspace plugins resolve through their package exports to `dist/index.js`
 * with no source condition, so the source-conditioned dev stack silently runs
 * whatever was last built: edit plugin source, restart dev, and the running
 * bytes predate the edit with nothing saying so. This sweep runs once at dev
 * server boot and emits one prominent warning per plugin whose newest source
 * file is newer than its dist entry, naming both paths and the rebuild
 * command. It never changes resolution, never runs in production builds (the
 * dev server is its only caller), and treats every filesystem problem as
 * "skip quietly": a staleness heuristic must never block or slow boot.
 */
import { type Dirent, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Source extensions that compile into a plugin's dist output. */
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".mjs"]);

/** Directories that never contain build inputs. */
const IGNORED_DIRS = new Set([
  "dist",
  "node_modules",
  "__tests__",
  ".turbo",
  "coverage",
]);

export interface PluginDistStatus {
  packageDir: string;
  status: "stale" | "fresh" | "no-dist" | "no-source";
  distPath?: string;
  distMtimeMs?: number;
  newestSourcePath?: string;
  newestSourceMtimeMs?: number;
}

function safeStatMtime(filePath: string): number | null {
  try {
    const stats = statSync(filePath);
    return stats.isFile() ? stats.mtimeMs : null;
  } catch {
    return null;
  }
}

/** Newest source file under `dir`, ignoring build outputs and test dirs. */
function findNewestSource(
  dir: string,
  depth = 0,
): { filePath: string; mtimeMs: number } | null {
  if (depth > 6) return null;
  let newest: { filePath: string; mtimeMs: number } | null = null;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const nested = findNewestSource(entryPath, depth + 1);
      if (nested && (!newest || nested.mtimeMs > newest.mtimeMs)) {
        newest = nested;
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.mjs")) {
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    const mtimeMs = safeStatMtime(entryPath);
    if (mtimeMs !== null && (!newest || mtimeMs > newest.mtimeMs)) {
      newest = { filePath: entryPath, mtimeMs };
    }
  }
  return newest;
}

/** Compare one plugin package's dist entry against its newest source file. */
export function checkPluginDistStaleness(packageDir: string): PluginDistStatus {
  const distPath = path.join(packageDir, "dist", "index.js");
  const distMtimeMs = safeStatMtime(distPath);
  if (distMtimeMs === null) {
    return { packageDir, status: "no-dist" };
  }
  const newestSource = findNewestSource(packageDir);
  if (!newestSource) {
    return { packageDir, status: "no-source", distPath, distMtimeMs };
  }
  return {
    packageDir,
    status: newestSource.mtimeMs > distMtimeMs ? "stale" : "fresh",
    distPath,
    distMtimeMs,
    newestSourcePath: newestSource.filePath,
    newestSourceMtimeMs: newestSource.mtimeMs,
  };
}

export interface StalenessSweepResult {
  scanned: number;
  stale: PluginDistStatus[];
}

/**
 * Sweep every workspace plugin under `pluginsRoot` and warn once per stale
 * dist. Bounded by directory listing (no recursion beyond each package's
 * source walk) and silent on any filesystem error.
 */
export function warnStalePluginDists(options: {
  pluginsRoot: string;
  warn: (message: string) => void;
}): StalenessSweepResult {
  const { pluginsRoot, warn } = options;
  const result: StalenessSweepResult = { scanned: 0, stale: [] };
  let entries: Dirent[];
  try {
    entries = readdirSync(pluginsRoot, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("plugin-")) continue;
    const packageDir = path.join(pluginsRoot, entry.name);
    const status = checkPluginDistStaleness(packageDir);
    result.scanned += 1;
    if (status.status !== "stale") continue;
    result.stale.push(status);
    warn(
      `[eliza] ${entry.name}: dist/ is OLDER than source — the dev stack loads dist, so your edits are NOT running. ` +
        `newest source ${status.newestSourcePath} > ${status.distPath}. ` +
        `Rebuild: bun run --cwd plugins/${entry.name} build`,
    );
  }
  return result;
}
