/**
 * Unify loaded views with the installable app catalog into one launcher model.
 *
 * The `/views` surface shows a single grid where every entry is a "view":
 *  - **loaded** — its plugin is registered, so the view renders now → "Open".
 *  - **available** — it exists in the catalog (scanned from plugin manifests on
 *    disk, no plugin load required) but isn't loaded yet → "Get" (load/install).
 *
 * The catalog ({@link RegistryAppInfo}) is sourced from `/api/apps`, which the
 * agent builds by reading each plugin's `package.json` `elizaos.app` manifest —
 * so titles, categories, and hero images are available without importing the
 * plugin. Loading happens on demand; until then the entry is a card with a
 * Get button.
 *
 * This module is the pure merge/dedupe so it can be unit-tested without React.
 */

import type { RegistryAppInfo } from "../api";
import type { ViewModality } from "../platform/platform-guards";
import type { ViewRegistryEntry } from "./useAvailableViews";

export type { ViewModality } from "../platform/platform-guards";

export type ViewEntryState = "loaded" | "available" | "installing" | "error";
export type ViewEntryKind = "view" | "app";

export interface ViewEntry {
  /** Stable React key, unique across kinds (`view:<id>` / `app:<name>`). */
  key: string;
  /** Display/navigation id (view id or app package name). */
  id: string;
  label: string;
  description?: string;
  /** Lucide icon name or image URL/data-URI. */
  icon?: string;
  /** Real preview image URL, or undefined when only a generated fallback exists. */
  heroUrl?: string;
  hasHero: boolean;
  category?: string;
  /** Presentation modality (`gui` for catalog apps until loaded). */
  modality: ViewModality;
  state: ViewEntryState;
  kind: ViewEntryKind;
  /** Catalog/plugin package name — used to launch and to dedupe vs loaded. */
  appName?: string;
  pluginName?: string;
  /** Navigation path for a loaded view. */
  path?: string;
  /** How an app launches (`overlay` | `game` | `page` | `connect` | …). */
  launchType?: string;
  launchUrl?: string | null;
  builtin?: boolean;
  developerOnly?: boolean;
  /** Source records (one is set depending on `kind`). */
  view?: ViewRegistryEntry;
  app?: RegistryAppInfo;
}

/** Minimal shape of an installed/active app entry the merge needs. */
export interface InstalledAppLike {
  name: string;
}

function viewToEntry(view: ViewRegistryEntry): ViewEntry {
  const hasHero = Boolean(view.hasHeroImage && view.heroImageUrl);
  return {
    key: `view:${view.id}`,
    id: view.id,
    label: view.label,
    description: view.description,
    icon: view.icon,
    heroUrl: hasHero ? view.heroImageUrl : undefined,
    hasHero,
    modality: view.viewType ?? "gui",
    state: "loaded",
    kind: "view",
    pluginName: view.pluginName,
    path: view.path,
    builtin: view.builtin,
    developerOnly: view.developerOnly,
    view,
  };
}

function appToEntry(app: RegistryAppInfo, isActive: boolean): ViewEntry {
  const hasHero = Boolean(app.heroImage);
  return {
    key: `app:${app.name}`,
    id: app.name,
    label: app.displayName || app.name,
    description: app.description,
    icon: app.icon ?? undefined,
    heroUrl: app.heroImage ?? undefined,
    hasHero,
    category: app.category,
    // Catalog cards are a GUI install surface; the loaded view carries the real
    // modality once the plugin registers.
    modality: "gui",
    state: isActive ? "loaded" : "available",
    kind: "app",
    appName: app.name,
    pluginName: app.name,
    launchType: app.launchType,
    launchUrl: app.launchUrl,
    developerOnly: app.developerOnly,
    app,
  };
}

/**
 * Merge loaded views + the app catalog into one deduped launcher list.
 *
 * - Loaded views in the active modality become "Open" entries.
 * - Catalog apps whose plugin is NOT already represented by a loaded view are
 *   appended as "Get" (or "Open" when active but viewless, e.g. external apps).
 * - The catalog is only surfaced on a GUI surface — installing is a GUI action;
 *   TUI/XR surfaces list only their loaded views.
 */
export function mergeViewCatalog(input: {
  views: ViewRegistryEntry[];
  catalog: RegistryAppInfo[];
  installed: readonly InstalledAppLike[];
  activeModality: ViewModality;
  isDeveloperMode: boolean;
}): ViewEntry[] {
  const { views, catalog, installed, activeModality, isDeveloperMode } = input;

  const loadedPluginNames = new Set<string>();
  for (const v of views) {
    if (v.pluginName) loadedPluginNames.add(v.pluginName);
  }

  const viewEntries: ViewEntry[] = [];
  for (const v of views) {
    if (v.developerOnly && !isDeveloperMode) continue;
    if (v.visibleInManager === false) continue;
    if ((v.viewType ?? "gui") !== activeModality) continue;
    viewEntries.push(viewToEntry(v));
  }

  if (activeModality !== "gui") return viewEntries;

  const activeAppNames = new Set(installed.map((a) => a.name));
  const seen = new Set(viewEntries.map((e) => e.id));
  const catalogEntries: ViewEntry[] = [];
  for (const app of catalog) {
    if (app.developerOnly && !isDeveloperMode) continue;
    if (app.visibleInAppStore === false) continue;
    // Already shown as a loaded view → don't double-list as a catalog card.
    if (loadedPluginNames.has(app.name)) continue;
    if (seen.has(app.name)) continue;
    seen.add(app.name);
    catalogEntries.push(appToEntry(app, activeAppNames.has(app.name)));
  }

  return [...viewEntries, ...catalogEntries];
}
