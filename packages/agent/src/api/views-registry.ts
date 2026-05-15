/**
 * View Registry — discovers, catalogs, and resolves view bundles from plugins.
 *
 * Views are declared by plugins via `Plugin.views`. Each declaration is
 * registered here at plugin load time and assigned runtime URLs. The HTTP
 * layer (`views-routes.ts`) delegates all path resolution back to this module.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { logger, type Plugin, type ViewDeclaration } from "@elizaos/core";

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

export interface ViewRegistryEntry extends ViewDeclaration {
  /** Owning plugin name. */
  pluginName: string;
  /** Absolute path to the plugin's package root, if resolvable. */
  pluginDir?: string;
  /** Resolved URL served by the agent: `/api/views/<id>/bundle.js`. */
  bundleUrl?: string;
  /** Resolved URL served by the agent: `/api/views/<id>/hero`. */
  heroImageUrl?: string;
  /** True when the bundle file exists on disk. */
  available: boolean;
  /** Unix timestamp (ms) when this entry was registered. */
  loadedAt: number;
}

/** Module-level registry storage. Keyed by view id. */
const registry = new Map<string, ViewRegistryEntry>();

/**
 * Attempt to resolve the package root dir for a plugin by name using
 * `require.resolve`. Returns `undefined` when the package is not reachable
 * from the current module (e.g. workspace-linked but not installed).
 */
async function resolvePluginPackageDir(
  pluginName: string,
): Promise<string | undefined> {
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const pkgJsonPath = req.resolve(`${pluginName}/package.json`);
    return path.dirname(pkgJsonPath);
  } catch {
    return undefined;
  }
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
 * Resolve the absolute on-disk path for a hero image.
 * Returns `null` when the entry has no `heroImagePath` or no `pluginDir`.
 * This only handles declared paths; for extension-probing see `findHeroOnDisk`.
 */
export function getHeroDiskPath(entry: ViewRegistryEntry): string | null {
  if (!entry.heroImagePath || !entry.pluginDir) return null;
  const resolved = path.resolve(entry.pluginDir, entry.heroImagePath);
  const packageRoot = `${path.resolve(entry.pluginDir)}${path.sep}`;
  if (!resolved.startsWith(packageRoot)) return null;
  return resolved;
}

/**
 * Find the first existing hero image file for an entry, probing extensions
 * in preference order. Returns the absolute path and its content type, or
 * `null` when nothing is found.
 */
export async function findHeroOnDisk(
  entry: ViewRegistryEntry,
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
 * Build a minimal SVG placeholder when no hero image is available.
 */
export function generateViewHeroSvg(
  label: string,
  icon?: string,
): string {
  const displayIcon = icon ?? label.slice(0, 2).toUpperCase();
  // Use a simple gradient tile — readable at any size.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="400" height="300">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1a1a2e;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#16213e;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="400" height="300" fill="url(#g)" rx="12"/>
  <text x="200" y="130" font-family="system-ui,sans-serif" font-size="64"
        text-anchor="middle" dominant-baseline="middle" fill="#6c63ff" opacity="0.85">
    ${displayIcon}
  </text>
  <text x="200" y="210" font-family="system-ui,sans-serif" font-size="20"
        text-anchor="middle" dominant-baseline="middle" fill="#e0e0e0" opacity="0.7">
    ${label}
  </text>
</svg>`;
}

/**
 * Register all views declared by `plugin`. Safe to call multiple times for the
 * same plugin — subsequent calls update existing entries.
 *
 * @param plugin - The Plugin object whose `views` array to register.
 * @param pluginDir - Absolute path to the plugin's package root. When omitted,
 *   the registry attempts to resolve it via `require.resolve`.
 */
export async function registerPluginViews(
  plugin: Plugin,
  pluginDir?: string,
): Promise<void> {
  const views = plugin.views;
  if (!views || views.length === 0) return;

  // Resolve plugin directory once for all views in this plugin.
  const resolvedDir =
    pluginDir ?? (await resolvePluginPackageDir(plugin.name));

  for (const view of views) {
    const entry = await buildEntry(view, plugin.name, resolvedDir);
    registry.set(entry.id, entry);
    logger.debug(
      {
        src: "ViewRegistry",
        viewId: entry.id,
        pluginName: entry.pluginName,
        available: entry.available,
      },
      `[ViewRegistry] Registered view "${entry.id}" from plugin "${plugin.name}"`,
    );
  }
}

/**
 * Remove all views registered for `pluginName`. Called when a plugin is
 * unloaded via `runtime.unloadPlugin`.
 */
export function unregisterPluginViews(pluginName: string): void {
  for (const [id, entry] of registry) {
    if (entry.pluginName === pluginName) {
      registry.delete(id);
      logger.debug(
        { src: "ViewRegistry", viewId: id, pluginName },
        `[ViewRegistry] Unregistered view "${id}" from plugin "${pluginName}"`,
      );
    }
  }
}

/**
 * List all registered views.
 *
 * @param filter.developerMode - When `false` (default) hidden developer-only
 *   views are excluded. Pass `true` to include them.
 */
export function listViews(filter?: {
  developerMode?: boolean;
}): ViewRegistryEntry[] {
  const developerMode = filter?.developerMode ?? false;
  const results: ViewRegistryEntry[] = [];
  for (const entry of registry.values()) {
    if (entry.developerOnly && !developerMode) continue;
    results.push(entry);
  }
  results.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  return results;
}

/**
 * Look up a single view by its stable id.
 */
export function getView(id: string): ViewRegistryEntry | undefined {
  return registry.get(id);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function buildEntry(
  view: ViewDeclaration,
  pluginName: string,
  pluginDir: string | undefined,
): Promise<ViewRegistryEntry> {
  const bundleUrl = view.bundlePath
    ? `/api/views/${encodeURIComponent(view.id)}/bundle.js`
    : undefined;

  const heroImageUrl = `/api/views/${encodeURIComponent(view.id)}/hero`;

  // Check bundle availability synchronously using the resolved dir.
  let available = false;
  if (pluginDir && view.bundlePath) {
    const bundleAbs = path.resolve(pluginDir, view.bundlePath);
    const packageRoot = `${path.resolve(pluginDir)}${path.sep}`;
    if (bundleAbs.startsWith(packageRoot)) {
      available = await fileExists(bundleAbs);
    }
  }

  return {
    ...view,
    pluginName,
    pluginDir,
    bundleUrl,
    heroImageUrl,
    available,
    loadedAt: Date.now(),
  };
}
