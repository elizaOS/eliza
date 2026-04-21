import {
  getElizaCuratedAppCatalogOrder,
  isElizaCuratedAppName,
  normalizeElizaCuratedAppName,
  packageNameToAppRouteSlug,
} from "@elizaos/shared/contracts/apps";
import type { RegistryAppInfo } from "../../api";
import {
  getInternalToolAppCatalogOrder,
  isInternalToolApp,
} from "./internal-tool-apps";

export const DEFAULT_VIEWER_SANDBOX =
  "allow-scripts allow-same-origin allow-popups";

export const CATEGORY_LABELS: Record<string, string> = {
  game: "Game",
  social: "Social",
  platform: "Platform",
  world: "World",
  utility: "Utility",
};

export type AppCatalogSectionKey =
  | "favorites"
  | "games"
  | "developerUtilities"
  | "finance"
  | "lifeManagement"
  | "other";

export const APP_CATALOG_SECTION_LABELS: Record<AppCatalogSectionKey, string> =
  {
    favorites: "Favorites",
    games: "Games & Entertainment",
    developerUtilities: "Developer Utilities",
    finance: "Finance",
    lifeManagement: "Life Management",
    other: "Other",
  };

const APP_CATALOG_SECTION_ORDER: readonly AppCatalogSectionKey[] = [
  "favorites",
  "games",
  "finance",
  "lifeManagement",
  "developerUtilities",
  "other",
];

export interface AppCatalogSection {
  key: AppCatalogSectionKey;
  label: string;
  apps: RegistryAppInfo[];
}

const SESSION_MODE_LABELS: Record<string, string> = {
  "spectate-and-steer": "Spectate + steer",
};

const SESSION_FEATURE_LABELS: Record<string, string> = {
  commands: "Commands",
  telemetry: "Telemetry",
  pause: "Pause",
  resume: "Resume",
  suggestions: "Suggestions",
};

interface AppsCatalogFilterOptions {
  activeAppNames?: ReadonlySet<string>;
  isProd?: boolean;
  searchQuery?: string;
  showActiveOnly?: boolean;
}

export function isCuratedGameApp(
  app: Pick<RegistryAppInfo, "category" | "name">,
): boolean {
  void app.category;
  return isElizaCuratedAppName(app.name);
}

export function shouldShowAppInAppsView(
  app: Pick<RegistryAppInfo, "category" | "name">,
  isProd: boolean = typeof import.meta.env.PROD === "boolean"
    ? import.meta.env.PROD
    : Boolean(import.meta.env.PROD),
): boolean {
  void isProd;
  return isInternalToolApp(app.name) || isCuratedGameApp(app);
}

export function filterAppsForCatalog(
  apps: RegistryAppInfo[],
  {
    activeAppNames = new Set<string>(),
    isProd,
    searchQuery = "",
    showActiveOnly = false,
  }: AppsCatalogFilterOptions = {},
): RegistryAppInfo[] {
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const seenCanonicalNames = new Set<string>();
  const sortedApps = [...apps].sort((left, right) => {
    const toolOrderDiff =
      getInternalToolAppCatalogOrder(left.name) -
      getInternalToolAppCatalogOrder(right.name);
    if (toolOrderDiff !== 0) {
      return toolOrderDiff;
    }

    const orderDiff =
      getElizaCuratedAppCatalogOrder(left.name) -
      getElizaCuratedAppCatalogOrder(right.name);
    if (orderDiff !== 0) {
      return orderDiff;
    }

    const leftCanonicalName = normalizeElizaCuratedAppName(left.name);
    const rightCanonicalName = normalizeElizaCuratedAppName(right.name);
    const leftCanonicalPenalty = left.name === leftCanonicalName ? 0 : 1;
    const rightCanonicalPenalty = right.name === rightCanonicalName ? 0 : 1;
    if (leftCanonicalPenalty !== rightCanonicalPenalty) {
      return leftCanonicalPenalty - rightCanonicalPenalty;
    }

    return (right.stars ?? 0) - (left.stars ?? 0);
  });

  return sortedApps.filter((app) => {
    if (!shouldShowAppInAppsView(app, isProd)) {
      return false;
    }
    const sectionLabel = getAppCatalogSectionLabel(app).toLowerCase();
    if (
      normalizedSearch &&
      !app.name.toLowerCase().includes(normalizedSearch) &&
      !(app.displayName ?? "").toLowerCase().includes(normalizedSearch) &&
      !(app.description ?? "").toLowerCase().includes(normalizedSearch) &&
      !(app.category ?? "").toLowerCase().includes(normalizedSearch) &&
      !sectionLabel.includes(normalizedSearch)
    ) {
      return false;
    }
    if (showActiveOnly && !activeAppNames.has(app.name)) {
      return false;
    }
    const canonicalName = isInternalToolApp(app.name)
      ? app.name
      : (normalizeElizaCuratedAppName(app.name) ?? app.name);
    if (seenCanonicalNames.has(canonicalName)) {
      return false;
    }
    seenCanonicalNames.add(canonicalName);
    return true;
  });
}

export function getDefaultAppsCatalogSelection(
  apps: RegistryAppInfo[],
  isProd: boolean = typeof import.meta.env.PROD === "boolean"
    ? import.meta.env.PROD
    : Boolean(import.meta.env.PROD),
): string | null {
  return (
    filterAppsForCatalog(apps, {
      isProd,
    })[0]?.name ?? null
  );
}

