/**
 * View Registry — discovers, catalogs, and resolves view bundles from plugins.
 *
 * Views are declared by plugins via `Plugin.views`. Each declaration is
 * registered here at plugin load time and assigned runtime URLs. The HTTP
 * layer (`views-routes.ts`) delegates all path resolution back to this module.
 */

import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IAgentRuntime } from "@elizaos/core";
import {
  getViewModalities,
  logger,
  type Plugin,
  resolveViewKind,
  type ViewDeclaration,
  type ViewType,
} from "@elizaos/core";
import { generateViewHeroSvgFor } from "@elizaos/shared";
import type { AgentPlatform } from "./platform-detect.ts";

export type { ViewRegistryEntry } from "./view-registry-types.ts";

import { BUILTIN_VIEWS } from "./builtin-views.ts";
import type { ViewRegistryEntry } from "./view-registry-types.ts";
import { viewSearchIndex } from "./views-search-index.ts";

/** Hero image extensions checked in order when `heroImagePath` is not set. */
const HERO_EXTENSIONS = [".webp", ".png", ".jpg", ".jpeg", ".svg"] as const;

/** MIME types for hero image extensions. */
const HERO_CONTENT_TYPES: Record<string, string> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

const DEFAULT_VIEW_TYPE: ViewType = "gui";

const AGENT_PACKAGE_DIR = resolveNearestPackageDirSync(
  path.dirname(fileURLToPath(import.meta.url)),
);

function normalizeViewType(viewType: ViewDeclaration["viewType"]): ViewType {
  return viewType ?? DEFAULT_VIEW_TYPE;
}

function viewRegistryKey(id: string, viewType: ViewType): string {
  return `${viewType}:${id}`;
}

/** Module-level registry storage. Keyed by view type + view id. */
const registry = new Map<string, ViewRegistryEntry>();

/** View ids already warned about for oversized bundles — warn once per process. */
const warnedLargeBundles = new Set<string>();

/**
 * Package names to probe for a plugin, in preference order. The canonical
 * `@elizaos/plugin-<name>` candidate comes BEFORE the bare short name: a
 * plugin's short name can collide with an unrelated published npm package
 * (e.g. plugin "birdclaw" vs the `birdclaw` CLI on npm), and under Bun a
 * bare-name resolve can hit that package's install cache — registering the
 * view against a directory that isn't this plugin at all.
 */
export function pluginPackageNameCandidates(pluginName: string): string[] {
  return pluginName.startsWith("@")
    ? [pluginName]
    : [`@elizaos/plugin-${pluginName}`, pluginName];
}

/**
 * Attempt to resolve the package root dir for a plugin by name using
 * `require.resolve`. Returns `undefined` when the package is not reachable
 * from the current module (e.g. workspace-linked but not installed).
 */
