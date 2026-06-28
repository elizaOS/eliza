import type { RegistryAppInfo } from "../../api";
import type { Tab } from "../../navigation";

interface InternalToolAppDefinition {
  capabilities: string[];
  description: string;
  displayName: string;
  heroImage?: string | null;
  name: string;
  order: number;
  targetTab: Tab;
  windowPath?: string;
  /**
   * When true, clicking the app navigates to the App Details page first
   * (config + diagnostics + widgets + Launch button) rather than launching
   * directly. Default false — most viewers/inspectors don't need a details
   * step, only apps with real configuration or runtime knobs do.
   */
  hasDetailsPage?: boolean;
}

const INTERNAL_TOOL_APPS: readonly InternalToolAppDefinition[] = [
  {
    name: "@elizaos/app-plugin-viewer",
    displayName: "Plugin Viewer",
    description:
      "Inspect installed plugins, connectors, and runtime feature flags.",
    heroImage: null,
    targetTab: "plugins",
    capabilities: ["plugins", "connectors", "viewer"],
    order: 1,
    windowPath: "/apps/plugins",
  },
  {
    name: "@elizaos/app-skills-viewer",
    displayName: "Skills Viewer",
    description: "Create, enable, review, and install custom agent skills.",
    heroImage: null,
    targetTab: "skills",
    capabilities: ["skills", "viewer"],
    order: 2,
    windowPath: "/apps/skills",
  },
  {
    name: "@elizaos/plugin-training",
    displayName: "Fine Tuning",
    description:
      "Collect training data, inspect trajectories, run Eliza harness evals, benchmark model tiers, and manage fine-tuned models.",
    heroImage: "/api/apps/hero/training",
    targetTab: "fine-tuning",
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
    order: 3,
    windowPath: "/apps/fine-tuning",
    hasDetailsPage: true,
  },
  {
    name: "@elizaos/app-trajectory-viewer",
    displayName: "Trajectory Viewer",
    description: "Inspect LLM call history, prompts, and execution traces.",
    heroImage: null,
    targetTab: "trajectories",
    capabilities: ["trajectories", "debug", "viewer"],
    order: 4,
    windowPath: "/apps/trajectories",
  },
  {
    name: "@elizaos/app-relationship-viewer",
    displayName: "Relationship Viewer",
    description:
      "Explore cross-channel people, identities, and relationship graphs.",
    heroImage: null,
    targetTab: "relationships",
    capabilities: ["relationships", "graph", "viewer"],
    order: 5,
    windowPath: "/apps/relationships",
  },
  {
    name: "@elizaos/app-memory-viewer",
    displayName: "Memory Viewer",
    description: "Browse memory, fact, and extraction activity.",
    heroImage: null,
    targetTab: "memories",
    capabilities: ["memory", "facts", "viewer"],
    order: 6,
    windowPath: "/apps/memories",
  },
  {
    name: "@elizaos/app-runtime-debugger",
    displayName: "Runtime Debugger",
    description:
      "Inspect runtime objects, plugin order, providers, and services.",
    heroImage: null,
    targetTab: "runtime",
    capabilities: ["runtime", "debug", "viewer"],
    order: 8,
    windowPath: "/apps/runtime",
  },
  {
    name: "@elizaos/app-database-viewer",
    displayName: "Database Viewer",
    description: "Inspect tables, media, vectors, and ad-hoc SQL.",
    heroImage: null,
    targetTab: "database",
    capabilities: ["database", "sql", "viewer"],
    order: 9,
    windowPath: "/apps/database",
  },
  {
    name: "@elizaos/app-files-viewer",
    displayName: "Files",
    description:
      "Browse every stored file with download, share, and delete, filtered by type.",
    heroImage: null,
    targetTab: "files",
    capabilities: ["files", "attachments", "media", "viewer"],
    order: 13,
    windowPath: "/apps/files",
  },
  {
    name: "@elizaos/plugin-elizamaker",
    displayName: "ElizaMaker",
    description:
      "Run drop, mint, whitelist, and verification workflows through the agent surfaces.",
    heroImage: "/api/apps/hero/elizamaker",
    targetTab: "chat",
    capabilities: ["drops", "minting", "whitelist", "verification"],
    order: 10,
    windowPath: "/apps/elizamaker",
    hasDetailsPage: true,
  },
  {
    name: "@elizaos/app-log-viewer",
    displayName: "Log Viewer",
    description: "Search runtime and service logs.",
    heroImage: null,
    targetTab: "logs",
    capabilities: ["logs", "debug", "viewer"],
    order: 11,
    windowPath: "/apps/logs",
  },
  {
    name: "@elizaos/plugin-task-coordinator",
    displayName: "Automations",
    description: "Create, inspect, and manage scheduled tasks and workflows.",
    heroImage: "/api/apps/hero/task-coordinator",
    targetTab: "tasks",
    capabilities: ["tasks", "workflows", "automations"],
    order: 12,
    windowPath: "/apps/tasks",
  },
] as const;

const INTERNAL_TOOL_APP_BY_NAME = new Map(
  INTERNAL_TOOL_APPS.map((app) => [app.name, app] as const),
);

export function getInternalToolApps(): RegistryAppInfo[] {
  return INTERNAL_TOOL_APPS.map((app) => ({
    name: app.name,
    displayName: app.displayName,
    description: app.description,
    category: "utility",
    launchType: "local",
    launchUrl: null,
    icon: null,
    heroImage: app.heroImage ?? null,
    capabilities: app.capabilities,
    stars: 0,
    repository: "",
    latestVersion: null,
    supports: { v0: false, v1: false, v2: true },
    npm: {
      package: app.name,
      v0Version: null,
      v1Version: null,
      v2Version: null,
    },
  }));
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
  return INTERNAL_TOOL_APP_BY_NAME.get(name)?.windowPath ?? null;
}

export function getInternalToolAppHasDetailsPage(name: string): boolean {
  return INTERNAL_TOOL_APP_BY_NAME.get(name)?.hasDetailsPage === true;
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
  return INTERNAL_TOOL_APPS.map((app) => ({
    name: app.name,
    displayName: app.displayName,
    windowPath: app.windowPath ?? null,
    hasDetailsPage: app.hasDetailsPage === true,
    order: app.order,
  }));
}
