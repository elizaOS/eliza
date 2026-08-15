/**
 * Detects workspace plugins whose resolved development runtime entry predates
 * the source that produces it. The check follows each package's root export
 * conditions instead of assuming a common dist layout, and skips packages
 * that the `eliza-source` condition already loads directly from source.
 * Filesystem and manifest failures remain diagnostic-only and are represented
 * explicitly so this helper cannot fabricate a healthy result.
 */
import {
  type Dirent,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
]);
const IGNORED_DIRS = new Set([
  "dist",
  "node_modules",
  "__tests__",
  "test",
  "tests",
  "e2e",
  ".turbo",
  "coverage",
]);
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[^.]+$/;

type ExportTarget =
  | string
  | null
  | ExportTarget[]
  | { [condition: string]: ExportTarget };

interface PackageManifest {
  name?: unknown;
  exports?: unknown;
  module?: unknown;
  main?: unknown;
}

export type PluginDistStatusKind =
  | "stale"
  | "fresh"
  | "source-loaded"
  | "no-dist"
  | "no-source"
  | "no-manifest"
  | "no-entry";

export interface PluginDistStatus {
  packageDir: string;
  packageName?: string;
  status: PluginDistStatusKind;
  runtimeEntryPath?: string;
  runtimeEntryMtimeMs?: number;
  newestSourcePath?: string;
  newestSourceMtimeMs?: number;
}

export interface StalenessSweepResult {
  scanned: number;
  distLoaded: number;
  sourceLoaded: number;
  stale: PluginDistStatus[];
}

function runtimeConditions(): ReadonlySet<string> {
  return new Set([
    "eliza-source",
    "node",
    "import",
    ...(process.versions.bun ? ["bun"] : []),
  ]);
}

function resolveConditionalTarget(
  target: ExportTarget,
  conditions: ReadonlySet<string>,
): string | null {
  if (typeof target === "string") return target;
  if (target === null) return null;
  if (Array.isArray(target)) {
    for (const candidate of target) {
      const resolved = resolveConditionalTarget(candidate, conditions);
      if (resolved) return resolved;
    }
    return null;
  }
  if (typeof target !== "object") return null;
  for (const [condition, candidate] of Object.entries(target)) {
    if (condition !== "default" && !conditions.has(condition)) continue;
    const resolved = resolveConditionalTarget(candidate, conditions);
    if (resolved) return resolved;
  }
  return null;
}

function readManifest(packageDir: string): PackageManifest | null {
  try {
    const value: unknown = JSON.parse(
      readFileSync(path.join(packageDir, "package.json"), "utf8"),
    );
    return value && typeof value === "object"
      ? (value as PackageManifest)
      : null;
  } catch {
    // error-policy:J3 package manifests are untrusted diagnostic input; an
    // unreadable or invalid manifest produces an explicit no-manifest state.
    return null;
  }
}

function rootExportTarget(
  manifest: PackageManifest,
  conditions: ReadonlySet<string>,
): ExportTarget | null {
  const exportsValue = manifest.exports;
  if (typeof exportsValue === "string" || Array.isArray(exportsValue)) {
    return exportsValue as ExportTarget;
  }
  if (exportsValue && typeof exportsValue === "object") {
    const exportsRecord = exportsValue as Record<string, ExportTarget>;
    if (Object.hasOwn(exportsRecord, ".")) return exportsRecord["."] ?? null;
    // A condition map without subpath keys is itself the root export.
    if (!Object.keys(exportsRecord).some((key) => key.startsWith("."))) {
      return exportsRecord;
    }
  }
  if (conditions.has("bun") && typeof manifest.module === "string") {
    return manifest.module;
  }
  if (typeof manifest.main === "string") return manifest.main;
  if (typeof manifest.module === "string") return manifest.module;
  return null;
}

function resolvePackagePath(packageDir: string, target: string): string | null {
  if (!target.startsWith("./")) return null;
  const resolved = path.resolve(packageDir, target);
  const relative = path.relative(packageDir, resolved);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".."
    ? resolved
    : null;
}

function fileMtime(filePath: string): number | null {
  const stats = statSync(filePath, { throwIfNoEntry: false });
  return stats?.isFile() ? stats.mtimeMs : null;
}

