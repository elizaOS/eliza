/**
 * View Registry — discovers, catalogs, and resolves view bundles from plugins.
 *
 * Views are declared by plugins via `Plugin.views`. Each declaration is
 * registered here at plugin load time and assigned runtime URLs. The HTTP
 * layer (`views-routes.ts`) delegates all path resolution back to this module.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { logger, type Plugin, type ViewDeclaration } from "@elizaos/core";
import { BUILTIN_VIEWS } from "./builtin-views.ts";
import type { AgentPlatform } from "./platform-detect.ts";

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

function escapeSvgText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

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
  /**
   * Platform this view is available on. Populated from
   * `ViewDeclaration.platforms` (first entry) or defaults to "web".
   * Used by platform-aware route filtering to gate dynamic bundles on
   * restricted platforms (iOS App Store, Google Play).
   */
  platform: AgentPlatform;
  /** First 12 hex chars of the SHA-256 content hash of the bundle file. */
  bundleHash?: string;
  /** Bundle URL with `?v=<hash>` for immutable long-lived caching. */
  bundleUrlVersioned?: string;
  /** Bundle file size in bytes. */
  bundleSize?: number;
  /**
   * True for entries registered by the built-in shell itself
   * (pluginName === "@elizaos/builtin"). These views live in the main
   * bundle and have no separate bundle file.
   */
  builtin?: boolean;
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
export function generateViewHeroSvg(label: string, icon?: string): string {
  const displayIcon = escapeSvgText(icon ?? label.slice(0, 2).toUpperCase());
  const displayLabel = escapeSvgText(label);
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
    ${displayLabel}
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

  // A plugin can be hot-reloaded with a changed views array. Remove the old
  // entries first so deleted or renamed views do not survive the reload.
  unregisterPluginViews(plugin.name);

  // Resolve plugin directory once for all views in this plugin.
  const resolvedDir = pluginDir ?? (await resolvePluginPackageDir(plugin.name));

  for (const view of views) {
    const entry = await buildEntry(view, plugin.name, resolvedDir);
    const existing = registry.get(entry.id);
    if (existing && existing.pluginName !== plugin.name) {
      logger.warn(
        {
          src: "ViewRegistry",
          viewId: entry.id,
          existingPlugin: existing.pluginName,
          incomingPlugin: plugin.name,
        },
        `[ViewRegistry] View id "${entry.id}" from plugin "${plugin.name}" conflicts with plugin "${existing.pluginName}"; keeping existing entry`,
      );
      continue;
    }
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
 * Register all built-in first-party shell views.
 *
 * These views are declared in `builtin-views.ts` and live in the main shell
 * bundle — no separate bundle file is required. Called once at server startup
 * before any plugin views are registered, so plugin views can override them
 * by registering the same id only when a conflict is logged (built-in wins
 * under the existing conflict resolution rule).
 *
 * Safe to call multiple times — subsequent calls are no-ops because the
 * conflict guard in `registerPluginViews` keeps the first registration.
 */
export function registerBuiltinViews(): void {
  const loadedAt = Date.now();
  const pluginName = "@elizaos/builtin";
  for (const view of BUILTIN_VIEWS) {
    if (registry.has(view.id)) {
      // Already registered (e.g. called twice at startup). Skip silently.
      continue;
    }
    const platform: AgentPlatform =
      (view.platforms?.[0] as AgentPlatform | undefined) ?? "web";
    const entry: ViewRegistryEntry = {
      ...view,
      pluginName,
      pluginDir: undefined,
      bundleUrl: undefined,
      bundleUrlVersioned: undefined,
      heroImageUrl: `/api/views/${encodeURIComponent(view.id)}/hero`,
      available: true,
      loadedAt,
      platform,
      builtin: true,
    };
    registry.set(view.id, entry);
  }
  logger.info(
    { src: "ViewRegistry", count: BUILTIN_VIEWS.length },
    `[ViewRegistry] Registered ${BUILTIN_VIEWS.length} built-in views`,
  );
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
export function getView(id: string): ViewRegistryEntry | undefined {
  return registry.get(id);
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

  // Check bundle availability and collect hash + size when resolvable.
  let available = false;
  let bundleHash: string | undefined;
  let bundleSize: number | undefined;
  if (pluginDir && view.bundlePath) {
    const bundleAbs = path.resolve(pluginDir, view.bundlePath);
    const packageRoot = `${path.resolve(pluginDir)}${path.sep}`;
    if (bundleAbs.startsWith(packageRoot)) {
      available = await fileExists(bundleAbs);
      if (available) {
        const [hash, stat] = await Promise.all([
          computeBundleHash(bundleAbs),
          fs.stat(bundleAbs).catch(() => null),
        ]);
        if (hash) bundleHash = hash;
        if (stat) bundleSize = stat.size;

        // Log bundle size; warn when it exceeds 500 KB.
        const sizeKb = stat ? stat.size / 1024 : 0;
        if (stat && stat.size > 512 * 1024) {
          logger.warn(
            { src: "ViewRegistry", viewId: view.id, sizeKb: sizeKb.toFixed(0) },
            `[ViewRegistry] View ${view.id} bundle is large (${sizeKb.toFixed(0)}KB) — consider code splitting`,
          );
        } else if (stat) {
          logger.info(
            { src: "ViewRegistry", viewId: view.id, sizeKb: sizeKb.toFixed(1) },
            `[ViewRegistry] Registered view ${view.id} — bundle: ${sizeKb.toFixed(1)}KB`,
          );
        }
      }
    }
  }

  const encodedId = encodeURIComponent(view.id);
  // bundleUrl uses a timestamp ?v= param for backwards-compat; bundleUrlVersioned
  // uses the content hash when available (allows immutable long-lived caching).
  const bundleUrl = view.bundlePath
    ? `/api/views/${encodedId}/bundle.js?v=${loadedAt}`
    : undefined;
  const bundleUrlVersioned =
    view.bundlePath && bundleHash
      ? `/api/views/${encodedId}/bundle.js?v=${bundleHash}`
      : bundleUrl;

  const heroImageUrl = `/api/views/${encodedId}/hero`;

  // Derive a representative platform from the declaration's platforms list.
  // When multiple platforms are declared, the first entry wins. Absent the
  // field, treat the view as "web" (no platform restriction).
  const platform: AgentPlatform =
    (view.platforms?.[0] as AgentPlatform | undefined) ?? "web";

  return {
    ...view,
    pluginName,
    pluginDir,
    bundleUrl,
    bundleUrlVersioned,
    heroImageUrl,
    available,
    loadedAt,
    platform,
    bundleHash,
    bundleSize,
  };
}
