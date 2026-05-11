import {
  getElizaCuratedAppCatalogOrder,
  isElizaCuratedAppName,
  normalizeElizaCuratedAppName,
  packageNameToAppRouteSlug,
} from "@elizaos/shared";
import type { RegistryAppInfo } from "../../api";
import { getBootConfig } from "../../config/boot-config-store";
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
  | "featured"
  | "favorites"
  | "games"
  | "developerUtilities"
  | "finance"
  | "other";

export const APP_CATALOG_SECTION_LABELS: Record<AppCatalogSectionKey, string> =
  {
    featured: "Featured",
    favorites: "Starred",
    games: "Games & Entertainment",
    developerUtilities: "Developer Utilities",
    finance: "Finance",
    other: "Other",
  };

export const APPS_VIEW_HIDDEN_APP_NAMES = [
  "@elizaos/app",
  "@elizaos/browser-bridge-extension",
  "app-counter",
  "@elizaos/plugin-form",
  "@elizaos/app-documents",
  "@elizaos/app-screenshare",
  "@elizaos/app-task-coordinator",
  // Shared wallet/inventory system package — provides components used by the
  // app shell, not a standalone installable app.
  "@elizaos/app-wallet",
] as const;

const APPS_VIEW_HIDDEN_APP_NAME_SET = new Set<string>(
  APPS_VIEW_HIDDEN_APP_NAMES,
);

const FEATURED_APP_NAMES = new Set<string>([
  "@elizaos/app-lifeops",
  "@elizaos/app-companion",
  "@elizaos/app-defense-of-the-agents",
  "@elizaos/app-clawville",
]);

const DEFAULT_VISIBLE_GAME_APP_NAMES = new Set<string>([
  "@elizaos/app-companion",
  "@elizaos/app-defense-of-the-agents",
  "@elizaos/app-clawville",
]);

const DEFAULT_HIDDEN_APP_NAMES = new Set<string>([
  "@elizaos/app-elizamaker",
  "@elizaos/app-hyperliquid",
  "@elizaos/app-polymarket",
  "@elizaos/app-shopify",
  "@elizaos/app-steward",
  "@elizaos/app-vincent",
]);

const WALLET_SCOPED_APP_NAMES = new Set<string>([
  "@elizaos/app-hyperliquid",
  "@elizaos/app-polymarket",
  "@elizaos/app-vincent",
]);

const APP_CATALOG_SECTION_ORDER: readonly AppCatalogSectionKey[] = [
  "featured",
  "favorites",
  "games",
  "finance",
  "developerUtilities",
  "other",
];

function getConfiguredDefaultAppNames(): ReadonlySet<string> {
  return new Set(
    (getBootConfig().defaultApps ?? []).filter(
      (name): name is string => typeof name === "string" && name.length > 0,
    ),
  );
}

function isFeaturedAppName(name: string): boolean {
  return (
    FEATURED_APP_NAMES.has(name) || getConfiguredDefaultAppNames().has(name)
  );
}

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
  showAllApps?: boolean;
  showActiveOnly?: boolean;
  walletEnabled?: boolean;
  /**
   * When false (or omitted), apps marked `developerOnly: true` are hidden.
   * Pass the current value from `useIsDeveloperMode()` to opt in.
   */
  developerMode?: boolean;
}

