import { buildRouteCatalog } from "../../packages/app-core/src/api/dev-route-catalog";

export type ReadyCheck =
  | { selector: string; text?: never }
  | { selector?: never; text: string };

export type ViewportName = "desktop" | "tablet" | "mobile";
export type Theme = "light" | "dark";

export type AiQaRoute = {
  id: string;
  path: string;
  label: string;
  readyChecks: readonly ReadyCheck[];
  readyMode?: "all" | "any";
  timeoutMs?: number;
  viewports?: readonly ViewportName[];
};

export type SettingsSection = {
  id: string;
  label: string;
  match: RegExp;
};

export const VIEWPORT_SIZES: Record<
  ViewportName,
  { width: number; height: number }
> = {
  desktop: { width: 1440, height: 1000 },
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 },
};

const READY_CHECKS_BY_PATH: Record<string, readonly ReadyCheck[]> = {
  "/chat": [
    { selector: '[data-testid="conversations-sidebar"]' },
    { selector: '[data-testid="chat-composer-textarea"]' },
  ],
  "/connectors": [{ selector: "#root" }],
  "/apps": [{ selector: '[data-testid="apps-shell"]' }],
  "/views": [{ text: "Views" }],
  "/apps/lifeops": [{ selector: '[data-testid="lifeops-shell"]' }],
  "/apps/plugins": [{ text: "Browser Workspace" }, { text: "AI Providers" }],
  "/apps/skills": [{ selector: '[data-testid="skills-shell"]' }],
  "/apps/fine-tuning": [{ selector: '[data-testid="fine-tuning-view"]' }],
  "/apps/trajectories": [{ selector: '[data-testid="trajectories-view"]' }],
  "/apps/relationships": [{ selector: '[data-testid="relationships-view"]' }],
  "/apps/memories": [{ selector: '[data-testid="memory-viewer-view"]' }],
  "/apps/inventory": [{ selector: '[data-testid="wallet-shell"]' }],
  "/apps/runtime": [{ selector: '[data-testid="runtime-view"]' }],
  "/apps/database": [{ selector: '[data-testid="database-view"]' }],
  "/apps/elizamaker": [{ selector: '[data-testid="chat-composer-textarea"]' }],
  "/apps/logs": [{ selector: '[data-testid="logs-view"]' }],
  "/apps/tasks": [{ selector: '[data-testid="tasks-view"]' }],
  "/character": [{ selector: '[data-testid="character-editor-view"]' }],
  "/character/select": [{ selector: '[data-testid="character-editor-view"]' }],
  "/character/documents": [{ selector: '[data-testid="documents-view"]' }],
  "/wallet": [{ selector: '[data-testid="wallet-shell"]' }],
  "/browser": [{ selector: '[data-testid="browser-workspace-address-input"]' }],
  "/stream": [{ selector: "#root" }],
  "/automations": [{ selector: '[data-testid="automations-shell"]' }],
  "/settings": [{ selector: '[data-testid="settings-shell"]' }],
  "/settings/voice": [{ selector: '[data-testid="settings-shell"]' }],
  "/companion": [{ text: "Companion" }],
  "/rolodex": [{ selector: "#root" }],
  "/desktop": [{ selector: "#root" }],
};

const catalog = buildRouteCatalog(new Date("2026-01-01T00:00:00.000Z"));
const extraAppWindowRoutes = [
  {
    tabId: "app-window-inventory",
    path: "/apps/inventory",
    label: "Inventory App Window",
    platformGate: null,
  },
  {
    tabId: "app-window-elizamaker",
    path: "/apps/elizamaker",
    label: "ElizaMaker App Window",
    platformGate: null,
  },
] as const;

export const AI_QA_ROUTES: readonly AiQaRoute[] = [
  ...catalog.routes,
  ...extraAppWindowRoutes,
]
  .filter((route) => route.platformGate !== "android")
  .map((route) => ({
    id: route.tabId,
    path: route.path,
    label: route.label,
    readyChecks: READY_CHECKS_BY_PATH[route.path] ?? [{ selector: "#root" }],
    readyMode: route.path === "/chat" ? "all" : "any",
    timeoutMs: 90_000,
    viewports:
      route.platformGate === "desktop"
        ? (["desktop"] as const)
        : (["desktop", "mobile"] as const),
  }));

export const SETTINGS_SECTIONS: readonly SettingsSection[] =
  catalog.settingsSections.map((section) => ({
    id: section.id,
    label: section.label,
    match: new RegExp(
      `^${section.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      "i",
    ),
  }));
