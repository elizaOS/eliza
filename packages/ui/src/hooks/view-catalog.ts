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

import {
  dedupeModalities,
  type EnabledViewKinds,
  isViewVisible,
  type ViewKind,
} from "@elizaos/core";
import type { RegistryAppInfo } from "../api";
import { resolveViewIconId } from "../components/views/view-icon-aliases";
import { viewIconDataUri } from "../components/views/view-icons.generated";
import type { ViewModality } from "../platform/platform-guards";
import type { ViewRegistryEntry } from "./useAvailableViews";

function isShellReachableImageUrl(
  value: string | null | undefined,
): value is string {
  if (!value) return false;
  return /^(https?:\/\/|data:image\/|blob:)/i.test(value);
}

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
  /**
   * Always-available preview image URL. Real plugin art wins only when the
   * registry says that asset exists; otherwise this is a deterministic branded
   * SVG data URI, not a backend hero endpoint probe.
   */
  imageUrl?: string;
  /** Deterministic branded image used when a real preview image fails to load. */
  fallbackImageUrl?: string;
  hasHero: boolean;
  category?: string;
  /** Presentation modality (`gui` for catalog apps until loaded). */
  modality: ViewModality;
  /**
   * Every surface this logical view renders on. A single-declaration entry has
   * `[modality]`; after {@link collapseViewEntries} it carries the union of all
   * same-id declarations (e.g. `["gui", "xr", "tui"]`) so the view lists once
   * with modality badges instead of one duplicate row per surface.
   */
  modalities?: ViewModality[];
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
  /** Four-tier visibility category resolved from the source declaration. */
  viewKind?: ViewKind;
  /** Sort priority for launcher/nav surfaces (lower = earlier). */
  order?: number;
  /** Optional named group shared with app-shell page registrations. */
  group?: string;
  /** Source records (one is set depending on `kind`). */
  view?: ViewRegistryEntry;
  app?: RegistryAppInfo;
}

/** Minimal shape of an installed/active app entry the merge needs. */
export interface InstalledAppLike {
  name: string;
}

export function viewToEntry(view: ViewRegistryEntry): ViewEntry {
  const heroUrl = isShellReachableImageUrl(view.heroImageUrl)
    ? view.heroImageUrl
    : undefined;
  const hasHero = Boolean(view.hasHeroImage && heroUrl);
  const bundledIcon = viewIconDataUri(resolveViewIconId(view.id));
  const fallbackIcon = viewIconDataUri("default") || bundledIcon;
  return {
    key: `view:${view.id}`,
    id: view.id,
    label: view.label,
    description: view.description,
    icon: view.icon,
    heroUrl: hasHero ? heroUrl : undefined,
    // Use a registry hero only when it is declared as real and reachable from
    // this shell. Otherwise use the bundled PNG icon baked into the JS bundle,
    // never a root-relative `/api/views/:id/hero` probe that native shells 404.
    imageUrl: hasHero ? heroUrl : bundledIcon,
    fallbackImageUrl: fallbackIcon,
    hasHero: hasHero || Boolean(bundledIcon),
    modality: view.viewType ?? "gui",
    modalities: [view.viewType ?? "gui"],
    state: "loaded",
    kind: "view",
    pluginName: view.pluginName,
    path: view.path,
    builtin: view.builtin,
    developerOnly: view.developerOnly,
    viewKind: view.viewKind,
    order: view.order,
    group: view.group,
    view,
  };
}

function appToEntry(app: RegistryAppInfo, isActive: boolean): ViewEntry {
  const label = app.displayName || app.name;
  const heroUrl = isShellReachableImageUrl(app.heroImage)
    ? app.heroImage
    : undefined;
  const hasHero = Boolean(heroUrl);
  const bundledIcon = viewIconDataUri(resolveViewIconId(app.name));
  return {
    key: `app:${app.name}`,
    id: app.name,
    label,
    description: app.description,
    icon: app.icon ?? undefined,
    heroUrl,
    imageUrl: heroUrl ?? bundledIcon,
    fallbackImageUrl: bundledIcon,
    hasHero: hasHero || Boolean(bundledIcon),
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
    viewKind: app.viewKind,
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
  /** Which view kinds the user/​build has enabled (system+release always on). */
  enabledKinds: EnabledViewKinds;
}): ViewEntry[] {
  const { views, catalog, installed, activeModality, enabledKinds } = input;

  const loadedPluginNames = new Set<string>();
  for (const v of views) {
    if (v.pluginName) loadedPluginNames.add(v.pluginName);
  }

  const viewEntries: ViewEntry[] = [];
  for (const v of views) {
    if (!isViewVisible(v, enabledKinds)) continue;
    if (v.visibleInManager === false) continue;
    if ((v.viewType ?? "gui") !== activeModality) continue;
    viewEntries.push(viewToEntry(v));
  }

  if (activeModality !== "gui") return viewEntries;

  const activeAppNames = new Set(installed.map((a) => a.name));
  const seen = new Set(viewEntries.map((e) => e.id));
  const catalogEntries: ViewEntry[] = [];
  for (const app of catalog) {
    if (!isViewVisible(app, enabledKinds)) continue;
    if (app.visibleInAppStore === false) continue;
    // Already shown as a loaded view → don't double-list as a catalog card.
    if (loadedPluginNames.has(app.name)) continue;
    if (seen.has(app.name)) continue;
    seen.add(app.name);
    catalogEntries.push(appToEntry(app, activeAppNames.has(app.name)));
  }

  return [...viewEntries, ...catalogEntries];
}

/**
 * Collapse entries that share an `id` into one logical entry carrying the union
 * of every surface they render on. The GUI entry is preferred as the base (its
 * label has no "XR"/"TUI" suffix); its `modalities` becomes the deduped union of
 * all same-id entries. First-seen order is preserved. App entries (`kind:"app"`)
 * have unique package-name ids, so they collapse to themselves.
 *
 * This is what makes a view appear ONCE with modality badges instead of one
 * duplicate row per surface ("Phone" / "Phone XR" / "Phone TUI").
 */
export function collapseViewEntries(entries: ViewEntry[]): ViewEntry[] {
  const order: string[] = [];
  const byId = new Map<string, ViewEntry>();
  for (const entry of entries) {
    const mods = entry.modalities ?? [entry.modality];
    const existing = byId.get(entry.id);
    if (!existing) {
      order.push(entry.id);
      byId.set(entry.id, { ...entry, modalities: dedupeModalities(mods) });
      continue;
    }
    const merged = dedupeModalities([
      ...(existing.modalities ?? [existing.modality]),
      ...mods,
    ]);
    // Prefer the gui entry as the canonical base (clean label, no surface
    // suffix); otherwise keep the first-seen entry.
    const base =
      entry.modality === "gui" && existing.modality !== "gui"
        ? entry
        : existing;
    byId.set(entry.id, { ...base, modalities: merged });
  }
  return order.map((id) => byId.get(id) as ViewEntry);
}
