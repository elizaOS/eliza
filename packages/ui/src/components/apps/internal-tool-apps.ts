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
    name: "@elizaos/app-lifeops",
    displayName: "LifeOps",
    description:
      "Run tasks, reminders, calendar, inbox, and connected operational workflows.",
    heroImage: "/api/apps/hero/lifeops",
    targetTab: "lifeops",
    capabilities: ["lifeops", "tasks", "calendar", "gmail"],
    order: 0,
    windowPath: "/apps/lifeops",
  },
  {
    name: "@elizaos/app-plugin-viewer",
    displayName: "Plugin Viewer",
    description:
      "Inspect installed plugins, connectors, and runtime feature flags.",
    heroImage: "/app-heroes/plugin-viewer.png",
    targetTab: "plugins",
    capabilities: ["plugins", "connectors", "viewer"],
    order: 1,
    windowPath: "/apps/plugins",
  },
  {
    name: "@elizaos/app-skills-viewer",
    displayName: "Skills Viewer",
    description: "Create, enable, review, and install custom agent skills.",
    heroImage: "/app-heroes/skills-viewer.png",
    targetTab: "skills",
    capabilities: ["skills", "viewer"],
    order: 2,
    windowPath: "/apps/skills",
  },
  {
    name: "@elizaos/app-training",
    displayName: "Fine Tuning",
    description:
      "Build datasets, inspect trajectories, run training jobs, and activate tuned models.",
    heroImage: "/api/apps/hero/training",
    targetTab: "fine-tuning",
    capabilities: ["training", "fine-tuning", "datasets", "models"],
    order: 3,
    windowPath: "/apps/fine-tuning",
    hasDetailsPage: true,
  },
  {
    name: "@elizaos/app-trajectory-viewer",
    displayName: "Trajectory Viewer",
    description: "Inspect LLM call history, prompts, and execution traces.",
    heroImage: "/app-heroes/trajectory-viewer.png",
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
    heroImage: "/app-heroes/relationship-viewer.png",
    targetTab: "relationships",
    capabilities: ["relationships", "graph", "viewer"],
    order: 5,
    windowPath: "/apps/relationships",
  },
  {
    name: "@elizaos/app-memory-viewer",
    displayName: "Memory Viewer",
    description: "Browse memory, fact, and extraction activity.",
    heroImage: "/app-heroes/memory-viewer.png",
    targetTab: "memories",
    capabilities: ["memory", "facts", "viewer"],
    order: 6,
    windowPath: "/apps/memories",
  },
  {
    name: "@elizaos/app-steward",
    displayName: "Steward",
    description:
      "Review wallet approvals, transaction history, and signing execution status.",
    heroImage: "/api/apps/hero/steward",
    targetTab: "inventory",
    capabilities: ["wallet", "transactions", "approvals", "trading"],
    order: 7,
    windowPath: "/apps/inventory",
    hasDetailsPage: true,
  },
  {
    name: "@elizaos/app-runtime-debugger",
    displayName: "Runtime Debugger",
    description:
      "Inspect runtime objects, plugin order, providers, and services.",
    heroImage: "/app-heroes/runtime-debugger.png",
    targetTab: "runtime",
    capabilities: ["runtime", "debug", "viewer"],
    order: 8,
    windowPath: "/apps/runtime",
  },
  {
    name: "@elizaos/app-database-viewer",
    displayName: "Database Viewer",
    description: "Inspect tables, media, vectors, and ad-hoc SQL.",
    heroImage: "/app-heroes/database-viewer.png",
    targetTab: "database",
    capabilities: ["database", "sql", "viewer"],
    order: 9,
    windowPath: "/apps/database",
  },
  {
    name: "@elizaos/app-elizamaker",
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
    heroImage: "/app-heroes/log-viewer.png",
    targetTab: "logs",
    capabilities: ["logs", "debug", "viewer"],
    order: 11,
    windowPath: "/apps/logs",
  },
  {
    name: "@elizaos/app-task-coordinator",
    displayName: "Automations",
    description: "Create, inspect, and manage scheduled tasks and workflows.",
    heroImage: "/api/apps/hero/tasks",
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
