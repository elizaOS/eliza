/**
 * Plugin discovery and resolution logic.
 *
 * Resolves Eliza plugins from config and auto-enable logic, loading them
 * from static imports, npm packages, workspace overrides, or drop-in
 * directories. Each plugin is wrapped in an error boundary so a single
 * failing plugin cannot crash the agent startup.
 *
 * Extracted from eliza.ts to reduce file size.
 *
 * @module plugin-resolver
 */
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { logger, type Plugin } from "@elizaos/core";
import {
  applyAppManifestDefaults,
  applyPluginManifestVerdicts,
  evaluatePluginManifests,
  filterCandidatesByAppManifest,
  formatError,
  isMobilePlatform,
  type PluginManifestCandidate,
  readAppManifest,
} from "@elizaos/shared";

import { type ElizaConfig, saveElizaConfig } from "../config/config.js";
import { resolveStateDir, resolveUserPath } from "../config/paths.js";
import type { PluginInstallRecord } from "../config/types.eliza.js";
import { diagnoseNoAIProvider } from "../services/version-compat.js";
import { CORE_PLUGINS, OPTIONAL_CORE_PLUGINS } from "./core-plugins.js";
import {
  CHANNEL_PLUGIN_MAP,
  collectPluginNames,
  OPTIONAL_PLUGIN_MAP,
  type PluginLoadReasons,
  resolvePluginPackageAlias,
} from "./plugin-collector.js";
import {
  CUSTOM_PLUGINS_DIRNAME,
  EJECTED_PLUGINS_DIRNAME,
  ensureBrowserServerLink,
  findRuntimePluginExport,
  mergeDropInPlugins,
  type PluginModuleShape,
  type ResolvedPlugin,
  repairBrokenInstallRecord,
  resolveElizaPluginImportSpecifier,
  resolvePackageEntry,
  STATIC_ELIZA_PLUGINS,
  scanDropInPlugins,
} from "./plugin-types.js";

const LAST_FAILED_PLUGIN_NAMES = Symbol.for(
  "@elizaos/plugin-resolver/last-failed-plugin-names",
);

type GlobalWithLastFailedPluginNames = typeof globalThis & {
  [LAST_FAILED_PLUGIN_NAMES]?: string[];
};

const RUNTIME_APP_PLUGIN_SUBPATHS = new Set([
  "@elizaos/app-companion",
  "@elizaos/app-contacts",
  "@elizaos/app-elizamaker",
  "@elizaos/app-lifeops",
  "@elizaos/app-phone",
  "@elizaos/app-polymarket",
  "@elizaos/app-shopify",
  "@elizaos/app-steward",
  "@elizaos/app-vincent",
  "@elizaos/app-wifi",
]);

// ---------------------------------------------------------------------------
// Helpers (private)
// ---------------------------------------------------------------------------

/** Missing npm package, Bun resolve, or browser stagehand — expected when optional plugins are allow-listed but not installed. */
function isBenignOptionalPluginFailure(msg: string): boolean {
  return (
    msg.includes("Cannot find module") ||
    msg.includes("MODULE_NOT_FOUND") ||
    msg.includes("ResolveMessage") ||
    msg === "browser server binary not found"
  );
}

