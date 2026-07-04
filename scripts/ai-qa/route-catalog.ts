/**
 * Route catalog and shared types for the AI-QA screenshot tooling.
 *
 * Enumerates every dashboard route the QA scripts visit, the per-route
 * ready-checks that gate a capture, the viewport sizes and themes to render,
 * and the settings-section map. Built on top of the app-core dev route catalog
 * and consumed by the review-screenshots / review-walkthrough scripts.
 */
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
  "/onboarding": [{ selector: '[data-testid="first-run-runtime-cloud"]' }],
  "/chat": [
    { selector: '[data-testid="conversations-sidebar"]' },
    { selector: '[data-testid="chat-composer-textarea"]' },
  ],
  // Settings/lazy-view routes: wait for the actual rendered view marker, not the
  // always-present #root, so the screenshot is captured after the lazy chunk
  // mounts and paints (a bare #root check races the chunk and yields a blank,
  // one-solid-color capture that fails the screenshot-quality gate).
  "/connectors": [{ selector: '[data-testid="settings-shell"]' }],
  "/tutorial": [{ selector: '[data-testid="tutorial-launcher"]' }],
  "/help": [{ selector: '[data-testid="help-view"]' }],
  "/apps/transcripts": [{ selector: '[data-testid="transcripts-view"]' }],
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
  "/apps/logs": [{ selector: '[data-testid="logs-view"]' }],
  "/apps/tasks": [{ selector: '[data-testid="tasks-view"]' }],
  "/character": [{ selector: '[data-testid="character-editor-view"]' }],
  "/character/select": [{ selector: '[data-testid="character-editor-view"]' }],
  "/character/documents": [{ selector: '[data-testid="documents-view"]' }],
  "/wallet": [{ selector: '[data-testid="wallet-shell"]' }],
  "/browser": [{ selector: '[data-testid="browser-workspace-address-input"]' }],
  "/stream": [{ text: "Stream Ready" }],
  "/automations": [{ selector: '[data-testid="automations-shell"]' }],
  "/settings": [{ selector: '[data-testid="settings-shell"]' }],
  "/settings/voice": [{ selector: '[data-testid="settings-shell"]' }],
  "/companion": [{ text: "Companion" }],
  "/rolodex": [{ text: "Views" }],
  "/desktop": [{ text: "Desktop workspace tools are only available" }],
};

const catalog = buildRouteCatalog(new Date("2026-01-01T00:00:00.000Z"));
const extraAppWindowRoutes = [
  {
    tabId: "app-window-inventory",
    path: "/apps/inventory",
    label: "Inventory App Window",
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
