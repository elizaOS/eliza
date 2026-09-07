/**
 * Resolves development-only plugin source without loading the agent runtime graph.
 * Workspace metadata is not a published export: callers must enforce source-mode
 * policy before using it. The dev watcher shares the same declaration validation.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export type PackageExportEntry =
  | string
  | {
      "eliza-source"?: PackageExportEntry;
      bun?: PackageExportEntry;
      node?: PackageExportEntry;
      import?: string;
      default?: string;
    };

/** Ordered candidates used by both generic imports and explicit source selection. */
export function packageExportCandidates(
  entry: unknown,
  sourceConditions?: ReadonlySet<string>,
): string[] {
  if (typeof entry === "string") return [entry];
  if (entry === null || entry === undefined) {
    throw new TypeError("Invalid package export declaration");
  }
  if (!isObject(entry)) return [];
  const conditions = sourceConditions
    ? Object.keys(entry).filter((condition) => sourceConditions.has(condition))
    : ["eliza-source", "import", "default"];
  return conditions.flatMap((condition) => {
    const candidate = entry[condition];
    if (
      !sourceConditions &&
      (condition === "import" || condition === "default")
    ) {
      return typeof candidate === "string" ? [candidate] : [];
    }
    return candidate
      ? packageExportCandidates(candidate, sourceConditions)
      : [];
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Invalid explicit source is an error, never permission to load stale dist. */
export class WorkspacePluginSourceError extends Error {
  readonly code = "WORKSPACE_PLUGIN_SOURCE_INVALID";
}

function invalidSource(packageRoot: string, detail: string): never {
  throw new WorkspacePluginSourceError(
    `Invalid workspace plugin source in ${packageRoot}: ${detail}`,
  );
}

function confinedSourceFile(packageRoot: string, entry: string): string {
  const relative = path.relative(packageRoot, path.resolve(packageRoot, entry));
  if (
    !entry.startsWith("./") ||
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    /(?:^|[/\\])(?:dist|node_modules|build)(?:[/\\]|$)/.test(relative) ||
    /\.d\.[cm]?ts$/.test(relative)
  ) {
    return invalidSource(
      packageRoot,
      `entry is not package-local source: ${entry}`,
    );
  }
  const candidate = path.resolve(packageRoot, entry);
  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    return invalidSource(
      packageRoot,
      `declared entry is missing or not a file: ${entry}`,
    );
  }
  const canonicalRoot = realpathSync(packageRoot);
  const canonicalEntry = realpathSync(candidate);
  const canonicalRelative = path.relative(canonicalRoot, canonicalEntry);
  if (
    canonicalRelative === ".." ||
    canonicalRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(canonicalRelative) ||
    /(?:^|[/\\])(?:dist|node_modules|build)(?:[/\\]|$)/.test(canonicalRelative)
  ) {
    return invalidSource(
      packageRoot,
      `entry resolves outside package source: ${entry}`,
    );
  }
  return canonicalEntry;
}

/**
 * Selects a workspace-only declaration, then the existing eliza-source export,
 * then the conventional src entry. A declared false disables the source entry.
 * This function does not activate source mode for installed/default imports.
 */
export function resolvePackageSourceEntry(
  packageRoot: string,
  exportSubpath = ".",
  useDeclarations = true,
): string | null {
  if (exportSubpath !== "." && !/^\.\/[a-zA-Z0-9_-]+$/.test(exportSubpath)) {
    return invalidSource(
      packageRoot,
      `unsupported export subpath: ${exportSubpath}`,
    );
  }
  const manifestPath = path.join(packageRoot, "package.json");
  if (useDeclarations && existsSync(manifestPath)) {
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!isObject(manifest))
      return invalidSource(packageRoot, "invalid package.json object");
    const elizaos = isObject(manifest.elizaos) ? manifest.elizaos : undefined;
    const plugin = isObject(elizaos?.plugin) ? elizaos.plugin : undefined;
    const workspaceSource = plugin?.workspaceSource;
    if (workspaceSource === false) return null;
    if (workspaceSource !== undefined && !isObject(workspaceSource)) {
      return invalidSource(
        packageRoot,
        "workspaceSource must map export subpaths to source files or false",
      );
    }
    if (
      isObject(workspaceSource) &&
      Object.hasOwn(workspaceSource, exportSubpath)
    ) {
      const entry = workspaceSource[exportSubpath];
      if (entry === false) return null;
      if (typeof entry !== "string")
        return invalidSource(
          packageRoot,
          `invalid source declaration for ${exportSubpath}`,
        );
      return confinedSourceFile(packageRoot, entry);
    }
    const entry = isObject(manifest.exports)
      ? manifest.exports[exportSubpath]
      : undefined;
    if (isObject(entry) && Object.hasOwn(entry, "eliza-source")) {
      const sourceExport = entry["eliza-source"];
      const candidates = packageExportCandidates(
        sourceExport,
        new Set([
          ...(process.versions.bun ? ["bun"] : []),
          "node",
          "import",
          "default",
        ]),
      );
      // A selected platform wrapper is authoritative, including when missing.
      // Falling through to another source entry can skip its initialization.
      const source = candidates[0];
      if (!source)
        return invalidSource(
          packageRoot,
          `eliza-source export is missing for ${exportSubpath}`,
        );
      return confinedSourceFile(packageRoot, source);
    }
  }
  const entryFile =
    exportSubpath === "." ? "index.ts" : `${exportSubpath.slice(2)}.ts`;
  const conventional = `./src/${entryFile}`;
  return existsSync(path.join(packageRoot, conventional))
    ? confinedSourceFile(packageRoot, conventional)
    : null;
}

/**
 * Keeps production on bundled/installed plugins unless debugging explicitly
 * opts in. The workspace-override kill switch always wins, including in dev.
 */
export function isWorkspacePluginSourceFallbackAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.ELIZA_DISABLE_WORKSPACE_PLUGIN_OVERRIDES === "1") return false;
  const isProduction =
    env.NODE_ENV === "production" || env.ELIZA_BUILD_VARIANT === "production";
  if (isProduction) return env.ELIZA_ALLOW_WORKSPACE_PLUGIN_SRC === "1";
  return true;
}

export function resolveWorkspacePluginSourceEntry(
  packageName: string,
  startDirectory: string,
  exportSubpath = ".",
  useDeclarations = true,
): string | null {
  if (!/^@elizaos\/plugin-[a-z0-9-]+$/.test(packageName)) return null;
  const shortName = packageName.slice("@elizaos/".length);
  let dir = startDirectory;
  for (let depth = 0; depth < 14; depth += 1) {
    const packageRoot = path.join(dir, "plugins", shortName);
    if (existsSync(packageRoot)) {
      return resolvePackageSourceEntry(
        packageRoot,
        exportSubpath,
        useDeclarations,
      );
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
