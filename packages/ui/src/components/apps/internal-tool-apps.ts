/**
 * Internal-tool apps (plugin viewers, inspectors, fine-tuning, automations)
 * derived from the `GET /api/views` ViewDeclaration feed.
 *
 * The catalog and pinnable list are built from a single declarative source of
 * `ViewDeclaration` records — the same shape plugins register — with `pinnable`
 * a declared flag on each declaration. When a plugin owns the view (fine-tuning,
 * automations), its live network `ViewRegistryEntry` overlays
 * label/description/hero at read time, so renaming a plugin app's `displayName`
 * in its ViewDeclaration updates the catalog with no edit here.
 */

import type { RegistryAppInfo } from "../../api";
import type { ViewRegistryEntry } from "../../hooks/useAvailableViews";
import type { Tab } from "../../navigation";

/**
 * A ViewDeclaration for an internal-tool app plus the UI-routing metadata the
 * shell needs to launch it: which builtin tab it navigates to, catalog order,
 * whether it routes through an App Details page, and whether it is pinnable.
 * `path` is the window path the app occupies (`/apps/<tab>`); network views are
 * matched to a declaration by this path.
 */
interface InternalToolViewDeclaration {
  /** Package name identity used across the catalog and dedup logic. */
  name: string;
  /** Display label — overlaid by the plugin's live ViewDeclaration when owned. */
  displayName: string;
  /** One-line description — overlaid by the live ViewDeclaration when owned. */
  description: string;
  /** Capability tags — overlaid by the live ViewDeclaration `tags` when owned. */
  capabilities: string[];
  /** Public hero image URL, or null to render the icon. */
  heroImage: string | null;
  /** Builtin tab this app navigates to when launched. */
  targetTab: Tab;
  /** Window path (`/apps/<tab>`) this app occupies; the view-match key. */
  path: string;
  /** Catalog sort order — lower appears first. */
  order: number;
  /**
   * When true, clicking the app opens the App Details page (config +
   * diagnostics + Launch) rather than launching directly. Default false.
   */
  hasDetailsPage: boolean;
  /**
   * When true, the homescreen launcher may pin this app. Declared here rather
   * than in a separate UI package-name list.
   */
  pinnable: boolean;
}

const INTERNAL_TOOL_VIEW_DECLARATIONS: readonly InternalToolViewDeclaration[] =
  [
    {
      name: "@elizaos/app-plugin-viewer",
      displayName: "Plugin Viewer",
      description:
        "Inspect installed plugins, connectors, and runtime feature flags.",
      capabilities: ["plugins", "connectors", "viewer"],
      heroImage: null,
      targetTab: "plugins",
      path: "/apps/plugins",
      order: 1,
      hasDetailsPage: false,
      pinnable: true,
    },
    {
      name: "@elizaos/app-skills-viewer",
      displayName: "Skills Viewer",
      description: "Create, enable, review, and install custom agent skills.",
      capabilities: ["skills", "viewer"],
      heroImage: null,
      targetTab: "skills",
      path: "/apps/skills",
      order: 2,
      hasDetailsPage: false,
      pinnable: true,
    },
    {
      name: "@elizaos/plugin-training",
      displayName: "Fine Tuning",
      description:
        "Collect training data, inspect trajectories, run Eliza harness evals, benchmark model tiers, and manage fine-tuned models.",
      capabilities: [
        "training",
        "fine-tuning",
        "trajectories",
        "datasets",
        "models",
        "evals",
        "benchmarks",
        "analysis",
        "data-collection",
      ],
      heroImage: "/api/apps/hero/training",
      targetTab: "fine-tuning",
      path: "/apps/fine-tuning",
      order: 3,
      hasDetailsPage: true,
      pinnable: true,
    },
    {
      name: "@elizaos/app-trajectory-viewer",
      displayName: "Trajectory Viewer",
      description: "Inspect LLM call history, prompts, and execution traces.",
      capabilities: ["trajectories", "debug", "viewer"],
      heroImage: null,
      targetTab: "trajectories",
      path: "/apps/trajectories",
      order: 4,
      hasDetailsPage: false,
      pinnable: true,
    },
    {
      name: "@elizaos/app-relationship-viewer",
      displayName: "Relationship Viewer",
      description:
        "Explore cross-channel people, identities, and relationship graphs.",
      capabilities: ["relationships", "graph", "viewer"],
      heroImage: null,
      targetTab: "relationships",
      path: "/apps/relationships",
      order: 5,
      hasDetailsPage: false,
      pinnable: true,
    },
    {
      name: "@elizaos/app-memory-viewer",
      displayName: "Memory Viewer",
      description: "Browse memory, fact, and extraction activity.",
      capabilities: ["memory", "facts", "viewer"],
      heroImage: null,
      targetTab: "memories",
      path: "/apps/memories",
      order: 6,
      hasDetailsPage: false,
      pinnable: true,
    },
    {
      name: "@elizaos/app-runtime-debugger",
      displayName: "Runtime Debugger",
      description:
        "Inspect runtime objects, plugin order, providers, and services.",
      capabilities: ["runtime", "debug", "viewer"],
      heroImage: null,
      targetTab: "runtime",
      path: "/apps/runtime",
      order: 8,
      hasDetailsPage: false,
      pinnable: true,
    },
    {
      name: "@elizaos/app-database-viewer",
      displayName: "Database Viewer",
      description: "Inspect tables, media, vectors, and ad-hoc SQL.",
      capabilities: ["database", "sql", "viewer"],
      heroImage: null,
      targetTab: "database",
      path: "/apps/database",
      order: 9,
      hasDetailsPage: false,
      pinnable: true,
    },
    {
      name: "@elizaos/app-files-viewer",
      displayName: "Files",
      description:
        "Browse every stored file with download, share, and delete, filtered by type.",
      capabilities: ["files", "attachments", "media", "viewer"],
      heroImage: null,
      targetTab: "files",
      path: "/apps/files",
      order: 13,
      hasDetailsPage: false,
      pinnable: false,
    },
    {
      name: "@elizaos/app-log-viewer",
      displayName: "Log Viewer",
      description: "Search runtime and service logs.",
      capabilities: ["logs", "debug", "viewer"],
      heroImage: null,
      targetTab: "logs",
      path: "/apps/logs",
      order: 11,
      hasDetailsPage: false,
      pinnable: true,
    },
    {
      name: "@elizaos/plugin-task-coordinator",
      displayName: "Automations",
      description:
        "Create, inspect, and manage workflows, triggers, and scheduled items.",
      capabilities: ["tasks", "workflows", "automations"],
      heroImage: "/api/apps/hero/task-coordinator",
      targetTab: "tasks",
      path: "/apps/tasks",
      order: 12,
      hasDetailsPage: false,
      pinnable: true,
    },
  ] as const;

