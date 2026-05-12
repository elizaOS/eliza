/**
 * Shared types, constants, and utility functions for plugin resolution.
 *
 * Extracted from eliza.ts to break circular dependencies between
 * eliza.ts and plugin-resolver.ts.
 *
 * @module plugin-types
 */
import type { Dirent } from "node:fs";
import { existsSync, symlinkSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { logger, type Plugin } from "@elizaos/core";
import { formatError } from "@elizaos/shared";

import type { ElizaConfig } from "../config/config.ts";
import type { PluginInstallRecord } from "../config/types.eliza.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A successfully resolved plugin ready for AgentRuntime registration. */
export interface ResolvedPlugin {
  /** npm package name (e.g. "@elizaos/plugin-anthropic"). */
  name: string;
  /** The Plugin instance extracted from the module. */
  plugin: Plugin;
}

/** Shape we expect from a dynamically-imported plugin package. */
export interface PluginModuleShape {
  default?: Plugin;
  plugin?: Plugin;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Static plugin registry.
 *
 * Populated by eliza.ts at module-load time with all statically-imported
 * plugin modules. Defined here (as a mutable record) so that
 * plugin-resolver.ts can read it without importing eliza.ts, breaking the
 * circular dependency.
 */
export const STATIC_ELIZA_PLUGINS: Record<string, unknown> = {};

/** Subdirectory under the Eliza state dir for drop-in custom plugins. */
export const CUSTOM_PLUGINS_DIRNAME = "plugins/custom";
/** Subdirectory under the Eliza state dir for ejected plugins. */
export const EJECTED_PLUGINS_DIRNAME = "plugins/ejected";

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function looksLikePlugin(value: unknown): value is Plugin {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.name !== "string" || typeof obj.description !== "string") {
    return false;
  }

  // Providers also expose { name, description } so we require at least one
  // plugin-like capability field before accepting named exports as plugins.
  return (
    Array.isArray(obj.services) ||
    Array.isArray(obj.providers) ||
    Array.isArray(obj.actions) ||
    Array.isArray(obj.routes) ||
    Array.isArray(obj.events) ||
    typeof obj.init === "function"
  );
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

export function findRuntimePluginExport(mod: PluginModuleShape): Plugin | null {
  // 1. Prefer explicit default export
  if (looksLikePlugin(mod.default)) return mod.default;
  // 2. Check for a named `plugin` export
  if (looksLikePlugin(mod.plugin)) return mod.plugin;

  // 3. Scan named exports in a deterministic order.
  // Prefer keys ending with "Plugin" before generic exports like providers.
  const namedKeys = Object.keys(mod).filter(
    (key) => key !== "default" && key !== "plugin",
  );
  const preferredKeys = namedKeys.filter(
    (key) => /plugin$/i.test(key) || /^plugin/i.test(key),
  );
  const fallbackKeys = namedKeys.filter((key) => !preferredKeys.includes(key));

  for (const key of [...preferredKeys, ...fallbackKeys]) {
    const value = mod[key];
    if (looksLikePlugin(value)) return value;
  }

  return null;
}

/**
 * Scan a directory for drop-in plugin packages. Each immediate subdirectory
 * is treated as a plugin; name comes from package.json or the directory name.
 */
export async function scanDropInPlugins(
  dir: string,
): Promise<Record<string, PluginInstallRecord>> {
  const records: Record<string, PluginInstallRecord> = {};

  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return records;
    }
    throw err;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const pluginDir = path.join(dir, entry.name);
    let pluginName = entry.name;
    let version = "0.0.0";

    try {
      const raw = await fs.readFile(
        path.join(pluginDir, "package.json"),
        "utf-8",
      );
      const pkg = JSON.parse(raw) as { name?: string; version?: string };
      if (typeof pkg.name === "string" && pkg.name.trim())
        pluginName = pkg.name.trim();
      if (typeof pkg.version === "string" && pkg.version.trim())
        version = pkg.version.trim();
    } catch (err) {
      if (
        (err as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(err instanceof SyntaxError)
      ) {
        throw err;
      }
    }

    records[pluginName] = { source: "path", installPath: pluginDir, version };
  }

  return records;
}

/**
 * Merge drop-in plugins into the load set. Filters out denied, core-colliding,
 * and already-installed names. Mutates `pluginsToLoad` and `installRecords`.
 */
export function mergeDropInPlugins(params: {
  dropInRecords: Record<string, PluginInstallRecord>;
  installRecords: Record<string, PluginInstallRecord>;
  corePluginNames: ReadonlySet<string>;
  denyList: ReadonlySet<string>;
  pluginsToLoad: Set<string>;
}): { accepted: string[]; skipped: string[] } {
  const {
    dropInRecords,
    installRecords,
    corePluginNames,
    denyList,
    pluginsToLoad,
  } = params;
  const accepted: string[] = [];
  const skipped: string[] = [];

  for (const [name, record] of Object.entries(dropInRecords)) {
    if (denyList.has(name) || installRecords[name]) continue;
    if (corePluginNames.has(name)) {
      skipped.push(
        `[eliza] Custom plugin "${name}" collides with core plugin — skipping`,
      );
      continue;
    }
    pluginsToLoad.add(name);
    installRecords[name] = record;
    accepted.push(name);
  }

  return { accepted, skipped };
}

export function resolveElizaPluginImportSpecifier(
  pluginName: string,
  runtimeModuleUrl = import.meta.url,
): string {
  if (!pluginName.startsWith("@elizaos/plugin-")) {
    return pluginName;
  }

  const shortName = pluginName.replace("@elizaos/plugin-", "");
  const thisDir = path.dirname(fileURLToPath(runtimeModuleUrl));
  const distRoot = thisDir.endsWith("runtime")
    ? path.resolve(thisDir, "..")
    : thisDir;
  const indexPath = path.resolve(distRoot, "plugins", shortName, "index.js");

  return existsSync(indexPath) ? pathToFileURL(indexPath).href : pluginName;
}

export function findPluginBrowserStagehandDir(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 14; depth++) {
    const candidate = path.join(
      dir,
      "plugins",
      "plugin-browser",
      "stagehand-server",
    );
    const distIndex = path.join(candidate, "dist", "index.js");
    const srcEntry = path.join(candidate, "src", "index.ts");
    if (existsSync(distIndex) || existsSync(srcEntry)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * `@elizaos/plugin-browser` expects `dist/server/` with the stagehand binary
 * tree inside the npm package, but the published tarball does not ship it.
 * When missing, symlink to a repo checkout at `plugins/plugin-browser/stagehand-server`
 * (discovered via {@link findPluginBrowserStagehandDir}) so the plugin's
 * process-manager can spawn the server.
 *
 * **Why:** Without the symlink, browser automation fails at runtime even when
 * the user built stagehand locally -- the plugin only looks under its package root.
 *
 * @returns `true` when `dist/server` already resolves or symlink succeeded.
 */
export function ensureBrowserServerLink(): boolean {
  try {
    // Resolve the plugin-browser package root via its package.json.
    const req = createRequire(import.meta.url);
    const pkgJsonPath = req.resolve("@elizaos/plugin-browser/package.json");
    const pluginRoot = path.dirname(pkgJsonPath);
    const serverDir = path.join(pluginRoot, "dist", "server");
    const serverIndex = path.join(serverDir, "dist", "index.js");

    // Already linked / available -- nothing to do.
    if (existsSync(serverIndex)) return true;

    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const stagehandDir = findPluginBrowserStagehandDir(thisDir);
    if (!stagehandDir) {
      logger.debug(
        "[eliza] plugin-browser: no stagehand-server under plugins/plugin-browser — " +
          "run node scripts/link-browser-server.mjs or add the plugin checkout",
      );
      return false;
    }
    const stagehandIndex = path.join(stagehandDir, "dist", "index.js");

    // Auto-build if source exists but dist doesn't
    if (
      !existsSync(stagehandIndex) &&
      existsSync(path.join(stagehandDir, "src", "index.ts"))
    ) {
      logger.info(
        `[eliza] Stagehand server not built — attempting auto-build...`,
      );
      try {
        const cp = createRequire(import.meta.url)(
          "node:child_process",
        ) as typeof import("node:child_process");
        if (!existsSync(path.join(stagehandDir, "node_modules"))) {
          cp.execSync("bun install --ignore-scripts", {
            cwd: stagehandDir,
            stdio: "ignore",
            timeout: 60_000,
          });
        }
        // Prefer local tsc binary, fall back to bunx
        const localTsc = path.join(stagehandDir, "node_modules", ".bin", "tsc");
        const tscCmd = existsSync(localTsc) ? localTsc : "bunx tsc";
        cp.execSync(tscCmd, {
          cwd: stagehandDir,
          stdio: "ignore",
          timeout: 60_000,
        });
        logger.info(`[eliza] Stagehand server built successfully`);
      } catch (buildErr) {
        logger.debug(`[eliza] Auto-build failed: ${formatError(buildErr)}`);
      }
    }

    if (!existsSync(stagehandIndex)) {
      logger.debug(
        "[eliza] plugin-browser: stagehand-server present but dist/index.js missing — build it",
      );
      return false;
    }

    // Create symlink: dist/server -> stagehand-server
    symlinkSync(stagehandDir, serverDir, "dir");
    logger.info(
      `[eliza] Linked browser server: ${serverDir} -> ${stagehandDir}`,
    );
    return true;
  } catch (err) {
    logger.debug(`[eliza] Could not link browser server: ${formatError(err)}`);
    return false;
  }
}

/** @internal Exported for testing. */
export function repairBrokenInstallRecord(
  config: ElizaConfig,
  pluginName: string,
): boolean {
  const record = config.plugins?.installs?.[pluginName];
  if (!record || typeof record.installPath !== "string") return false;
  if (!record.installPath.trim()) return false;

  // Keep the plugin listed as installed but force node_modules resolution.
  record.installPath = "";
  record.source = "npm";
  return true;
}

/** Read package.json exports/main to find the importable entry file. */
/** @internal Exported for testing. */
export async function resolvePackageEntry(
  pkgRoot: string,
  exportSubpath = ".",
): Promise<string> {
  const fallback = path.join(pkgRoot, "dist", "index");
  const subpath = exportSubpath.replace(/^\.\//, "");
  const fallbackCandidates = [
    ...(exportSubpath === "."
      ? [
          fallback,
          path.join(pkgRoot, "index"),
          path.join(pkgRoot, "index.mjs"),
          path.join(pkgRoot, "index.ts"),
          path.join(pkgRoot, "src", "index"),
          path.join(pkgRoot, "src", "index.mjs"),
          path.join(pkgRoot, "src", "index.ts"),
        ]
      : [
          path.join(pkgRoot, "dist", subpath),
          path.join(pkgRoot, "dist", `${subpath}.js`),
          path.join(pkgRoot, "dist", `${subpath}.mjs`),
          path.join(pkgRoot, subpath),
          path.join(pkgRoot, `${subpath}.mjs`),
          path.join(pkgRoot, `${subpath}.js`),
          path.join(pkgRoot, `${subpath}.ts`),
          path.join(pkgRoot, "src", subpath),
          path.join(pkgRoot, "src", `${subpath}.js`),
          path.join(pkgRoot, "src", `${subpath}.mjs`),
          path.join(pkgRoot, "src", `${subpath}.ts`),
        ]),
  ];

  const chooseExisting = (...paths: string[]): string => {
    const seen = new Set<string>();
    for (const p of paths) {
      const resolved = path.resolve(p);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      if (existsSync(resolved)) return resolved;
    }
    // Return first candidate even when missing so callers still get a useful path in errors.
    return path.resolve(paths[0] ?? fallback);
  };

  try {
    const raw = await fs.readFile(path.join(pkgRoot, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as {
      name?: string;
      main?: string;
      exports?: Record<string, string | Record<string, string>> | string;
    };

    if (
      typeof pkg.exports === "object" &&
      pkg.exports[exportSubpath] !== undefined
    ) {
      const entry = pkg.exports[exportSubpath];
      const resolved =
        typeof entry === "string" ? entry : entry.import || entry.default;
      if (typeof resolved === "string") {
        return chooseExisting(
          path.resolve(pkgRoot, resolved),
          ...fallbackCandidates,
        );
      }
    }
    if (exportSubpath === "." && typeof pkg.exports === "string") {
      return chooseExisting(
        path.resolve(pkgRoot, pkg.exports),
        ...fallbackCandidates,
      );
    }
    if (exportSubpath === "." && pkg.main) {
      return chooseExisting(
        path.resolve(pkgRoot, pkg.main),
        ...fallbackCandidates,
      );
    }
    return chooseExisting(...fallbackCandidates);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return chooseExisting(...fallbackCandidates);
    }
    throw err;
  }
}
