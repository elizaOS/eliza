import type { Tab } from "../../navigation";
import type { AppIdentitySource } from "./app-identity";
import {
  getInternalToolApps,
  getInternalToolAppTargetTab,
} from "./internal-tool-apps";

/** A homescreen launcher tile: app identity plus where tapping it navigates. */
export interface HomeGridApp extends AppIdentitySource {
  targetTab: Tab;
}

// The internal-tool apps we feature on the homescreen, in display order. These
// ship real hero artwork, resolved by AppIdentityTile.
const FEATURED_INTERNAL_APPS: readonly string[] = [
  "@elizaos/plugin-lifeops",
  "@elizaos/plugin-task-coordinator",
  "@elizaos/plugin-steward-app",
  "@elizaos/plugin-elizamaker",
  "@elizaos/app-skills-viewer",
  "@elizaos/app-memory-viewer",
  "@elizaos/app-plugin-viewer",
  "@elizaos/plugin-training",
  "@elizaos/app-relationship-viewer",
  "@elizaos/app-trajectory-viewer",
  "@elizaos/app-database-viewer",
  "@elizaos/app-runtime-debugger",
  "@elizaos/app-log-viewer",
];

// Core product surfaces shown as launcher tiles. They have no bundled hero art,
// so AppIdentityTile renders its generated gradient tile (distinct per name).
const CORE_APPS: readonly HomeGridApp[] = [
  {
    name: "core/chat",
    displayName: "Chat",
    category: "utility",
    targetTab: "chat",
  },
  {
    name: "core/voice",
    displayName: "Voice",
    category: "utility",
    targetTab: "voice",
  },
  {
    name: "core/character",
    displayName: "Character",
    category: "utility",
    targetTab: "character",
  },
  {
    name: "core/browser",
    displayName: "Browser",
    category: "utility",
    targetTab: "browser",
  },
  {
    name: "core/messages",
    displayName: "Messages",
    category: "utility",
    targetTab: "messages",
  },
  {
    name: "core/contacts",
    displayName: "Contacts",
    category: "utility",
    targetTab: "contacts",
  },
  {
    name: "core/documents",
    displayName: "Documents",
    category: "utility",
    targetTab: "documents",
  },
  {
    name: "core/stream",
    displayName: "Stream",
    category: "utility",
    targetTab: "stream",
  },
  {
    name: "core/triggers",
    displayName: "Triggers",
    category: "utility",
    targetTab: "triggers",
  },
  {
    name: "core/apps",
    displayName: "Apps",
    category: "utility",
    targetTab: "apps",
  },
  {
    name: "core/settings",
    displayName: "Settings",
    category: "utility",
    targetTab: "settings",
  },
];

/**
 * The curated 4×6 (24-tile) homescreen launcher grid: the featured internal-tool
 * apps (with hero art) followed by the core product surfaces.
 */
export function getHomeGridApps(): HomeGridApp[] {
  const byName = new Map(getInternalToolApps().map((app) => [app.name, app]));
  const featured: HomeGridApp[] = [];
  for (const name of FEATURED_INTERNAL_APPS) {
    const app = byName.get(name);
    const targetTab = getInternalToolAppTargetTab(name);
    if (!app || !targetTab) continue;
    featured.push({
      name: app.name,
      displayName: app.displayName,
      category: app.category,
      heroImage: app.heroImage,
      icon: app.icon,
      description: app.description,
      targetTab,
    });
  }
  return [...featured, ...CORE_APPS];
}
