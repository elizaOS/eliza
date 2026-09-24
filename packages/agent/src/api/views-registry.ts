/**
 * View Registry — discovers, catalogs, and resolves view bundles from plugins.
 *
 * Views are declared by plugins via `Plugin.views`. Each declaration is
 * registered here at plugin load time and assigned runtime URLs. The HTTP
 * layer (`views-routes.ts`) delegates all path resolution back to this module.
 */

import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger, type ViewDeclaration, type ViewType } from "@elizaos/core";
import { generateViewHeroSvgFor } from "@elizaos/ui/view-hero-art";
import { getViewModalities } from "@elizaos/core/views/view-declarations";
import { resolveViewKind } from "@elizaos/core/views/view-kind";
import type { AgentPlatform } from "./platform-detect.ts";

export type { ViewRegistryEntry } from "./view-registry-types.ts";

import { BUILTIN_VIEWS } from "./builtin-views.ts";
import {
  isPathWithinRoot,
  resolveRealPathSync,
} from "./realpath-confinement.ts";
import {
  captureViewAssetRoot,
  setViewAssets,
  type ViewAssetKind,
  type ViewAssetRoot,
} from "./view-assets.ts";
import {
  assertViewInstallation,
  beginViewInstallation,
  commitViewInstallation,
  revokeViewInstallation,
  runtimeViewEntries,
  type ViewInstallation,
} from "./view-installations.ts";
import type { ViewRegistryEntry } from "./view-registry-types.ts";
import { getViewSearchIndex } from "./views-search-index.ts";

export {
  assertRuntimeViewEntry,
  beginViewInstallation,
  closeRuntimeViewRegistry,
  type ViewInstallation,
} from "./view-installations.ts";

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

const builtinInstallations = new WeakMap<IAgentRuntime, ViewInstallation>();

// Directory-loaded plugins are real module objects but are not installed npm
// packages, so name-based resolution cannot recover their bundle root. Binding
// the imported object keeps the directory attached through every lifecycle
// wrapper without widening the shared Plugin or runtime method contracts.
const boundPluginPackageDirectories = new WeakMap<Plugin, string>();

/** Bind an imported plugin object to the package root that supplied it. */
export function bindPluginPackageDirectory(
  plugin: Plugin,
  pluginDir: string,
): void {
  boundPluginPackageDirectories.set(plugin, path.resolve(pluginDir));
}

/** Bundle files already warned about for oversized output — warn once per process. */
const warnedLargeBundlePaths = new Set<string>();
const VIEW_BUNDLE_WARNING_BYTES = 1024 * 1024;

/**
 * Package names to probe for a plugin, in preference order. The canonical
 * `@elizaos/plugin-<name>` candidate comes BEFORE the bare short name: a
 * plugin's short name can collide with an unrelated published npm package
 * (e.g. plugin "birdclaw" vs the `birdclaw` CLI on npm), and under Bun a
 * bare-name resolve can hit that package's install cache — registering the
 * view against a directory that isn't this plugin at all.
 */