function parseBooleanEnvValue(value: unknown): boolean {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function shouldShowAllApps(showAllApps?: boolean): boolean {
  if (typeof showAllApps === "boolean") {
    return showAllApps;
  }
  return parseBooleanEnvValue(import.meta.env.VITE_PUBLIC_SHOW_ALL_APPS);
}

export function isHiddenFromAppsView(appName: string): boolean {
  return APPS_VIEW_HIDDEN_APP_NAME_SET.has(appName);
}

export function isCuratedGameApp(
  app: Pick<RegistryAppInfo, "category" | "name">,
): boolean {
  void app.category;
  return isElizaCuratedAppName(app.name);
}

export function shouldShowAppInAppsView(
  app: Pick<RegistryAppInfo, "category" | "name">,
  options: {
    isProd?: boolean;
    showAllApps?: boolean;
    walletEnabled?: boolean;
  } = {},
): boolean {
  const {
    isProd = typeof import.meta.env.PROD === "boolean"
      ? import.meta.env.PROD
      : Boolean(import.meta.env.PROD),
    showAllApps,
    walletEnabled = false,
  } = options;
  void isProd;
  if (isHiddenFromAppsView(app.name)) {
    return false;
  }
  const configuredDefaultAppNames = getConfiguredDefaultAppNames();
  if (
    !configuredDefaultAppNames.has(app.name) &&
    !isInternalToolApp(app.name) &&
    !isCuratedGameApp(app)
  ) {
    return false;
  }

  if (shouldShowAllApps(showAllApps)) {
    return true;
  }

  const canonicalName = isInternalToolApp(app.name)
    ? app.name
    : (normalizeElizaCuratedAppName(app.name) ?? app.name);
  const sectionKey = getAppCatalogSectionKey({
    name: app.name,
    category: app.category,
    displayName: "",
    description: "",
  });

  if (
    DEFAULT_HIDDEN_APP_NAMES.has(canonicalName) &&
    !(walletEnabled && WALLET_SCOPED_APP_NAMES.has(canonicalName)) &&
    !configuredDefaultAppNames.has(app.name) &&
    !configuredDefaultAppNames.has(canonicalName)
  ) {
    return false;
  }

  if (sectionKey === "games") {
    return (
      DEFAULT_VISIBLE_GAME_APP_NAMES.has(canonicalName) ||
      configuredDefaultAppNames.has(app.name) ||
      configuredDefaultAppNames.has(canonicalName)
    );
  }

  return true;
}

export function filterAppsForCatalog(
  apps: RegistryAppInfo[],
  {
    activeAppNames = new Set<string>(),
    isProd,
    searchQuery = "",
    showAllApps,
    showActiveOnly = false,
    walletEnabled,
    developerMode = false,
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
    if (!shouldShowAppInAppsView(app, { isProd, showAllApps, walletEnabled })) {
      return false;
    }
    // Developer-only apps are hidden unless Developer Mode is on.
    // TODO: server-side population pending — `developerOnly` is declared in
    // PluginApp but not yet plumbed through `RegistryAppInfo` API responses.
    if (app.developerOnly && !developerMode) {
      return false;
    }
    // Apps that opt out of the catalog are always hidden, regardless of
    // Developer Mode (use deep-link / auto-install paths instead).
    // TODO: server-side population pending — see `developerOnly` note above.
    if (app.visibleInAppStore === false) {
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
  options: {
    isProd?: boolean;
    showAllApps?: boolean;
    walletEnabled?: boolean;
  } = {},
): string | null {
  return (
    filterAppsForCatalog(apps, {
      ...options,
    })[0]?.name ?? null
  );
}

export function getAppCatalogSectionKey(
  app: Pick<
    RegistryAppInfo,
    "name" | "displayName" | "description" | "category"
  >,
): AppCatalogSectionKey {
  if (isFeaturedAppName(app.name)) {
    return "featured";
  }

  if (
    app.name === "@elizaos/app-steward" ||
    app.name === "@elizaos/app-elizamaker"
  ) {
    return "finance";
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
    case "@elizaos/app-hyperliquid":
    case "@elizaos/app-polymarket":
      return "finance";
    case "@elizaos/app-babylon":
      return "games";
    case "@hyperscape/plugin-hyperscape":
    case "@elizaos/app-hyperscape":
    case "@elizaos/app-2004scape":
    case "@elizaos/app-scape":
    case "@elizaos/app-defense-of-the-agents":
    case "@elizaos/app-clawville":
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
  {
    favoriteAppNames = new Set<string>(),
  }: {
    favoriteAppNames?: ReadonlySet<string>;
  } = {},
): AppCatalogSection[] {
  const sections: AppCatalogSection[] = [];
  const groupedApps = new Map<AppCatalogSectionKey, RegistryAppInfo[]>();
  const surfacedAppNames = new Set<string>();

  const favoriteApps = apps.filter((app) => favoriteAppNames.has(app.name));
  if (favoriteApps.length > 0) {
    sections.push({
      key: "favorites",
      label: APP_CATALOG_SECTION_LABELS.favorites,
      apps: favoriteApps,
    });
    for (const app of favoriteApps) {
      surfacedAppNames.add(app.name);
    }
  }

  const featuredApps = apps.filter(
    (app) => isFeaturedAppName(app.name) && !favoriteAppNames.has(app.name),
  );
  if (featuredApps.length > 0) {
    sections.push({
      key: "featured",
      label: APP_CATALOG_SECTION_LABELS.featured,
      apps: featuredApps,
    });
    for (const app of featuredApps) {
      surfacedAppNames.add(app.name);
    }
  }

  for (const app of apps) {
    if (surfacedAppNames.has(app.name)) {
      continue;
    }
    const sectionKey = getAppCatalogSectionKey(app);
    const sectionApps = groupedApps.get(sectionKey) ?? [];
    sectionApps.push(app);
    groupedApps.set(sectionKey, sectionApps);
  }

  return [
    ...sections,
    ...APP_CATALOG_SECTION_ORDER.flatMap((key) => {
      if (key === "featured" || key === "favorites") {
        return [];
      }
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
    }),
  ];
}

export function getAppShortName(app: RegistryAppInfo): string {
  const display = app.displayName ?? app.name;
  const clean = display.replace(/^@[^/]+\/app-/, "");
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

export function getAppEmoji(app: RegistryAppInfo): string {
  const sectionKey = getAppCatalogSectionKey(app);
  if (sectionKey === "featured") return "⭐";
  if (sectionKey === "games") return "🎮";
  if (sectionKey === "developerUtilities") return "🛠️";
  if (sectionKey === "finance") return "💰";
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