function redactUserSegments(filepath: string): string {
  // Replace /Users/<name>/ or /home/<name>/ with /Users/<redacted>/ etc.
  return filepath.replace(/\/(Users|home)\/[^/]+\//g, "/$1/<redacted>/");
}

export function resolveRuntimePluginImportSpecifier(
  pluginName: string,
): string {
  if (pluginName.startsWith("@elizaos/plugin-")) {
    return resolveElizaPluginImportSpecifier(pluginName);
  }

  return runtimePluginImportSpecifier(pluginName);
}

function sanitizePluginCacheSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

type PluginPackageManifest = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

type DeclaredPluginDependency = {
  name: string;
  optional: boolean;
};

const SOURCE_STAGED_WORKSPACE_DEPENDENCIES = new Set(["@elizaos/agent"]);

const SOURCE_STAGED_ROOT_ENTRYPOINTS: Record<
  string,
  { path: string; source: string }
> = {
  "@elizaos/agent": {
    path: "./src/staged-runtime-index.ts",
    source: `export { extractActionParamsViaLlm } from "./actions/extract-params.js";
export { renderGroundedActionReply } from "./actions/grounded-action-reply.js";
export { extractConversationMetadataFromRoom, isPageScopedConversationMetadata } from "./api/conversation-metadata.js";
export { handleConnectorAccountRoutes } from "./api/connector-account-routes.js";
export { checkRateLimit } from "./api/rate-limiter.js";
export { loadElizaConfig, saveElizaConfig } from "./config/config.js";
export { loadOwnerContactRoutingHints, loadOwnerContactsConfig, resolveOwnerContactWithFallback } from "./config/owner-contacts.js";
export { resolveOAuthDir, resolveStateDir } from "./config/paths.js";
export { createIntegrationTelemetrySpan } from "./diagnostics/integration-observability.js";
export { getAgentEventService } from "./runtime/agent-event-service.js";
export { resolveOwnerEntityId } from "./runtime/owner-entity.js";
export { hasOwnerAccess } from "./security/access.js";
export { gatePluginSessionForHostedApp } from "./services/app-session-gate.js";
export { registerEscalationChannel } from "./services/escalation.js";
export { buildTriggerConfig, buildTriggerMetadata, computeNextCronRunAtMs, normalizeTriggerDraft, parseCronExpression } from "./triggers/scheduling.js";
export { getTriggerLimit, listTriggerTasks, readTriggerConfig, taskToTriggerSummary, triggersFeatureEnabled, TRIGGER_TASK_NAME, TRIGGER_TASK_TAGS } from "./triggers/runtime.js";
`,
  },
};

function packageNodeModulesEntryPath(
  nodeModulesDir: string,
  packageName: string,
): string {
  return path.join(nodeModulesDir, ...packageName.split("/"));
}

async function pathEntryExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function readPluginPackageManifest(
  packageRoot: string,
): Promise<PluginPackageManifest | null> {
  try {
    return JSON.parse(
      await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as PluginPackageManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function collectDeclaredPluginDependencies(
  manifest: PluginPackageManifest,
): DeclaredPluginDependency[] {
  const collected = new Map<string, DeclaredPluginDependency>();

  for (const name of Object.keys(manifest.dependencies ?? {})) {
    collected.set(name, { name, optional: false });
  }

  for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
    if (!collected.has(name)) {
      collected.set(name, { name, optional: true });
    }
  }

  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    if (collected.has(name)) {
      continue;
    }

    const optional = manifest.peerDependenciesMeta?.[name]?.optional === true;
    collected.set(name, { name, optional });
  }

  return [...collected.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

async function stageDependencyIntoNodeModules(params: {
  dependencyName: string;
  sourceNodeModulesDir: string;
  targetNodeModulesDir: string;
}): Promise<boolean> {
  const sourcePath = packageNodeModulesEntryPath(
    params.sourceNodeModulesDir,
    params.dependencyName,
  );
  if (!(await pathEntryExists(sourcePath))) {
    return false;
  }

  const targetPath = packageNodeModulesEntryPath(
    params.targetNodeModulesDir,
    params.dependencyName,
  );
  if (await pathEntryExists(targetPath)) {
    return true;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const stat = await fs.lstat(sourcePath);
  if (stat.isSymbolicLink()) {
    const linkTarget = await resolveSymlinkTargetIfPresent(sourcePath);
    if (!linkTarget) {
      return false;
    }
    await fs.symlink(linkTarget, targetPath);
    return true;
  }
  if (!stat.isDirectory()) {
    return false;
  }

  await fs.cp(sourcePath, targetPath, {
    recursive: true,
    force: true,
    dereference: true,
  });
  return true;
}

function rewriteDistExportTargetToSource(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/^\.(\/dist\/)/, "./src/").replace(/\.js$/, ".ts");
  }

  if (Array.isArray(value)) {
    return value.map(rewriteDistExportTargetToSource);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      rewriteDistExportTargetToSource(entry),
    ]),
  );
}

async function writeSourceStagedPackageManifest(params: {
  dependencyName: string;
  sourcePackageRoot: string;
  targetPackageRoot: string;
}): Promise<void> {
  const sourcePackageJsonPath = path.join(
    params.sourcePackageRoot,
    "package.json",
  );
  const targetPackageJsonPath = path.join(
    params.targetPackageRoot,
    "package.json",
  );
  const manifest = JSON.parse(
    await fs.readFile(sourcePackageJsonPath, "utf8"),
  ) as Record<string, unknown>;

  const rootEntrypoint = SOURCE_STAGED_ROOT_ENTRYPOINTS[params.dependencyName];
  const rootExport = rootEntrypoint
    ? {
        types: rootEntrypoint.path,
        import: rootEntrypoint.path,
        default: rootEntrypoint.path,
      }
    : undefined;
  const rewrittenExports = rewriteDistExportTargetToSource(manifest.exports);
  const rewrittenManifest = {
    ...manifest,
    main: rootEntrypoint?.path ?? "./src/index.ts",
    module: rootEntrypoint?.path ?? "./src/index.ts",
    types: rootEntrypoint?.path ?? "./src/index.ts",
    exports:
      rootExport && rewrittenExports && typeof rewrittenExports === "object"
        ? { ...(rewrittenExports as Record<string, unknown>), ".": rootExport }
        : (rewrittenExports ?? rootEntrypoint?.path),
  };

  await fs.writeFile(
    targetPackageJsonPath,
    `${JSON.stringify(rewrittenManifest, null, 2)}\n`,
  );
}

async function writeSourceStagedRootEntrypoint(params: {
  dependencyName: string;
  targetPackageRoot: string;
}): Promise<void> {
  const rootEntrypoint = SOURCE_STAGED_ROOT_ENTRYPOINTS[params.dependencyName];
  if (!rootEntrypoint) {
    return;
  }

  const relativeEntrypointPath = rootEntrypoint.path.replace(/^\.\//, "");
  const targetPath = path.join(
    params.targetPackageRoot,
    relativeEntrypointPath,
  );
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, rootEntrypoint.source);
}

async function stageWorkspaceSourceDependencyIntoNodeModules(params: {
  dependencyName: string;
  sourceNodeModulesDir: string;
  targetNodeModulesDir: string;
}): Promise<boolean> {
  const sourcePath = packageNodeModulesEntryPath(
    params.sourceNodeModulesDir,
    params.dependencyName,
  );
  if (!(await pathEntryExists(sourcePath))) {
    return false;
  }

  const resolvedSourcePath =
    (await resolveSymlinkTargetIfPresent(sourcePath)) ?? sourcePath;
  const sourceSrcPath = path.join(resolvedSourcePath, "src");
  const sourcePackageJsonPath = path.join(resolvedSourcePath, "package.json");
  if (
    !(await pathEntryExists(sourceSrcPath)) ||
    !(await pathEntryExists(sourcePackageJsonPath))
  ) {
    return false;
  }

  const targetPath = packageNodeModulesEntryPath(
    params.targetNodeModulesDir,
    params.dependencyName,
  );
  if (await pathEntryExists(targetPath)) {
    return true;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.cp(resolvedSourcePath, targetPath, {
    recursive: true,
    force: true,
    dereference: true,
    filter: (src) => {
      const relativePath = path.relative(resolvedSourcePath, src);
      if (!relativePath) return true;
      const [topLevel] = relativePath.split(path.sep);
      return (
        topLevel === "src" ||
        relativePath === "package.json" ||
        relativePath === "vite-env.d.ts"
      );
    },
  });
  await writeSourceStagedPackageManifest({
    dependencyName: params.dependencyName,
    sourcePackageRoot: resolvedSourcePath,
    targetPackageRoot: targetPath,
  });
  await writeSourceStagedRootEntrypoint({
    dependencyName: params.dependencyName,
    targetPackageRoot: targetPath,
  });
  return true;
}

async function ensureStagedPackageDependencies(params: {
  installRoot: string;
  packageName: string;
  packageRoot: string;
  stagedPackageRoot: string;
}): Promise<void> {
  const stagedNodeModulesPath = path.join(
    params.stagedPackageRoot,
    "node_modules",
  );
  await fs.mkdir(stagedNodeModulesPath, { recursive: true });

  const manifest = await readPluginPackageManifest(params.packageRoot);
  if (!manifest) {
    return;
  }

  const dependencies = collectDeclaredPluginDependencies(manifest);
  if (dependencies.length === 0) {
    return;
  }

  const sourceNodeModulesDirs = uniquePaths([
    path.join(params.packageRoot, "node_modules"),
    path.join(params.installRoot, "node_modules"),
    ...(await findAncestorNodeModulesDirs(params.packageRoot)),
  ]);

  for (const dependency of dependencies) {
    const stagedDependencyPath = packageNodeModulesEntryPath(
      stagedNodeModulesPath,
      dependency.name,
    );
    const shouldStageFromSource = SOURCE_STAGED_WORKSPACE_DEPENDENCIES.has(
      dependency.name,
    );
    if (await pathEntryExists(stagedDependencyPath)) {
      if (!shouldStageFromSource) {
        continue;
      }
      await fs.rm(stagedDependencyPath, { recursive: true, force: true });
    }

    let staged = false;
    for (const sourceNodeModulesDir of sourceNodeModulesDirs) {
      staged = shouldStageFromSource
        ? await stageWorkspaceSourceDependencyIntoNodeModules({
            dependencyName: dependency.name,
            sourceNodeModulesDir,
            targetNodeModulesDir: stagedNodeModulesPath,
          })
        : await stageDependencyIntoNodeModules({
            dependencyName: dependency.name,
            sourceNodeModulesDir,
            targetNodeModulesDir: stagedNodeModulesPath,
          });
      if (staged) {
        break;
      }
    }

    if (!staged && !dependency.optional) {
      logger.warn(
        `[eliza] Staged plugin ${params.packageName} is missing declared dependency ${dependency.name}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Workspace plugin overrides
// ---------------------------------------------------------------------------

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const candidate of paths) {
    const resolved = path.resolve(candidate);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      ordered.push(resolved);
    }
  }
  return ordered;
}

function resolveWorkspaceRoots(): string[] {
  const envRoot = process.env.ELIZA_WORKSPACE_ROOT?.trim();
  if (envRoot) {
    return uniquePaths([envRoot]);
  }

  // Phase 3: only search cwd — parent-directory and module-relative fallbacks
  // removed. Repo-local ./eliza submodule + setup:upstreams symlinks handle
  // plugin resolution for development. Set ELIZA_WORKSPACE_ROOT explicitly
  // for external override scenarios.
  return uniquePaths([process.cwd()]);
}

function legacyAppsWorkspaceDiscoveryEnabled(): boolean {
  const raw = process.env.ELIZA_ENABLE_LEGACY_APPS_WORKSPACE_DISCOVERY;
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function getWorkspacePluginOverridePath(pluginName: string): string | null {
  if (process.env.ELIZA_DISABLE_WORKSPACE_PLUGIN_OVERRIDES === "1") {
    return null;
  }

  const packageSegmentMatch = pluginName.match(
    /^@[^/]+\/((?:app|plugin)-[^/]+)$/,
  );
  const packageSegment = packageSegmentMatch?.[1];
  if (!packageSegment) return null;

  for (const workspaceRoot of resolveWorkspaceRoots()) {
    const candidates = [
      path.join(workspaceRoot, "plugins", packageSegment, "typescript"),
      path.join(workspaceRoot, "plugins", packageSegment),
      path.join(workspaceRoot, "packages", packageSegment),
      path.join(
        workspaceRoot,
        "eliza",
        "plugins",
        packageSegment,
        "typescript",
      ),
      path.join(workspaceRoot, "eliza", "plugins", packageSegment),
      path.join(workspaceRoot, "eliza", "packages", packageSegment),
    ];

    if (legacyAppsWorkspaceDiscoveryEnabled()) {
      // Temporary opt-in for older external workspaces that have not moved
      // app plugins from apps/app-* to plugins/app-* yet. The Eliza repo no
      // longer depends on or scans top-level apps/* by default.
      candidates.push(
        path.join(workspaceRoot, "apps", packageSegment),
        path.join(workspaceRoot, "eliza", "apps", packageSegment),
      );
    }

    for (const candidate of uniquePaths(candidates)) {
      if (existsSync(path.join(candidate, "package.json"))) {
        return candidate;
      }
    }
  }

  return null;
}

function runtimePluginExportSubpath(pluginName: string): string {
  return RUNTIME_APP_PLUGIN_SUBPATHS.has(pluginName) ? "./plugin" : ".";
}

function runtimePluginImportSpecifier(pluginName: string): string {
  return RUNTIME_APP_PLUGIN_SUBPATHS.has(pluginName)
    ? `${pluginName}/plugin`
    : pluginName;
}

async function hasNonSymlinkWorkspaceNodeModulesPackage(
  pluginName: string,
): Promise<boolean> {
  for (const workspaceRoot of uniquePaths([
    process.cwd(),
    ...resolveWorkspaceRoots(),
  ])) {
    const candidate = path.join(
      workspaceRoot,
      "node_modules",
      ...pluginName.split("/"),
    );
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Plugin error boundary wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a plugin's `init` and `providers` with error boundaries so that a
 * crash in any single plugin does not take down the entire agent or GUI.
 *
 * NOTE: Actions are NOT wrapped here because elizaOS's action dispatch
 * already has its own error boundary.  Only `init` (startup) and
 * `providers` (called every turn) need protection at this layer.
 *
 * The wrapper catches errors, logs them with the plugin name for easy
 * debugging, and continues execution.
 */
function wrapPluginWithErrorBoundary(
  pluginName: string,
  plugin: Plugin,
  _options?: { isCore?: boolean },
): Plugin {
  const wrapped: Plugin = { ...plugin };

  // Wrap init if present
  if (plugin.init) {
    const originalInit = plugin.init;
    wrapped.init = async (...args: Parameters<typeof originalInit>) => {
      try {
        return await originalInit(...args);
      } catch (err) {
        logger.error(
          `[eliza] Plugin "${pluginName}" crashed during init: ${formatError(err)}`,
        );
        throw err;
      }
    };
  }

  // Wrap providers with error boundaries
  if (plugin.providers && plugin.providers.length > 0) {
    wrapped.providers = plugin.providers.map((provider) => ({
      ...provider,
      get: async (...args: Parameters<typeof provider.get>) => {
        try {
          return await provider.get(...args);
        } catch (err) {
          const msg = formatError(err);
          logger.error(
            `[eliza] Provider "${provider.name}" (plugin: ${pluginName}) crashed: ${msg}`,
          );
          throw err;
        }
      },
    }));
  }

  return wrapped;
}

// ---------------------------------------------------------------------------
// Import helpers
// ---------------------------------------------------------------------------

/**
 * Import a plugin module from its install directory on disk.
 *
 * Handles two install layouts:
 *   1. npm layout:  <installPath>/node_modules/@scope/package/  (from `bun add`)
 *   2. git layout:  <installPath>/ is the package root directly  (from `git clone`)
 *
 * @param installPath  Root directory of the installation (e.g. ~/.eliza/plugins/installed/foo/).
 * @param packageName  The npm package name (e.g. "@elizaos/plugin-discord") — used
 *                     to navigate directly into node_modules when present.
 */
export async function importPluginModuleFromPath(
  installPath: string,
  packageName: string,
  exportSubpath = ".",
): Promise<PluginModuleShape> {
  const absPath = path.resolve(installPath);

  // npm/bun layout:  installPath/node_modules/@scope/name/
  // git layout:      installPath/ is the package itself
  const nmCandidate = path.join(
    absPath,
    "node_modules",
    ...packageName.split("/"),
  );
  let pkgRoot = absPath;
  try {
    if ((await fs.stat(nmCandidate)).isDirectory()) pkgRoot = nmCandidate;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    /* git layout — pkgRoot stays as absPath */
  }

  const packageRelativePath =
    pkgRoot === absPath ? [] : ["node_modules", ...packageName.split("/")];
  const stagedPkgRoot = await stagePluginImportRoot({
    installRoot: absPath,
    packageRoot: pkgRoot,
    packageRelativePath,
    packageName,
  });

  // Resolve entry point from a staged filesystem snapshot so reloads pick up
  // updated relative modules and bundled dependencies instead of reusing the
  // previous ESM module graph from the original path.
  const entryPoint = await resolvePackageEntry(stagedPkgRoot, exportSubpath);
  return (await import(pathToFileURL(entryPoint).href)) as PluginModuleShape;
}

async function findNearestNodeModulesDir(
  startDir: string,
): Promise<string | null> {
  let currentDir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(currentDir, "node_modules");
    try {
      if ((await fs.stat(candidate)).isDirectory()) {
        return candidate;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

function setLastFailedPluginNames(pluginNames: readonly string[]): void {
  (globalThis as GlobalWithLastFailedPluginNames)[LAST_FAILED_PLUGIN_NAMES] = [
    ...pluginNames,
  ];
}

export function getLastFailedPluginNames(): string[] {
  return [
    ...((globalThis as GlobalWithLastFailedPluginNames)[
      LAST_FAILED_PLUGIN_NAMES
    ] ?? []),
  ];
}

async function findAncestorNodeModulesDirs(
  startDir: string,
): Promise<string[]> {
  const dirs: string[] = [];
  let currentDir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(currentDir, "node_modules");
    try {
      if ((await fs.stat(candidate)).isDirectory()) {
        dirs.push(candidate);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return dirs;
    }
    currentDir = parentDir;
  }
}

async function linkAncestorNodeModulesIfNeeded(params: {
  installRoot: string;
  packageRoot: string;
  stagedPackageRoot: string;
}): Promise<void> {
  const stagedNodeModulesPath = path.join(
    params.stagedPackageRoot,
    "node_modules",
  );
  if (existsSync(stagedNodeModulesPath)) {
    return;
  }

  const ancestorNodeModules = await findNearestNodeModulesDir(
    params.packageRoot,
  );
  if (!ancestorNodeModules) {
    return;
  }

  const normalizedInstallRoot = path.resolve(params.installRoot);
  const normalizedAncestorNodeModules = path.resolve(ancestorNodeModules);
  if (
    normalizedAncestorNodeModules ===
      path.join(normalizedInstallRoot, "node_modules") ||
    normalizedAncestorNodeModules.startsWith(
      `${normalizedInstallRoot}${path.sep}`,
    )
  ) {
    return;
  }

  await fs.mkdir(stagedNodeModulesPath, { recursive: true });
  await linkMissingPackagesFromNodeModules({
    sourceNodeModulesDir: ancestorNodeModules,
    targetNodeModulesDir: stagedNodeModulesPath,
  });
}

async function linkMissingPackagesFromNodeModules(params: {
  sourceNodeModulesDir: string;
  targetNodeModulesDir: string;
}): Promise<void> {
  const entries = await fs.readdir(params.sourceNodeModulesDir, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    if (entry.name === ".bin" || entry.name.startsWith(".")) {
      continue;
    }

    const sourcePath = path.join(params.sourceNodeModulesDir, entry.name);
    const targetPath = path.join(params.targetNodeModulesDir, entry.name);

    if (entry.isDirectory() && entry.name.startsWith("@")) {
      await fs.mkdir(targetPath, { recursive: true });
      const scopedEntries = await fs.readdir(sourcePath, {
        withFileTypes: true,
      });
      for (const scopedEntry of scopedEntries) {
        if (scopedEntry.name.startsWith(".")) {
          continue;
        }
        const scopedSourcePath = path.join(sourcePath, scopedEntry.name);
        const scopedTargetPath = path.join(targetPath, scopedEntry.name);
        if (existsSync(scopedTargetPath)) {
          continue;
        }
        if (!scopedEntry.isDirectory() && !scopedEntry.isSymbolicLink()) {
          continue;
        }
        const linkTarget = scopedEntry.isSymbolicLink()
          ? await resolveSymlinkTargetIfPresent(scopedSourcePath)
          : scopedSourcePath;
        if (!linkTarget) {
          continue;
        }
        try {
          await fs.symlink(linkTarget, scopedTargetPath, "dir");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
          }
        }
      }
      continue;
    }

    if (
      (!entry.isDirectory() && !entry.isSymbolicLink()) ||
      existsSync(targetPath)
    ) {
      continue;
    }

    const linkTarget = entry.isSymbolicLink()
      ? await resolveSymlinkTargetIfPresent(sourcePath)
      : sourcePath;
    if (!linkTarget) {
      continue;
    }
    try {
      await fs.symlink(linkTarget, targetPath, "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
}

async function resolveSymlinkTargetIfPresent(
  sourcePath: string,
): Promise<string | null> {
  try {
    return await fs.realpath(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function stageNodeModulesEntries(params: {
  sourceNodeModulesDir: string;
  targetNodeModulesDir: string;
}): Promise<void> {
  const entries = await fs.readdir(params.sourceNodeModulesDir, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    if (entry.name === ".bin" || entry.name.startsWith(".")) {
      continue;
    }

    const sourcePath = path.join(params.sourceNodeModulesDir, entry.name);
    const targetPath = path.join(params.targetNodeModulesDir, entry.name);

    if (entry.isDirectory() && entry.name.startsWith("@")) {
      await fs.mkdir(targetPath, { recursive: true });
      const scopedEntries = await fs.readdir(sourcePath, {
        withFileTypes: true,
      });
      for (const scopedEntry of scopedEntries) {
        if (scopedEntry.name.startsWith(".")) {
          continue;
        }
        const scopedSourcePath = path.join(sourcePath, scopedEntry.name);
        const scopedTargetPath = path.join(targetPath, scopedEntry.name);
        if (existsSync(scopedTargetPath)) {
          continue;
        }
        if (scopedEntry.isSymbolicLink()) {
          const linkTarget =
            await resolveSymlinkTargetIfPresent(scopedSourcePath);
          if (!linkTarget) continue;
          await fs.symlink(linkTarget, scopedTargetPath);
          continue;
        }
        if (!scopedEntry.isDirectory()) {
          continue;
        }
        await fs.cp(scopedSourcePath, scopedTargetPath, {
          recursive: true,
          force: true,
          dereference: true,
        });
      }
      continue;
    }

    if (existsSync(targetPath)) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      const linkTarget = await resolveSymlinkTargetIfPresent(sourcePath);
      if (!linkTarget) continue;
      await fs.symlink(linkTarget, targetPath);
      continue;
    }
    if (!entry.isDirectory()) {
      continue;
    }
    await fs.cp(sourcePath, targetPath, {
      recursive: true,
      force: true,
      dereference: true,
    });
  }
}

function stageAllHoistedNodeModulesEnabled(): boolean {
  const raw = process.env.ELIZA_STAGE_ALL_HOISTED_NODE_MODULES;
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function stageFullPluginPackageEnabled(): boolean {
  const raw = process.env.ELIZA_STAGE_FULL_PLUGIN_PACKAGE;
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function createPluginPackageStageFilter(packageRoot: string) {
  const distPath = path.join(packageRoot, "dist");
  const stageBuiltPackageOnly =
    existsSync(distPath) && !stageFullPluginPackageEnabled();

  return (src: string): boolean => {
    const relativePath = path.relative(packageRoot, src);
    if (!relativePath) return true;

    const [topLevel] = relativePath.split(path.sep);
    if (topLevel === "node_modules") return false;

    if (stageBuiltPackageOnly) {
      return topLevel === "dist" || relativePath === "package.json";
    }

    return ![
      ".turbo",
      "coverage",
      "docs",
      "node_modules",
      "public_src",
      "test",
      "__tests__",
    ].includes(topLevel);
  };
}

async function linkHoistedNodeModulesPackages(params: {
  installRoot: string;
  packageRoot: string;
  stagedPackageRoot: string;
}): Promise<void> {
  const stagedNodeModulesPath = path.join(
    params.stagedPackageRoot,
    "node_modules",
  );

  if (!existsSync(stagedNodeModulesPath)) {
    return;
  }

  const stagedNodeModulesStat = await fs.lstat(stagedNodeModulesPath);
  if (stagedNodeModulesStat.isSymbolicLink()) {
    return;
  }

  const normalizedInstallRoot = path.resolve(params.installRoot);
  const internalNodeModulesRoot = path.join(
    normalizedInstallRoot,
    "node_modules",
  );
  const ancestorNodeModulesDirs = await findAncestorNodeModulesDirs(
    path.dirname(params.packageRoot),
  );

  for (const ancestorNodeModules of ancestorNodeModulesDirs) {
    const normalizedAncestorNodeModules = path.resolve(ancestorNodeModules);
    if (
      normalizedAncestorNodeModules === internalNodeModulesRoot ||
      normalizedAncestorNodeModules.startsWith(
        `${normalizedInstallRoot}${path.sep}`,
      )
    ) {
      continue;
    }

    await linkMissingPackagesFromNodeModules({
      sourceNodeModulesDir: ancestorNodeModules,
      targetNodeModulesDir: stagedNodeModulesPath,
    });
  }
}

async function stagePluginImportRoot(params: {
  installRoot: string;
  packageRoot: string;
  packageRelativePath: string[];
  packageName: string;
}): Promise<string> {
  const stagingBaseDir = path.join(
    resolveStateDir(),
    "plugins",
    ".runtime-imports",
    sanitizePluginCacheSegment(params.packageName),
  );
  await fs.mkdir(stagingBaseDir, { recursive: true });

  const stagingDir = await fs.mkdtemp(
    path.join(stagingBaseDir, `${Date.now()}-${crypto.randomUUID()}-`),
  );
  const stagedInstallRoot = path.join(stagingDir, "root");
  const stagedPackageRoot =
    params.packageRelativePath.length > 0
      ? path.join(stagedInstallRoot, ...params.packageRelativePath)
      : stagedInstallRoot;
  await fs.mkdir(path.dirname(stagedPackageRoot), { recursive: true });
  await fs.cp(params.packageRoot, stagedPackageRoot, {
    recursive: true,
    force: true,
    dereference: true,
    filter: createPluginPackageStageFilter(params.packageRoot),
  });

  const installNodeModulesPath = path.join(params.installRoot, "node_modules");
  try {
    if ((await fs.stat(installNodeModulesPath)).isDirectory()) {
      const stagedInstallNodeModulesPath = path.join(
        stagedInstallRoot,
        "node_modules",
      );
      await fs.mkdir(stagedInstallNodeModulesPath, { recursive: true });
      await stageNodeModulesEntries({
        sourceNodeModulesDir: installNodeModulesPath,
        targetNodeModulesDir: stagedInstallNodeModulesPath,
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  if (params.packageRoot !== params.installRoot) {
    const packageNodeModulesPath = path.join(
      params.packageRoot,
      "node_modules",
    );
    try {
      if ((await fs.stat(packageNodeModulesPath)).isDirectory()) {
        const stagedPackageNodeModulesPath = path.join(
          stagedPackageRoot,
          "node_modules",
        );
        await fs.mkdir(stagedPackageNodeModulesPath, { recursive: true });
        await stageNodeModulesEntries({
          sourceNodeModulesDir: packageNodeModulesPath,
          targetNodeModulesDir: stagedPackageNodeModulesPath,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  await ensureStagedPackageDependencies({
    installRoot: params.installRoot,
    packageName: params.packageName,
    packageRoot: params.packageRoot,
    stagedPackageRoot,
  });
  if (stageAllHoistedNodeModulesEnabled()) {
    await linkAncestorNodeModulesIfNeeded({
      installRoot: params.installRoot,
      packageRoot: params.packageRoot,
      stagedPackageRoot,
    });
    await linkHoistedNodeModulesPackages({
      installRoot: params.installRoot,
      packageRoot: params.packageRoot,
      stagedPackageRoot,
    });
  }

  return stagedPackageRoot;
}

/**
 * Resolve a statically-imported @elizaos plugin by name.
 * Returns the module if found in STATIC_ELIZA_PLUGINS, otherwise null.
 */
function resolveStaticElizaPlugin(pluginName: string): unknown | null {
  return STATIC_ELIZA_PLUGINS[pluginName] ?? null;
}

/**
 * Walk the @elizaos scope in node_modules + workspace `plugins/` dirs and
 * return every package that has a `package.json`. The manifest evaluator
 * filters these down to the ones that actually declare an `elizaos.plugin`
 * block — this discovery step is intentionally cheap (a single readdir + stat
 * per candidate, no module imports).
 */
async function discoverPluginCandidates(): Promise<PluginManifestCandidate[]> {
  const seen = new Set<string>();
  const candidates: PluginManifestCandidate[] = [];

  const tryAdd = async (pkgRoot: string, pkgName: string): Promise<void> => {
    if (seen.has(pkgName)) return;
    if (!(await pathEntryExists(path.join(pkgRoot, "package.json")))) return;
    seen.add(pkgName);
    candidates.push({ packageName: pkgName, packageRoot: pkgRoot });
  };

  // 1. node_modules/@elizaos/* — covers npm-installed plugins and dev symlinks
  //    pointing at workspace packages.
  for (const root of resolveWorkspaceRoots()) {
    const elizaScope = path.join(root, "node_modules", "@elizaos");
    let entries: import("node:fs").Dirent[];
    try {
      entries = (await fs.readdir(elizaScope, {
        withFileTypes: true,
      })) as import("node:fs").Dirent[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".")) continue;
      // Only plugin/app packages — skip core, shared, agent, ui, etc. (those
      // aren't auto-enable participants and reading their package.json is
      // wasted work).
      if (!entry.name.startsWith("plugin-") && !entry.name.startsWith("app-")) {
        continue;
      }
      const pkgRoot = path.join(elizaScope, entry.name);
      await tryAdd(pkgRoot, `@elizaos/${entry.name}`);
    }
  }

  // 2. workspace `plugins/` dir — covers cases where the plugin is in the
  //    repo but not yet symlinked into node_modules. Cheap fall-through.
  for (const root of resolveWorkspaceRoots()) {
    const pluginsDir = path.join(root, "plugins");
    let entries: import("node:fs").Dirent[];
    try {
      entries = (await fs.readdir(pluginsDir, {
        withFileTypes: true,
      })) as import("node:fs").Dirent[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith("plugin-") && !entry.name.startsWith("app-")) {
        continue;
      }
      // Some workspace plugins keep their package at `<name>/typescript`; try
      // the typescript subdir first, fall back to the dir itself.
      const tsRoot = path.join(pluginsDir, entry.name, "typescript");
      const tsManifest = path.join(tsRoot, "package.json");
      if (await pathEntryExists(tsManifest)) {
        try {
          const raw = await fs.readFile(tsManifest, "utf8");
          const parsed = JSON.parse(raw) as { name?: string };
          if (parsed.name) await tryAdd(tsRoot, parsed.name);
        } catch {
          // ignore unreadable / malformed
        }
        continue;
      }
      const flatRoot = path.join(pluginsDir, entry.name);
      const flatManifest = path.join(flatRoot, "package.json");
      if (await pathEntryExists(flatManifest)) {
        try {
          const raw = await fs.readFile(flatManifest, "utf8");
          const parsed = JSON.parse(raw) as { name?: string };
          if (parsed.name) await tryAdd(flatRoot, parsed.name);
        } catch {
          // ignore
        }
      }
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Resolve Eliza plugins from config and auto-enable logic.
 * Returns an array of elizaOS Plugin instances ready for AgentRuntime.
 *
 * Handles three categories of plugins:
 * 1. Built-in/npm plugins — imported by package name
 * 2. User-installed plugins — from ~/.eliza/plugins/installed/
 * 3. Custom/drop-in plugins — from ~/.eliza/plugins/custom/ and plugins.load.paths
 *
 * Each plugin is loaded inside an error boundary so a single failing plugin
 * cannot crash the entire agent startup.
 */
export async function resolvePlugins(
  config: ElizaConfig,
  opts?: { quiet?: boolean },
): Promise<ResolvedPlugin[]> {
  const plugins: ResolvedPlugin[] = [];
  const failedPlugins: Array<{ name: string; error: string }> = [];
  const repairedInstallRecords = new Set<string>();

  // NOTE: Auto-enable runs before dependency validation intentionally.
  // It returns a new config object (structuredClone under the hood) with
  // `plugins.allow` populated based on env vars and connector configuration.
  // We have to USE the returned config for collectPluginNames — the previous
  // code discarded the return value and kept using the original `config`,
  // which meant every env-gated plugin (plugin-wallet, etc.) was
  // silently dropped. Capture the result and assign back so both the allow
  // list and any downstream config reads see the mutation.
  //
  // Auto-enable is sourced exclusively from per-plugin manifests: walk every
  // @elizaos/* package.json on disk and run each plugin's
  // autoEnableModule.shouldEnable(ctx). Each plugin owns its own enable
  // conditions in auto-enable.ts — no central map exists.
  //
  // App-level manifest (host app's package.json `elizaos.app` block) can:
  //   - restrict the candidate list to a curated subset
  //   - prepopulate config.plugins.entries with default { enabled } flags
  //     (user config still wins; defaults only fill keys the user hasn't set)
  const changes: string[] = [];
  try {
    const appManifest = await readAppManifest(process.cwd()).catch(
      () => null,
    );
    const defaultedEntries = applyAppManifestDefaults(config, appManifest);
    if (defaultedEntries.length > 0) {
      logger.info(
        `[eliza] App manifest defaults applied to entries: ${defaultedEntries.join(", ")}`,
      );
    }
    const allCandidates = await discoverPluginCandidates();
    const candidates = filterCandidatesByAppManifest(
      allCandidates,
      appManifest,
    );
    if (
      appManifest?.candidates &&
      candidates.length < allCandidates.length
    ) {
      logger.info(
        `[eliza] App manifest restricted candidate set: ${candidates.length}/${allCandidates.length} plugins considered`,
      );
    }
    const verdicts = await evaluatePluginManifests(candidates, {
      env: process.env,
      config,
      isNativePlatform: isMobilePlatform(),
    });
    applyPluginManifestVerdicts(config, verdicts, changes);
  } catch (err) {
    logger.warn(
      `[eliza] Plugin manifest auto-enable failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (changes.length > 0) {
    logger.info(`[eliza] Plugin auto-enable: ${changes.join("; ")}`);
  }

  // Provenance for "why is this package in the load set?" — surfaced when an
  // optional plugin fails to resolve so logs point at config/env, not "eliza broke".
  const loadReasons: PluginLoadReasons = new Map();
  const pluginsToLoad = collectPluginNames(config, loadReasons);
  const corePluginSet = new Set<string>(CORE_PLUGINS);

  // Build a mutable map of install records so we can merge drop-in discoveries
  const installRecords: Record<string, PluginInstallRecord> = {
    ...(config.plugins?.installs ?? {}),
  };

  const denyList = new Set<string>((config.plugins?.deny || []) as string[]);
  const envSkipPlugins = (process.env.ELIZA_SKIP_PLUGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const pluginName of envSkipPlugins) {
    denyList.add(pluginName);
  }
  if (envSkipPlugins.length > 0) {
    logger.info(
      `[eliza] Skipping ${envSkipPlugins.length} plugin(s) via ELIZA_SKIP_PLUGINS: ${envSkipPlugins.join(", ")}`,
    );
  }
  for (const pluginName of denyList) {
    pluginsToLoad.delete(pluginName);
    const canonical = resolvePluginPackageAlias(pluginName);
    if (canonical !== pluginName) {
      pluginsToLoad.delete(canonical);
    }
  }

  // ── Auto-discover ejected plugins ───────────────────────────────────────
  // Ejected plugins override npm/core versions, so they are tracked
  // separately and consulted first at import time.
  const ejectedRecords = await scanDropInPlugins(
    path.join(resolveStateDir(), EJECTED_PLUGINS_DIRNAME),
  );
  const ejectedPluginNames: string[] = [];
  for (const [name, _record] of Object.entries(ejectedRecords)) {
    if (denyList.has(name)) continue;
    pluginsToLoad.add(name);
    if (!loadReasons.has(name)) loadReasons.set(name, "ejected plugins dir");
    ejectedPluginNames.push(name);
  }
  if (ejectedPluginNames.length > 0) {
    logger.info(
      `[eliza] Discovered ${ejectedPluginNames.length} ejected plugin(s): ${ejectedPluginNames.join(", ")}`,
    );
  }

  // ── Auto-discover drop-in custom plugins ────────────────────────────────
  // Scan well-known dir + any extra dirs from plugins.load.paths (first wins).
  const scanDirs = [
    path.join(resolveStateDir(), CUSTOM_PLUGINS_DIRNAME),
    ...(config.plugins?.load?.paths ?? []).map(resolveUserPath),
  ];
  const dropInRecords: Record<string, PluginInstallRecord> = {};
  for (const dir of scanDirs) {
    for (const [name, record] of Object.entries(await scanDropInPlugins(dir))) {
      if (!dropInRecords[name]) dropInRecords[name] = record;
    }
  }

  // Merge into load set — deny list and core collisions are filtered out.
  const { accepted: customPluginNames, skipped } = mergeDropInPlugins({
    dropInRecords,
    installRecords,
    corePluginNames: corePluginSet,
    denyList,
    pluginsToLoad,
  });

  for (const msg of skipped) logger.warn(msg);
  if (customPluginNames.length > 0) {
    logger.info(
      `[eliza] Discovered ${customPluginNames.length} custom plugin(s): ${customPluginNames.join(", ")}`,
    );
  }

  logger.info(`[eliza] Resolving ${pluginsToLoad.size} plugins...`);
  const loadStartTime = Date.now();

  // Built once so we don't rebuild on every optional plugin failure.
  const optionalPluginNames = new Set([
    ...Object.values(OPTIONAL_PLUGIN_MAP),
    ...Object.values(CHANNEL_PLUGIN_MAP),
    ...OPTIONAL_CORE_PLUGINS,
  ]);

  // Load a single plugin - returns result or null on skip/failure
  async function loadSinglePlugin(pluginName: string): Promise<{
    name: string;
    plugin: Plugin;
  } | null> {
    const isCore = corePluginSet.has(pluginName);
    const isOfficialElizaPlugin = pluginName.startsWith("@elizaos/plugin-");
    const ejectedRecord = ejectedRecords[pluginName];
    const installRecord = installRecords[pluginName];
    const workspaceOverridePath = getWorkspacePluginOverridePath(pluginName);
    const staticElizaPlugin = await resolveStaticElizaPlugin(pluginName);
    const exportSubpath = runtimePluginExportSubpath(pluginName);

    const importOfficialPluginFromNodeModules =
      async (): Promise<PluginModuleShape> =>
        (await import(
          resolveElizaPluginImportSpecifier(pluginName)
        )) as PluginModuleShape;

    // Pre-flight: ensure native dependencies are available for special plugins.
    if (pluginName === "@elizaos/plugin-browser") {
      if (!ensureBrowserServerLink()) {
        failedPlugins.push({
          name: pluginName,
          error: "browser server binary not found",
        });
        // ensureBrowserServerLink() already logged one debug line with setup hints.
        return null;
      }
    }

    try {
      let mod: PluginModuleShape;

      if (ejectedRecord?.installPath) {
        // Ejected plugin — always prefer local source over npm/core.
        logger.debug(
          `[eliza] Loading ejected plugin: ${pluginName} from ${ejectedRecord.installPath}`,
        );
        mod = await importPluginModuleFromPath(
          ejectedRecord.installPath,
          pluginName,
          exportSubpath,
        );
      } else if (staticElizaPlugin) {
        // Prefer statically imported official plugins over workspace staging.
        // This keeps local node_modules links working while avoiding staging
        // bugs in workspace packages with nested symlinked dependencies.
        mod = staticElizaPlugin as PluginModuleShape;
      } else if (pluginName === "@elizaos/plugin-sql") {
        // Mobile bundles run without a node_modules tree. The static plugin
        // registry is the normal fast path, but use a literal import fallback
        // so Bun can still inline the required SQL plugin if module init order
        // leaves the registry empty.
        mod = (await import("@elizaos/plugin-sql")) as PluginModuleShape;
      } else if (workspaceOverridePath) {
        const shouldPreferRepoNodeModules =
          isOfficialElizaPlugin &&
          (await hasNonSymlinkWorkspaceNodeModulesPackage(pluginName));
        if (shouldPreferRepoNodeModules) {
          logger.debug(
            `[eliza] Loading repo node_modules plugin: ${pluginName}`,
          );
          try {
            mod = await importOfficialPluginFromNodeModules();
          } catch (error) {
            logger.warn(
              `[eliza] Repo node_modules plugin import failed for ${pluginName}; falling back to workspace override: ${formatError(error)}`,
            );
            mod = await importPluginModuleFromPath(
              workspaceOverridePath,
              pluginName,
              exportSubpath,
            );
          }
        } else {
          logger.debug(
            `[eliza] Loading workspace plugin override: ${pluginName} from ${workspaceOverridePath}`,
          );
          // Always stage workspace overrides instead of re-importing the bare
          // package specifier from node_modules. Bun can wedge a subsequent
          // restart when an earlier bare import of the same specifier failed
          // during module evaluation. Staging also guarantees local edits reload.
          mod = await importPluginModuleFromPath(
            workspaceOverridePath,
            pluginName,
            exportSubpath,
          );
        }
      } else if (installRecord?.installPath) {
        // Prefer bundled/node_modules copies for official Eliza plugins.
        if (isOfficialElizaPlugin) {
          try {
            mod = await importOfficialPluginFromNodeModules();
            if (repairBrokenInstallRecord(config, pluginName)) {
              repairedInstallRecords.add(pluginName);
            }
          } catch (npmErr) {
            logger.warn(
              `[eliza] Node_modules resolution failed for ${pluginName} (${formatError(npmErr)}). Trying installed path at ${redactUserSegments(installRecord.installPath)}.`,
            );
            mod = await importPluginModuleFromPath(
              installRecord.installPath,
              pluginName,
              exportSubpath,
            );
          }
        } else {
          // User-installed plugin — load from its install directory on disk.
          try {
            mod = await importPluginModuleFromPath(
              installRecord.installPath,
              pluginName,
              exportSubpath,
            );
          } catch (installErr) {
            logger.warn(
              `[eliza] Installed plugin ${pluginName} failed at ${redactUserSegments(installRecord.installPath)} (${formatError(installErr)}). Falling back to node_modules resolution.`,
            );
            const staticMod = await resolveStaticElizaPlugin(pluginName);
            mod = staticMod
              ? (staticMod as PluginModuleShape)
              : ((await import(
                  runtimePluginImportSpecifier(pluginName)
                )) as PluginModuleShape);
            if (repairBrokenInstallRecord(config, pluginName)) {
              repairedInstallRecords.add(pluginName);
            }
          }
        }
      } else if (isOfficialElizaPlugin) {
        // Eliza plugins can resolve either from bundled local wrappers
        // under eliza-dist/plugins/* or from packaged node_modules.
        mod = await importOfficialPluginFromNodeModules();
      } else {
        // Built-in/npm plugin — prefer a bundled static import regardless of
        // naming convention (short-name plugins like "agent-orchestrator" are
        // registered in STATIC_ELIZA_PLUGINS and would otherwise fail a bare
        // node_modules resolution).
        mod = staticElizaPlugin
          ? (staticElizaPlugin as PluginModuleShape)
          : ((await import(
              runtimePluginImportSpecifier(pluginName)
            )) as PluginModuleShape);
      }

      const pluginInstance = findRuntimePluginExport(mod);

      if (pluginInstance) {
        // Wrap the plugin's init function with an error boundary.
        // Core plugins re-throw on init failure; optional plugins degrade gracefully.
        const wrappedPlugin = wrapPluginWithErrorBoundary(
          pluginName,
          pluginInstance,
          { isCore },
        );
        logger.debug(`[eliza] ✓ Loaded plugin: ${pluginName}`);
        return { name: pluginName, plugin: wrappedPlugin };
      } else {
        const msg = `[eliza] Plugin ${pluginName} did not export a valid Plugin object`;
        failedPlugins.push({
          name: pluginName,
          error: "no valid Plugin export",
        });
        if (isCore) {
          logger.error(msg);
        } else {
          logger.warn(msg);
        }
        return null;
      }
    } catch (err) {
      const msg = formatError(err);

      failedPlugins.push({ name: pluginName, error: msg });
      if (isCore) {
        logger.error(
          `[eliza] Failed to load core plugin ${pluginName}: ${msg}`,
        );
      } else {
        if (optionalPluginNames.has(pluginName)) {
          if (!isBenignOptionalPluginFailure(msg)) {
            logger.warn(
              `[eliza] Optional plugin ${pluginName} failed to load: ${msg}`,
            );
          }
        } else {
          logger.info(`[eliza] Could not load plugin ${pluginName}: ${msg}`);
        }
      }
      return null;
    }
  }

  // Load all plugins in parallel for faster startup.
  // SECURITY NOTE: Plugins that modify process.env during import or init
  // may race with each other. This is an accepted trade-off for startup
  // performance. Critical env vars (database, AI provider keys) are set
  // before this point in buildCharacterFromConfig / resolveDbEnv.
  const serializePluginLoads = process.env.ELIZA_SERIALIZE_PLUGIN_LOADS === "1";
  logger.info(
    `[eliza] Loading ${pluginsToLoad.size} plugins${serializePluginLoads ? " sequentially" : ""}...`,
  );
  const pluginResults = serializePluginLoads
    ? await (async () => {
        const results: Array<Awaited<ReturnType<typeof loadSinglePlugin>>> = [];
        let index = 0;
        for (const pluginName of pluginsToLoad) {
          index += 1;
          logger.info(
            `[eliza] Loading plugin ${index}/${pluginsToLoad.size}: ${pluginName}`,
          );
          results.push(await loadSinglePlugin(pluginName));
        }
        return results;
      })()
    : await Promise.all(Array.from(pluginsToLoad).map(loadSinglePlugin));

  // Collect successful loads
  for (const result of pluginResults) {
    if (result) {
      plugins.push(result);
    }
  }

  const loadDuration = Date.now() - loadStartTime;
  logger.info(`[eliza] Plugin loading took ${loadDuration}ms`);

  // Summary logging — do not treat “optional + not installed” as top-level failures.
  const optionalFailed = failedPlugins.filter((f) =>
    optionalPluginNames.has(f.name),
  );
  const seriousFailed = failedPlugins.filter(
    (f) => !optionalPluginNames.has(f.name),
  );
  const benignOptionalFailed = optionalFailed.filter((f) =>
    isBenignOptionalPluginFailure(f.error),
  );
  const noisyOptionalFailed = optionalFailed.filter(
    (f) => !isBenignOptionalPluginFailure(f.error),
  );
  const detailFailures = [...seriousFailed, ...noisyOptionalFailed];

  let completeMsg = `[eliza] Plugin resolution complete: ${plugins.length}/${pluginsToLoad.size} loaded`;
  if (detailFailures.length > 0) {
    completeMsg += `, ${detailFailures.length} failed`;
  }
  if (benignOptionalFailed.length > 0) {
    completeMsg += ` (${benignOptionalFailed.length} optional unavailable)`;
  }
  logger.info(completeMsg);

  if (detailFailures.length > 0) {
    logger.info(
      `[eliza] Failed plugins: ${detailFailures.map((f) => `${f.name} (${f.error})`).join(", ")}`,
    );
  }
  if (benignOptionalFailed.length > 0) {
    const withReasons = benignOptionalFailed.map((f) => {
      const reason = loadReasons.get(f.name);
      return reason ? `${f.name} (added by: ${reason})` : f.name;
    });
    logger.info(
      `[eliza] Optional plugins not installed: ${withReasons.join(", ")}`,
    );
  }

  setLastFailedPluginNames(failedPlugins.map((plugin) => plugin.name));

  // Diagnose version-skew issues when AI providers failed to load (#10)
  const loadedNames = plugins.map((p) => p.name);
  const diagnostic = diagnoseNoAIProvider(loadedNames, failedPlugins);
  if (diagnostic) {
    if (opts?.quiet) {
      // In headless/GUI mode before onboarding, this is expected — the user
      // will configure a provider through the onboarding wizard and restart.
      logger.info(`[eliza] ${diagnostic}`);
    } else {
      logger.error(`[eliza] ${diagnostic}`);
    }
  }

  // Persist repaired install records so future startups do not keep trying
  // to import from stale install directories.
  if (repairedInstallRecords.size > 0) {
    try {
      saveElizaConfig(config);
      logger.info(
        `[eliza] Repaired ${repairedInstallRecords.size} plugin install record(s): ${Array.from(repairedInstallRecords).join(", ")}`,
      );
    } catch (err) {
      logger.warn(
        `[eliza] Failed to persist plugin install repairs: ${formatError(err)}`,
      );
    }
  }

  return plugins;
}