export function getAppCatalogSectionKey(
  app: Pick<
    RegistryAppInfo,
    "name" | "displayName" | "description" | "category"
  >,
): AppCatalogSectionKey {
  if (app.name === "@elizaos/app-lifeops") {
    return "lifeManagement";
  }

  if (isInternalToolApp(app.name)) {
    return "developerUtilities";
  }

  const canonicalName = normalizeElizaCuratedAppName(app.name) ?? app.name;
  switch (canonicalName) {
    case "@elizaos/app-companion":
      return "games";
    case "@elizaos/app-vincent":
    case "@elizaos/app-shopify":
      return "finance";
    case "@elizaos/app-babylon":
      return "games";
    case "@hyperscape/plugin-hyperscape":
    case "@elizaos/app-2004scape":
    case "@elizaos/app-scape":
    case "@elizaos/app-defense-of-the-agents":
    case "@clawville/app-clawville":
      return "games";
  }

  const normalizedCategory = app.category.trim().toLowerCase();
  if (normalizedCategory === "game") {
    return "games";
  }
  if (normalizedCategory === "utility") {
    return "developerUtilities";
  }
  if (normalizedCategory === "social" || normalizedCategory === "world") {
    return "games";
  }
  if (normalizedCategory === "platform") {
    return "finance";
  }

  const searchBlob = [
    app.name,
    app.displayName ?? "",
    app.description ?? "",
    app.category,
  ]
    .join(" ")
    .toLowerCase();

  if (
    /calendar|task|inbox|lifeops|reminder|routine|planning|productivity/.test(
      searchBlob,
    )
  ) {
    return "lifeManagement";
  }
  if (/companion|avatar|assistant|friend|chat|social/.test(searchBlob)) {
    return "games";
  }
  if (
    /commerce|shop|store|finance|wallet|market|trade|sales|business|team/.test(
      searchBlob,
    )
  ) {
    return "finance";
  }
  if (
    /debug|viewer|plugin|skill|memory|trajectory|runtime|database|log|sql/.test(
      searchBlob,
    )
  ) {
    return "developerUtilities";
  }

  return "other";
}

export function getAppCatalogSectionLabel(
  app: Pick<
    RegistryAppInfo,
    "name" | "displayName" | "description" | "category"
  >,
): string {
  return APP_CATALOG_SECTION_LABELS[getAppCatalogSectionKey(app)];
}

export function groupAppsForCatalog(
  apps: RegistryAppInfo[],
  favoriteAppNames: ReadonlySet<string> = new Set(),
): AppCatalogSection[] {
  const groupedApps = new Map<AppCatalogSectionKey, RegistryAppInfo[]>();

  for (const app of apps) {
    if (favoriteAppNames.has(app.name)) {
      const favApps = groupedApps.get("favorites") ?? [];
      favApps.push(app);
      groupedApps.set("favorites", favApps);
    }
    const sectionKey = getAppCatalogSectionKey(app);
    const sectionApps = groupedApps.get(sectionKey) ?? [];
    sectionApps.push(app);
    groupedApps.set(sectionKey, sectionApps);
  }

  return APP_CATALOG_SECTION_ORDER.flatMap((key) => {
    const sectionApps = groupedApps.get(key) ?? [];
    if (sectionApps.length === 0) {
      return [];
    }

    return [
      {
        key,
        label: APP_CATALOG_SECTION_LABELS[key],
        apps: sectionApps,
      } satisfies AppCatalogSection,
    ];
  });
}

export function getAppShortName(app: RegistryAppInfo): string {
  const display = app.displayName ?? app.name;
  const clean = display.replace(/^@[^/]+\/app-/, "");
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

export function getAppEmoji(app: RegistryAppInfo): string {
  const sectionKey = getAppCatalogSectionKey(app);
  if (sectionKey === "games") return "🎮";
  if (sectionKey === "developerUtilities") return "🛠️";
  if (sectionKey === "finance") return "💰";
  if (sectionKey === "lifeManagement") return "🗓️";
  return "📦";
}

export function getAppSessionModeLabel(
  app: Pick<RegistryAppInfo, "session">,
): string | null {
  const mode = app.session?.mode;
  if (!mode) return null;
  return SESSION_MODE_LABELS[mode] ?? mode;
}

export function getAppSessionFeatureLabels(
  app: Pick<RegistryAppInfo, "session">,
): string[] {
  return (app.session?.features ?? []).map(
    (feature) => SESSION_FEATURE_LABELS[feature] ?? feature,
  );
}

/* ── App URL slugs ──────────────────────────────────────────────────── */

/**
 * Derive a URL slug from an app's package name.
 *
 * Uses the existing `packageNameToAppRouteSlug` for scoped packages
 * (`@scope/app-foo` → `foo`, `@scope/plugin-bar` → `bar`).
 * Falls back to a sanitised form of the raw name.
 */
export function getAppSlug(appName: string): string {
  const slug = packageNameToAppRouteSlug(appName);
  if (slug) return slug;
  // Fallback: strip leading scope, common prefixes, then sanitise
  return (
    appName
      .replace(/^@[^/]+\//, "")
      .replace(/^(app|plugin)-/, "")
      .replace(/[^a-z0-9-]/gi, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || appName
  );
}

/** Find an app by its URL slug. */
export function findAppBySlug(
  apps: readonly RegistryAppInfo[],
  slug: string,
): RegistryAppInfo | undefined {
  const normalizedSlug = slug.toLowerCase();
  return apps.find(
    (app) => getAppSlug(app.name).toLowerCase() === normalizedSlug,
  );
}