const INTERNAL_TOOL_APP_BY_NAME = new Map(
  INTERNAL_TOOL_VIEW_DECLARATIONS.map((app) => [app.name, app] as const),
);

const INTERNAL_TOOL_APP_BY_PATH = new Map(
  INTERNAL_TOOL_VIEW_DECLARATIONS.map((app) => [app.path, app] as const),
);

/**
 * Resolve the effective label, description, hero, and capabilities for an
 * internal-tool app, preferring the live `/api/views` ViewDeclaration that owns
 * the app's window path when one is supplied. Plugin-owned apps (fine-tuning,
 * automations) thus reflect renames in their ViewDeclaration with no edit here;
 * UI-only viewers fall back to the local declaration.
 */
function resolveAppMetadata(
  declaration: InternalToolViewDeclaration,
  networkViews: readonly ViewRegistryEntry[],
): {
  displayName: string;
  description: string;
  capabilities: string[];
  heroImage: string | null;
} {
  const match = networkViews.find((view) => view.path === declaration.path);
  return {
    displayName: match?.label ?? declaration.displayName,
    description: match?.description ?? declaration.description,
    capabilities:
      match?.tags && match.tags.length > 0
        ? match.tags
        : declaration.capabilities,
    heroImage:
      match?.hasHeroImage && match.heroImageUrl
        ? match.heroImageUrl
        : declaration.heroImage,
  };
}

function toRegistryAppInfo(
  declaration: InternalToolViewDeclaration,
  networkViews: readonly ViewRegistryEntry[],
): RegistryAppInfo {
  const meta = resolveAppMetadata(declaration, networkViews);
  return {
    name: declaration.name,
    displayName: meta.displayName,
    description: meta.description,
    category: "utility",
    launchType: "local",
    launchUrl: null,
    icon: null,
    heroImage: meta.heroImage,
    capabilities: meta.capabilities,
    stars: 0,
    repository: "",
    latestVersion: null,
    supports: { v0: false, v1: false, v2: true },
    npm: {
      package: declaration.name,
      v0Version: null,
      v1Version: null,
      v2Version: null,
    },
  };
}

/**
 * Build the internal-tool app catalog. Pass the live `/api/views` entries to
 * overlay plugin-owned label/description/hero; omit them for a pure static
 * catalog (identity + routing metadata is always local).
 */
export function getInternalToolApps(
  networkViews: readonly ViewRegistryEntry[] = [],
): RegistryAppInfo[] {
  return INTERNAL_TOOL_VIEW_DECLARATIONS.map((declaration) =>
    toRegistryAppInfo(declaration, networkViews),
  );
}

export function isInternalToolApp(name: string): boolean {
  return INTERNAL_TOOL_APP_BY_NAME.has(name);
}

export function getInternalToolAppTargetTab(name: string): Tab | null {
  return INTERNAL_TOOL_APP_BY_NAME.get(name)?.targetTab ?? null;
}

export function getInternalToolAppCatalogOrder(name: string): number {
  return INTERNAL_TOOL_APP_BY_NAME.get(name)?.order ?? Number.MAX_SAFE_INTEGER;
}

export function getInternalToolAppWindowPath(name: string): string | null {
  return INTERNAL_TOOL_APP_BY_NAME.get(name)?.path ?? null;
}

export function getInternalToolAppHasDetailsPage(name: string): boolean {
  return INTERNAL_TOOL_APP_BY_NAME.get(name)?.hasDetailsPage === true;
}

/** Resolve the internal-tool app name that owns a given window path. */
export function getInternalToolAppNameForPath(path: string): string | null {
  return INTERNAL_TOOL_APP_BY_PATH.get(path)?.name ?? null;
}

/**
 * The internal-tool apps the homescreen launcher may pin, read from each
 * declaration's `pinnable` flag. Replaces the old `PINNABLE_INTERNAL_APPS`
 * literal name list.
 */
export function getPinnableInternalAppNames(): string[] {
  return INTERNAL_TOOL_VIEW_DECLARATIONS.filter((app) => app.pinnable).map(
    (app) => app.name,
  );
}

/** Plain descriptor used by the desktop application/tray menus. */
export interface InternalToolAppDescriptor {
  readonly name: string;
  readonly displayName: string;
  readonly windowPath: string | null;
  readonly hasDetailsPage: boolean;
  readonly order: number;
}

export function getInternalToolAppDescriptors(): readonly InternalToolAppDescriptor[] {
  return INTERNAL_TOOL_VIEW_DECLARATIONS.map((app) => ({
    name: app.name,
    displayName: app.displayName,
    windowPath: app.path,
    hasDetailsPage: app.hasDetailsPage,
    order: app.order,
  }));
}