async function resolvePluginPackageDir(
  pluginName: string,
): Promise<string | undefined> {
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.url);
  const packageNames = pluginPackageNameCandidates(pluginName);

  for (const packageName of packageNames) {
    // Preferred: resolve the package's own package.json directly. Requires the
    // package to expose "./package.json" in its exports map.
    try {
      return path.dirname(req.resolve(`${packageName}/package.json`));
    } catch {
      // Fall through to resolving the package entry instead.
    }
  }

  // Fallback: resolve the package main entry (the "." export always exists for
  // a loadable plugin) and walk up to the directory that owns its package.json.
  // This keeps view bundles resolvable for plugins that don't export
  // "./package.json".
  for (const packageName of packageNames) {
    try {
      let dir = path.dirname(req.resolve(packageName));
      for (let depth = 0; depth < 8; depth++) {
        if (await fileExists(path.join(dir, "package.json"))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch {
      // Package is not reachable from this module under this name.
    }
  }

  for (const packageName of packageNames) {
    const workspaceDir = await resolveWorkspacePluginPackageDir(packageName);
    if (workspaceDir) return workspaceDir;
  }

  logger.warn(
    { src: "ViewRegistry", pluginName },
    `Could not resolve package directory for plugin "${pluginName}"; its view bundle will be unavailable`,
  );
  return undefined;
}

async function resolveWorkspacePluginPackageDir(
  pluginName: string,
): Promise<string | undefined> {
  if (!pluginName.startsWith("@elizaos/plugin-")) return undefined;

  const shortName = pluginName.slice("@elizaos/".length);
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 14; depth += 1) {
    const candidate = path.join(dir, "plugins", shortName);
    if (await fileExists(path.join(candidate, "package.json"))) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const cwdCandidate = path.join(process.cwd(), "plugins", shortName);
  if (await fileExists(path.join(cwdCandidate, "package.json"))) {
    return cwdCandidate;
  }

  return undefined;
}

/**
 * Check whether a file exists on disk (non-throwing).
 */
async function fileExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function resolveNearestPackageDirSync(startDir: string): string | undefined {
  let dir = startDir;
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Resolve the absolute on-disk path for a view bundle.
 * Returns `null` when the entry has no `bundlePath` or no `pluginDir`.
 */
export function getBundleDiskPath(entry: ViewRegistryEntry): string | null {
  if (!entry.bundlePath || !entry.pluginDir) return null;
  const resolved = path.resolve(entry.pluginDir, entry.bundlePath);
  // Prevent path traversal outside the plugin package root.
  const packageRoot = `${path.resolve(entry.pluginDir)}${path.sep}`;
  if (!resolved.startsWith(packageRoot)) return null;
  return resolved;
}

/**
 * Resolve the absolute on-disk path for a sandbox frame HTML document.
 * Returns `null` when the entry has no `framePath` or no `pluginDir`.
 */
export function getFrameDiskPath(entry: ViewRegistryEntry): string | null {
  if (!entry.framePath || !entry.pluginDir) return null;
  const resolved = path.resolve(entry.pluginDir, entry.framePath);
  const packageRoot = `${path.resolve(entry.pluginDir)}${path.sep}`;
  if (!resolved.startsWith(packageRoot)) return null;
  return resolved;
}

/**
 * Resolve the absolute on-disk path for a hero image.
 * Returns `null` when the entry has no `heroImagePath` or no `pluginDir`.
 * This only handles declared paths; for extension-probing see `findHeroOnDisk`.
 */
type HeroLookup = Pick<ViewRegistryEntry, "pluginDir" | "heroImagePath">;

export function getHeroDiskPath(entry: HeroLookup): string | null {
  if (!entry.heroImagePath || !entry.pluginDir) return null;
  const resolved = path.resolve(entry.pluginDir, entry.heroImagePath);
  const packageRoot = `${path.resolve(entry.pluginDir)}${path.sep}`;
  if (!resolved.startsWith(packageRoot)) return null;
  return resolved;
}

function hasDeclaredHeroOnDiskSync(entry: HeroLookup): boolean {
  const declaredPath = getHeroDiskPath(entry);
  if (!declaredPath) return false;
  const ext = path.extname(declaredPath).toLowerCase();
  return Boolean(HERO_CONTENT_TYPES[ext] && existsSync(declaredPath));
}

/**
 * Find the first existing hero image file for an entry, probing extensions
 * in preference order. Returns the absolute path and its content type, or
 * `null` when nothing is found.
 */
export async function findHeroOnDisk(
  entry: HeroLookup,
): Promise<{ absolutePath: string; contentType: string } | null> {
  if (!entry.pluginDir) return null;

  // If a specific path was declared, try it first.
  const declaredPath = getHeroDiskPath(entry);
  if (declaredPath) {
    const ext = path.extname(declaredPath).toLowerCase();
    const contentType = HERO_CONTENT_TYPES[ext];
    if (contentType && (await fileExists(declaredPath))) {
      return { absolutePath: declaredPath, contentType };
    }
  }

  // Fall back to probing `assets/hero.<ext>` in the plugin dir.
  const packageRoot = path.resolve(entry.pluginDir);
  for (const ext of HERO_EXTENSIONS) {
    const candidate = path.join(packageRoot, "assets", `hero${ext}`);
    if (await fileExists(candidate)) {
      return {
        absolutePath: candidate,
        contentType: HERO_CONTENT_TYPES[ext] ?? "image/png",
      };
    }
  }

  return null;
}

/**
 * Build a branded generated SVG fallback when no hero image is on disk. Shares
 * the exact art (frame, no-blue palette, line-icon glyph) used for the heroes
 * committed into plugins, so a view without a packaged hero still renders a
 * cohesive card instead of a placeholder. `icon` is the view's Lucide icon name,
 * used as a hint to pick the matching glyph.
 */
export function generateViewHeroSvg(label: string, icon?: string): string {
  return generateViewHeroSvgFor({ label, icon });
}

/**
 * Register all views declared by `plugin`. Safe to call multiple times for the
 * same plugin — subsequent calls update existing entries.
 *
 * @param plugin    - The Plugin object whose `views` array to register.
 * @param pluginDir - Absolute path to the plugin's package root. When omitted,
 *   the registry attempts to resolve it via `require.resolve`.
 * @param runtime   - Optional agent runtime. When provided, embeddings for the
 *   newly registered views are queued in the background search index.
 */
export async function registerPluginViews(
  plugin: Plugin,
  pluginDir?: string,
  runtime?: IAgentRuntime,
): Promise<void> {
  const views = plugin.views;
  if (!views || views.length === 0) return;

  // A plugin can be hot-reloaded with a changed views array. Remove the old
  // entries first so deleted or renamed views do not survive the reload.
  unregisterPluginViews(plugin.name);

  // Resolve plugin directory once for all views in this plugin.
  const resolvedDir = pluginDir ?? (await resolvePluginPackageDir(plugin.name));

  const registered: ViewRegistryEntry[] = [];
  for (const view of views) {
    for (const viewType of getViewModalities(view)) {
      const entry = await buildEntry(
        { ...view, viewType },
        plugin.name,
        resolvedDir,
      );
      const key = viewRegistryKey(entry.id, entry.viewType);
      const existing = registry.get(key);
      if (existing && existing.pluginName !== plugin.name) {
        logger.warn(
          {
            src: "ViewRegistry",
            viewId: entry.id,
            viewType: entry.viewType,
            existingPlugin: existing.pluginName,
            incomingPlugin: plugin.name,
          },
          `View id "${entry.id}" (${entry.viewType}) from plugin "${plugin.name}" conflicts with plugin "${existing.pluginName}"; keeping existing entry`,
        );
        continue;
      }
      registry.set(key, entry);
      registered.push(entry);
      logger.debug(
        {
          src: "ViewRegistry",
          viewId: entry.id,
          viewType: entry.viewType,
          pluginName: entry.pluginName,
          available: entry.available,
        },
        `Registered view "${entry.id}" (${entry.viewType}) from plugin "${plugin.name}"`,
      );
    }
  }

  // Queue embedding computation in the background — non-blocking.
  if (runtime && registered.length > 0) {
    setImmediate(() => {
      for (const entry of registered) {
        // error-policy:J5 indexView self-degrades (its own catch logs and falls
        // back to keyword search); this only suppresses a stray rejection from a
        // synchronous pre-embed throw so a background task cannot crash the loop.
        void viewSearchIndex.indexView(entry, runtime).catch(() => {});
      }
    });
  }
}

/**
 * Remove all views registered for `pluginName`. Called when a plugin is
 * unloaded via `runtime.unloadPlugin`.
 */
export function unregisterPluginViews(pluginName: string): void {
  for (const [key, entry] of registry) {
    if (entry.pluginName === pluginName) {
      registry.delete(key);
      viewSearchIndex.removeView(entry.id, entry.viewType);
      logger.debug(
        { src: "ViewRegistry", viewId: entry.id, pluginName },
        `Unregistered view "${entry.id}" from plugin "${pluginName}"`,
      );
    }
  }
}

/**
 * Register all built-in first-party shell views.
 *
 * These views are declared in `builtin-views.ts` and live in the main shell
 * bundle — no separate bundle file is required. Called once at server startup
 * before any plugin views are registered, so plugin views can override them
 * by registering the same id only when a conflict is logged (built-in wins
 * under the existing conflict resolution rule).
 *
 * Safe to call multiple times — subsequent calls have no additional effect
 * because the conflict guard in `registerPluginViews` keeps the first
 * registration.
 *
 * @param runtime - Optional agent runtime. When provided, embeddings for the
 *   built-in views are queued in the background search index.
 */
export function registerBuiltinViews(runtime?: IAgentRuntime): void {
  const loadedAt = Date.now();
  const pluginName = "@elizaos/builtin";
  const registered: ViewRegistryEntry[] = [];
  for (const sourceView of BUILTIN_VIEWS) {
    for (const viewType of getViewModalities(sourceView)) {
      const view = { ...sourceView, viewType };
      const key = viewRegistryKey(view.id, viewType);
      if (registry.has(key)) {
        // Already registered (e.g. called twice at startup). Skip silently.
        continue;
      }
      const platform: AgentPlatform =
        (view.platforms?.[0] as AgentPlatform | undefined) ?? "web";
      const pluginDir = AGENT_PACKAGE_DIR;
      const hasHeroImage = pluginDir
        ? hasDeclaredHeroOnDiskSync({
            pluginDir,
            heroImagePath: view.heroImagePath,
          })
        : false;
      const params = new URLSearchParams();
      if (viewType !== DEFAULT_VIEW_TYPE) {
        params.set("viewType", viewType);
      }
      const query = params.toString();
      const entry: ViewRegistryEntry = {
        ...view,
        viewType,
        pluginName,
        pluginDir,
        bundleUrl: undefined,
        bundleUrlVersioned: undefined,
        heroImageUrl: `/api/views/${encodeURIComponent(view.id)}/hero${
          query ? `?${query}` : ""
        }`,
        hasHeroImage,
        available: true,
        loadedAt,
        platform,
        builtin: true,
      };
      registry.set(key, entry);
      registered.push(entry);
    }
  }
  // Called on every /api/views request and again during deferred startup, but
  // registration is idempotent — only the first call adds entries. Stay silent
  // on idempotent re-calls so the boot log isn't spammed with the same line.
  if (registered.length > 0) {
    logger.info(
      { src: "ViewRegistry", count: registered.length },
      `Registered ${registered.length} built-in views`,
    );
  }

  // Queue embedding computation in the background — non-blocking.
  if (runtime && registered.length > 0) {
    setImmediate(() => {
      for (const entry of registered) {
        // error-policy:J5 indexView self-degrades (its own catch logs and falls
        // back to keyword search); this only suppresses a stray rejection from a
        // synchronous pre-embed throw so a background task cannot crash the loop.
        void viewSearchIndex.indexView(entry, runtime).catch(() => {});
      }
    });
  }
}

/**
 * List all registered views.
 *
 * Visibility follows the four-kind taxonomy ({@link resolveViewKind}):
 * `system`/`release` views are always listed. `developer` views are listed
 * only when `developerMode` is true. `preview` views are listed only when
 * `includeAllKinds` is true. The dashboard's `GET /api/views` passes
 * `includeAllKinds: true` so the client receives every view (with its
 * `viewKind`) and applies the user's Settings toggles itself — the server
 * cannot know whether it is talking to a dev build or which toggles are on.
 *
 * @param filter.developerMode - Include `developer`-kind views. Default false.
 * @param filter.includeAllKinds - Include every kind regardless of toggle
 *   (developer + preview). Default false.
 */
export function listViews(filter?: {
  developerMode?: boolean;
  includeAllKinds?: boolean;
  viewType?: ViewType;
}): ViewRegistryEntry[] {
  const developerMode = filter?.developerMode ?? false;
  const includeAllKinds = filter?.includeAllKinds ?? false;
  const requestedViewType = filter?.viewType ?? DEFAULT_VIEW_TYPE;
  const byId = new Map<string, ViewRegistryEntry>();
  for (const entry of registry.values()) {
    if (!includeAllKinds) {
      const kind = resolveViewKind(entry);
      if (kind === "preview") continue;
      if (kind === "developer" && !developerMode) continue;
    }
    const existing = byId.get(entry.id);
    if (!existing) {
      if (
        entry.viewType === requestedViewType ||
        entry.viewType === DEFAULT_VIEW_TYPE
      ) {
        byId.set(entry.id, entry);
      }
      continue;
    }
    if (
      existing.viewType !== requestedViewType &&
      entry.viewType === requestedViewType
    ) {
      byId.set(entry.id, entry);
    }
  }
  const results = [...byId.values()];
  results.sort(
    (a, b) =>
      (a.order ?? 100) - (b.order ?? 100) ||
      a.label.localeCompare(b.label) ||
      a.id.localeCompare(b.id),
  );
  return results;
}

/**
 * Look up a single view by its stable id.
 */
export function getView(
  id: string,
  filter?: { viewType?: ViewType },
): ViewRegistryEntry | undefined {
  const requestedViewType = filter?.viewType ?? DEFAULT_VIEW_TYPE;
  return (
    registry.get(viewRegistryKey(id, requestedViewType)) ??
    registry.get(viewRegistryKey(id, DEFAULT_VIEW_TYPE))
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Compute a short content hash for a bundle file. Returns `null` on any I/O error. */
async function computeBundleHash(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath);
    return createHash("sha256").update(content).digest("hex").slice(0, 12);
  } catch {
    return null;
  }
}

async function buildEntry(
  view: ViewDeclaration,
  pluginName: string,
  pluginDir: string | undefined,
): Promise<ViewRegistryEntry> {
  const loadedAt = Date.now();
  const normalizedViewType = normalizeViewType(view.viewType);
  const registryKey = viewRegistryKey(view.id, normalizedViewType);
  const requiresFrameDocument = view.surface?.isolation === "sandboxed-iframe";

  // Check bundle availability and collect hash + size when resolvable.
  let available = requiresFrameDocument
    ? Boolean(view.frameUrl)
    : Boolean(view.bundleUrl || view.frameUrl);
  let bundleHash: string | undefined;
  let bundleSize: number | undefined;
  if (!view.bundleUrl && pluginDir && view.bundlePath) {
    const bundleAbs = path.resolve(pluginDir, view.bundlePath);
    const packageRoot = `${path.resolve(pluginDir)}${path.sep}`;
    if (bundleAbs.startsWith(packageRoot)) {
      const bundleExists = await fileExists(bundleAbs);
      if (!requiresFrameDocument) {
        available = bundleExists;
      }
      if (bundleExists) {
        const [hash, stat] = await Promise.all([
          computeBundleHash(bundleAbs),
          fs.stat(bundleAbs).catch(() => null),
        ]);
        if (hash) bundleHash = hash;
        if (stat) bundleSize = stat.size;

        // buildEntry runs on every (re-)registration, so a plugin loaded into
        // multiple runtimes logs this repeatedly. Keep the per-view size at
        // debug and warn at most once per registry key about oversized bundles.
        const sizeKb = stat ? stat.size / 1024 : 0;
        if (stat && stat.size > 512 * 1024) {
          if (!warnedLargeBundles.has(registryKey)) {
            warnedLargeBundles.add(registryKey);
            logger.warn(
              {
                src: "ViewRegistry",
                viewId: view.id,
                viewType: normalizedViewType,
                sizeKb: sizeKb.toFixed(0),
              },
              `View ${registryKey} bundle is large (${sizeKb.toFixed(0)}KB) — consider code splitting`,
            );
          }
        } else if (stat) {
          logger.debug(
            { src: "ViewRegistry", viewId: view.id, sizeKb: sizeKb.toFixed(1) },
            `Registered view ${view.id} — bundle: ${sizeKb.toFixed(1)}KB`,
          );
        }
      }
    }
  }
  if (!view.frameUrl && pluginDir && view.framePath) {
    const frameAbs = path.resolve(pluginDir, view.framePath);
    const packageRoot = `${path.resolve(pluginDir)}${path.sep}`;
    if (frameAbs.startsWith(packageRoot)) {
      const frameExists = await fileExists(frameAbs);
      if (requiresFrameDocument) {
        available = frameExists;
      } else if (!available) {
        available = frameExists;
      }
    }
  }

  const encodedId = encodeURIComponent(view.id);
  // bundleUrl uses a timestamp ?v= param for backwards-compat; bundleUrlVersioned
  // uses the content hash when available (allows immutable long-lived caching).
  const buildAssetUrl = (
    asset: "bundle.js" | "frame.html" | "hero",
    version?: number | string,
  ): string => {
    const params = new URLSearchParams();
    if (normalizedViewType !== DEFAULT_VIEW_TYPE) {
      params.set("viewType", normalizedViewType);
    }
    if (version !== undefined) {
      params.set("v", String(version));
    }

    const query = params.toString();
    return `/api/views/${encodedId}/${asset}${query ? `?${query}` : ""}`;
  };
  const bundleUrl = view.bundleUrl
    ? view.bundleUrl
    : view.bundlePath
      ? buildAssetUrl("bundle.js", loadedAt)
      : undefined;
  const bundleUrlVersioned = view.bundleUrl
    ? view.bundleUrl
    : view.bundlePath && bundleHash
      ? buildAssetUrl("bundle.js", bundleHash)
      : bundleUrl;
  const frameUrl = view.frameUrl
    ? view.frameUrl
    : view.framePath
      ? buildAssetUrl("frame.html", loadedAt)
      : undefined;

  const heroImageUrl = buildAssetUrl("hero");
  // Probe for a real hero asset so the client can choose a photo vs. its icon.
  const hasHeroImage = pluginDir
    ? (await findHeroOnDisk({
        pluginDir,
        heroImagePath: view.heroImagePath,
      })) !== null
    : false;

  // Derive a representative platform from the declaration's platforms list.
  // When multiple platforms are declared, the first entry wins. Absent the
  // field, treat the view as "web" (no platform restriction).
  const platform: AgentPlatform =
    (view.platforms?.[0] as AgentPlatform | undefined) ?? "web";

  return {
    ...view,
    viewType: normalizedViewType,
    pluginName,
    pluginDir,
    bundleUrl,
    bundleUrlVersioned,
    frameUrl,
    heroImageUrl,
    hasHeroImage,
    available,
    loadedAt,
    platform,
    bundleHash,
    bundleSize,
  };
}
