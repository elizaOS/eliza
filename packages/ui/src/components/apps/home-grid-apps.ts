import type { ViewRegistryEntry } from "../../hooks/useAvailableViews";
import type { Tab } from "../../navigation";
import type { AppIdentitySource } from "./app-identity";
import {
  getInternalToolApps,
  getInternalToolAppTargetTab,
  getPinnableInternalAppNames,
} from "./internal-tool-apps";

/** A homescreen launcher tile: app identity plus where tapping it navigates. */
export interface HomeGridApp extends AppIdentitySource {
  targetTab: Tab;
}

/**
 * The internal-tool apps that can be pinned to the homescreen. Derived from the
 * `pinnable` flag declared on each internal-tool ViewDeclaration — none are
 * pinned by default, this is the full catalog available for pinning.
 */
export function getPinnableInternalApps(): readonly string[] {
  return getPinnableInternalAppNames();
}

/** The 4 tiles pinned to the homescreen by default. */
const DEFAULT_PINNED_APPS: readonly HomeGridApp[] = [
  {
    name: "core/messages",
    displayName: "Messages",
    category: "utility",
    targetTab: "messages",
  },
  {
    name: "core/documents",
    displayName: "Documents",
    category: "utility",
    targetTab: "documents",
  },
  {
    name: "core/views",
    displayName: "Views",
    category: "utility",
    targetTab: "views",
  },
  {
    name: "core/settings",
    displayName: "Settings",
    category: "utility",
    targetTab: "settings",
  },
];

/**
 * Returns the homescreen launcher grid: the 4 default-pinned tiles, followed
 * by any user-pinned internal-tool apps (supplied via `pinnedNames`).
 *
 * When `pinnedNames` is empty (default), only the 4 defaults are shown.
 */
export function getHomeGridApps(
  pinnedNames: readonly string[] = [],
  networkViews: readonly ViewRegistryEntry[] = [],
): HomeGridApp[] {
  if (pinnedNames.length === 0) return [...DEFAULT_PINNED_APPS];

  const byName = new Map(
    getInternalToolApps(networkViews).map((app) => [app.name, app]),
  );
  const pinned: HomeGridApp[] = [];
  for (const name of pinnedNames) {
    const app = byName.get(name);
    const targetTab = getInternalToolAppTargetTab(name);
    if (!app || !targetTab) continue;
    pinned.push({
      name: app.name,
      displayName: app.displayName,
      category: app.category,
      heroImage: app.heroImage,
      icon: app.icon,
      description: app.description,
      targetTab,
    });
  }
  return [...DEFAULT_PINNED_APPS, ...pinned];
}