function findNewestSource(
  sourceRoot: string,
): { filePath: string; mtimeMs: number } | null {
  let newest: { filePath: string; mtimeMs: number } | null = null;
  const pending = [sourceRoot];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (!dir) continue;
    const entries: Dirent[] = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith("."))
          continue;
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile() || TEST_FILE_PATTERN.test(entry.name)) continue;
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
      const mtimeMs = fileMtime(entryPath);
      if (mtimeMs !== null && (!newest || mtimeMs > newest.mtimeMs)) {
        newest = { filePath: entryPath, mtimeMs };
      }
    }
  }
  return newest;
}

/** Compare one package's actual development entry against its source tree. */
export function checkPluginDistStaleness(
  packageDir: string,
  conditions: ReadonlySet<string> = runtimeConditions(),
): PluginDistStatus {
  const manifest = readManifest(packageDir);
  if (!manifest) return { packageDir, status: "no-manifest" };
  const packageName =
    typeof manifest.name === "string" ? manifest.name : undefined;
  const target = resolveConditionalTarget(
    rootExportTarget(manifest, conditions),
    conditions,
  );
  if (!target) return { packageDir, packageName, status: "no-entry" };
  const runtimeEntryPath = resolvePackagePath(packageDir, target);
  if (!runtimeEntryPath) {
    return { packageDir, packageName, status: "no-entry" };
  }
  const distDir = path.join(packageDir, "dist");
  const relativeToDist = path.relative(distDir, runtimeEntryPath);
  const loadsDist =
    relativeToDist !== "" &&
    relativeToDist !== ".." &&
    !relativeToDist.startsWith(`..${path.sep}`);
  if (!loadsDist) {
    return {
      packageDir,
      packageName,
      status: "source-loaded",
      runtimeEntryPath,
    };
  }
  const runtimeEntryMtimeMs = fileMtime(runtimeEntryPath);
  if (runtimeEntryMtimeMs === null) {
    return { packageDir, packageName, status: "no-dist", runtimeEntryPath };
  }
  const conventionalSourceRoot = path.join(packageDir, "src");
  const sourceRoot = existsSync(conventionalSourceRoot)
    ? conventionalSourceRoot
    : packageDir;
  const newestSource = findNewestSource(sourceRoot);
  if (!newestSource) {
    return {
      packageDir,
      packageName,
      status: "no-source",
      runtimeEntryPath,
      runtimeEntryMtimeMs,
    };
  }
  return {
    packageDir,
    packageName,
    status: newestSource.mtimeMs > runtimeEntryMtimeMs ? "stale" : "fresh",
    runtimeEntryPath,
    runtimeEntryMtimeMs,
    newestSourcePath: newestSource.filePath,
    newestSourceMtimeMs: newestSource.mtimeMs,
  };
}

/** Sweep workspace plugin manifests and warn once per stale dist-loaded entry. */
export function warnStalePluginDists(options: {
  pluginsRoot: string;
  warn: (message: string) => void;
  conditions?: ReadonlySet<string>;
}): StalenessSweepResult {
  const { pluginsRoot, warn, conditions = runtimeConditions() } = options;
  const result: StalenessSweepResult = {
    scanned: 0,
    distLoaded: 0,
    sourceLoaded: 0,
    stale: [],
  };
  if (!existsSync(pluginsRoot)) return result;
  let entries: Dirent[];
  try {
    entries = readdirSync(pluginsRoot, { withFileTypes: true });
  } catch (error) {
    // error-policy:J4 the optional diagnostic becomes visibly unavailable;
    // the development server remains healthy and no clean result is claimed.
    warn(
      `[eliza] plugin dist staleness check unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("plugin-")) continue;
    const packageDir = path.join(pluginsRoot, entry.name);
    result.scanned += 1;
    let status: PluginDistStatus;
    try {
      status = checkPluginDistStaleness(packageDir, conditions);
    } catch (error) {
      // error-policy:J4 one unreadable package is named as unavailable while
      // the rest of the optional development diagnostic continues.
      warn(
        `[eliza] ${entry.name}: stale-dist check unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (status.status === "source-loaded") {
      result.sourceLoaded += 1;
      continue;
    }
    if (
      status.status === "stale" ||
      status.status === "fresh" ||
      status.status === "no-dist" ||
      status.status === "no-source"
    ) {
      result.distLoaded += 1;
    }
    if (status.status !== "stale") continue;
    result.stale.push(status);
    warn(
      `[eliza] ${entry.name}: resolved entry is OLDER than source, so edits are NOT running. ` +
        `newest source ${status.newestSourcePath} > ${status.runtimeEntryPath}. ` +
        `Rebuild: bun run --cwd plugins/${entry.name} build`,
    );
  }
  return result;
}