export function pluginPackageNameCandidates(pluginName: string): string[] {
  if (pluginName.startsWith("@")) return [pluginName];

  const shortName = pluginName.startsWith("plugin-")
    ? pluginName.slice("plugin-".length)
    : pluginName;
  return [`@elizaos/plugin-${shortName}`, pluginName];
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

  // In a source checkout, the workspace is authoritative. Bun can otherwise
  // resolve a scoped package from its global install cache even when that
  // package is not a dependency of this workspace, serving a stale published
  // view instead of the bundle under review. Packaged installs have no nearby
  // workspace root and naturally fall through to normal package resolution.
  for (const packageName of packageNames) {
    const workspaceDir = await resolveWorkspacePluginPackageDir(packageName);
    if (workspaceDir) return workspaceDir;
  }

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
export function getBundleDiskPath(
  entry: Pick<ViewRegistryEntry, "bundlePath" | "pluginDir">,
): string | null {
  if (!entry.bundlePath || !entry.pluginDir) return null;
  const resolved = path.resolve(entry.pluginDir, entry.bundlePath);
  // Prevent path traversal outside the plugin package root — resolve through
  // longest existing parent so a directory symlink cannot smuggle access.
  const realResolved = resolveRealPathSync(resolved);
  const realRoot = resolveRealPathSync(path.resolve(entry.pluginDir));
  if (!realResolved || !realRoot || !isPathWithinRoot(realResolved, realRoot))
    return null;
  return realResolved;
}

/**
 * Resolve the absolute on-disk path for a sandboxed frame document.
 * Returns `null` when the entry has no `framePath` or no `pluginDir`.
 */
export function getFrameDiskPath(
  entry: Pick<ViewRegistryEntry, "framePath" | "pluginDir">,
): string | null {
  if (!entry.framePath || !entry.pluginDir) return null;
  const resolved = path.resolve(entry.pluginDir, entry.framePath);
  const realResolved = resolveRealPathSync(resolved);
  const realRoot = resolveRealPathSync(path.resolve(entry.pluginDir));
  if (!realResolved || !realRoot || !isPathWithinRoot(realResolved, realRoot))
    return null;
  return realResolved;
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
  const realResolved = resolveRealPathSync(resolved);
  const realRoot = resolveRealPathSync(path.resolve(entry.pluginDir));
  if (!realResolved || !realRoot || !isPathWithinRoot(realResolved, realRoot))
    return null;
  return realResolved;
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
  const realPackageRoot = resolveRealPathSync(packageRoot);
  if (!realPackageRoot) return null;
  for (const ext of HERO_EXTENSIONS) {
    const candidate = path.join(packageRoot, "assets", `hero${ext}`);
    const realCandidate = resolveRealPathSync(candidate);
    if (
      realCandidate &&
      isPathWithinRoot(realCandidate, realPackageRoot) &&
      (await fileExists(realCandidate))
    ) {
      return {
        absolutePath: realCandidate,
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
 * @param runtime - Runtime object that owns this installation.
 * Embedding indexing is explicit through options.indexEmbeddings.
 */
export async function registerPluginViews(
  runtime: IAgentRuntime,
  plugin: Plugin,
  options: {
    pluginDir?: string;
    indexEmbeddings?: boolean;
    installation?: ViewInstallation;
  } = {},
): Promise<ViewInstallation> {
  const installation =
    options.installation ??
    beginViewInstallation(runtime, plugin.name, plugin.packageName);
  try {
    const resolvedDir =
      options.pluginDir ??
      boundPluginPackageDirectories.get(plugin) ??
      (await resolvePluginPackageDir(plugin.packageName ?? plugin.name));
    const registered: ViewRegistryEntry[] = [];
    for (const view of plugin.views ?? []) {
      for (const viewType of getViewModalities(view)) {
        registered.push(
          await buildEntry({ ...view, viewType }, plugin.name, resolvedDir),
        );
      }
    }
    const published = commitViewInstallation(runtime, installation, registered);
    if (options.indexEmbeddings) indexInstalledViews(runtime, published);
    return installation;
  } catch (error) {
    revokeViewInstallation(runtime, installation);
    throw error;
  }
}

/** Retired installation handles cannot delete their replacement. */
export function unregisterPluginViews(
  runtime: IAgentRuntime,
  installation: ViewInstallation,
): void {
  revokeViewInstallation(runtime, installation);
}

function indexInstalledViews(
  runtime: IAgentRuntime,
  entries: readonly ViewRegistryEntry[],
): void {
  setImmediate(() => {
    for (const entry of entries) {
      // indexView owns its optional-model fallback and installation checks.
      void getViewSearchIndex(runtime).indexView(entry);
    }
  });
}

/**
 * Register all built-in first-party shell views.
 *
 * These views are declared in `builtin-views.ts` and live in the main shell
 * bundle — no separate bundle file is required. Called once at server startup
 * before any plugin views are registered. A built-in fallback yields only to
 * its declared package at the same id, path, and modality. Other conflicts
 * keep the existing entry. Unloading the package restores its fallback.
 *
 * Safe to call multiple times — subsequent calls have no additional effect
 * because the conflict guard in `registerPluginViews` keeps the first
 * registration.
 *
 * @param runtime - Optional agent runtime. When provided, embeddings for the
 *   built-in views are queued in the background search index.
 */
export function registerBuiltinViews(
  runtime: IAgentRuntime,
  options: { indexEmbeddings?: boolean } = {},
): void {
  const current = builtinInstallations.get(runtime);
  if (current) {
    assertViewInstallation(runtime, current);
    return;
  }
  const installation = beginViewInstallation(runtime, "@elizaos/builtin");
  const views = BUILTIN_VIEWS;
  const loadedAt = Date.now();
  const pluginName = "@elizaos/builtin";
  const registered: ViewRegistryEntry[] = [];
  for (const sourceView of views) {
    for (const viewType of getViewModalities(sourceView)) {
      const view = { ...sourceView, viewType };
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
        frameUrl: undefined,
        frameUrlVersioned: undefined,
        heroImageUrl: `/api/views/${encodeURIComponent(view.id)}/hero${
          query ? `?${query}` : ""
        }`,
        hasHeroImage,
        available: true,
        loadedAt,
        platform,
        builtin: true,
      };
      registered.push(entry);
    }
  }
  try {
    const published = commitViewInstallation(runtime, installation, registered);
    builtinInstallations.set(runtime, installation);
    if (options.indexEmbeddings) indexInstalledViews(runtime, published);
  } catch (error) {
    revokeViewInstallation(runtime, installation);
    throw error;
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
export function listViews(
  runtime: IAgentRuntime,
  filter?: {
    developerMode?: boolean;
    includeAllKinds?: boolean;
    viewType?: ViewType;
  },
): ViewRegistryEntry[] {
  const developerMode = filter?.developerMode ?? false;
  const includeAllKinds = filter?.includeAllKinds ?? false;
  const requestedViewType = filter?.viewType ?? DEFAULT_VIEW_TYPE;
  const byId = new Map<string, ViewRegistryEntry>();
  for (const entry of runtimeViewEntries(runtime)) {
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
  runtime: IAgentRuntime,
  id: string,
  filter?: { viewType?: ViewType },
): ViewRegistryEntry | undefined {
  const requestedViewType = filter?.viewType ?? DEFAULT_VIEW_TYPE;
  return (
    runtimeViewEntries(runtime).find(
      (entry) => entry.id === id && entry.viewType === requestedViewType,
    ) ??
    runtimeViewEntries(runtime).find(
      (entry) => entry.id === id && entry.viewType === DEFAULT_VIEW_TYPE,
    )
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function buildEntry(
  view: ViewDeclaration,
  pluginName: string,
  pluginDir: string | undefined,
): Promise<ViewRegistryEntry> {
  const loadedAt = Date.now();
  const normalizedViewType = normalizeViewType(view.viewType);
  const registryKey = viewRegistryKey(view.id, normalizedViewType);
  const requiresFrameDocument = view.surface?.isolation === "sandboxed-iframe";

  const roots: Partial<Record<ViewAssetKind, ViewAssetRoot>> = {};
  for (const kind of ["bundle", "frame"] as const) {
    if (kind === "bundle" ? view.bundleUrl : view.frameUrl) continue;
    const file =
      kind === "bundle"
        ? getBundleDiskPath({ bundlePath: view.bundlePath, pluginDir })
        : getFrameDiskPath({ framePath: view.framePath, pluginDir });
    if (file && (await fileExists(file)))
      roots[kind] = await captureViewAssetRoot(file);
  }
  const bundle = roots.bundle?.files.get(roots.bundle.rootName);
  const frame = roots.frame?.files.get(roots.frame.rootName);
  const bundleHash = bundle?.hash;
  const bundleSize = bundle?.size;
  const frameHash = frame?.hash;
  const frameSize = frame?.size;
  const available = requiresFrameDocument
    ? Boolean(view.frameUrl || frame)
    : Boolean(view.bundleUrl || view.frameUrl || bundle || frame);
  if (bundle && roots.bundle && bundle.size > VIEW_BUNDLE_WARNING_BYTES) {
    const rootPath = path.join(roots.bundle.directory, roots.bundle.rootName);
    if (!warnedLargeBundlePaths.has(rootPath)) {
      warnedLargeBundlePaths.add(rootPath);
      logger.warn(
        {
          src: "ViewRegistry",
          viewId: view.id,
          viewType: normalizedViewType,
          sizeKb: (bundle.size / 1024).toFixed(0),
        },
        `View ${registryKey} bundle is large; reduce dependencies in its single-module build`,
      );
    }
  }

  const encodedId = encodeURIComponent(view.id);
  // Both public URLs identify the registered bytes. Publication adds the installation.
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
      ? buildAssetUrl("bundle.js", bundleHash)
      : undefined;
  const bundleUrlVersioned = view.bundleUrl
    ? view.bundleUrl
    : view.bundlePath && bundleHash
      ? buildAssetUrl("bundle.js", bundleHash)
      : bundleUrl;
  const frameUrl = view.frameUrl
    ? view.frameUrl
    : view.framePath
      ? buildAssetUrl("frame.html", frameHash)
      : undefined;
  const frameUrlVersioned = view.frameUrl
    ? view.frameUrl
    : view.framePath && frameHash
      ? buildAssetUrl("frame.html", frameHash)
      : frameUrl;

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

  const entry: ViewRegistryEntry = {
    ...view,
    viewType: normalizedViewType,
    pluginName,
    pluginDir,
    bundleUrl,
    bundleUrlVersioned,
    frameUrl,
    frameUrlVersioned,
    heroImageUrl,
    hasHeroImage,
    available,
    loadedAt,
    platform,
    bundleHash,
    bundleSize,
    frameHash,
    frameSize,
  };
  setViewAssets(entry, roots);
  return entry;
}
