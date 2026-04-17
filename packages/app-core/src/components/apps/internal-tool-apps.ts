import type { RegistryAppInfo } from "../../api";
import type { Tab } from "../../navigation";

interface InternalToolAppDefinition {
  capabilities: string[];
  description: string;
  displayName: string;
  name: string;
  order: number;
  targetTab: Tab;
}

const INTERNAL_TOOL_APPS: readonly InternalToolAppDefinition[] = [
  {
    name: "@elizaos/app-lifeops",
    displayName: "LifeOps",
    description:
      "Run tasks, reminders, calendar, inbox, and connected operational workflows.",
    targetTab: "lifeops",
    capabilities: ["lifeops", "tasks", "calendar", "gmail"],
    order: 0,
  },
  {
    name: "@elizaos/app-plugin-viewer",
    displayName: "Plugin Viewer",
    description:
      "Inspect installed plugins, connectors, and runtime feature flags.",
    targetTab: "plugins",
    capabilities: ["plugins", "connectors", "viewer"],
    order: 1,
  },
  {
    name: "@elizaos/app-skills-viewer",
    displayName: "Skills Viewer",
    description: "Create, enable, review, and install custom agent skills.",
    targetTab: "skills",
    capabilities: ["skills", "viewer"],
    order: 2,
  },
  {
    name: "@elizaos/app-trajectory-viewer",
    displayName: "Trajectory Viewer",
    description: "Inspect LLM call history, prompts, and execution traces.",
    targetTab: "trajectories",
    capabilities: ["trajectories", "debug", "viewer"],
    order: 3,
  },
  {
    name: "@elizaos/app-relationship-viewer",
    displayName: "Relationship Viewer",
    description:
      "Explore cross-channel people, identities, and relationship graphs.",
    targetTab: "relationships",
    capabilities: ["relationships", "graph", "viewer"],
    order: 4,
  },
  {
    name: "@elizaos/app-memory-viewer",
    displayName: "Memory Viewer",
    description: "Browse memory, fact, and extraction activity.",
    targetTab: "memories",
    capabilities: ["memory", "facts", "viewer"],
    order: 5,
  },
  {
    name: "@elizaos/app-runtime-debugger",
    displayName: "Runtime Debugger",
    description:
      "Inspect runtime objects, plugin order, providers, and services.",
    targetTab: "runtime",
    capabilities: ["runtime", "debug", "viewer"],
    order: 6,
  },
  {
    name: "@elizaos/app-database-viewer",
    displayName: "Database Viewer",
    description: "Inspect tables, media, vectors, and ad-hoc SQL.",
    targetTab: "database",
    capabilities: ["database", "sql", "viewer"],
    order: 7,
  },
  {
    name: "@elizaos/app-log-viewer",
    displayName: "Log Viewer",
    description: "Search runtime and service logs.",
    targetTab: "logs",
    capabilities: ["logs", "debug", "viewer"],
    order: 8,
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
    heroImage: null,
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
