import { buildRouteCatalog } from "../../packages/app-core/src/api/dev-route-catalog.ts";

export type Theme = "light" | "dark";
export type ViewportName = "desktop" | "tablet" | "mobile";

export type ReadyCheck =
  | { selector: string; text?: never }
  | { selector?: never; text: string };

export type AiQaRoute = {
  id: string;
  path: string;
  label: string;
  readyChecks: readonly ReadyCheck[];
  readyMode?: "any" | "all";
  timeoutMs?: number;
  viewports?: readonly ViewportName[];
};

export type AiQaSettingsSection = {
  id: string;
  label: string;
  match: string | RegExp;
};

export const VIEWPORT_SIZES: Record<
  ViewportName,
  { width: number; height: number }
> = {
  desktop: { width: 1440, height: 960 },
  tablet: { width: 1024, height: 768 },
  mobile: { width: 390, height: 844 },
};

const catalog = buildRouteCatalog(new Date("2026-01-01T00:00:00.000Z"));

export const AI_QA_ROUTES: readonly AiQaRoute[] = catalog.routes.map(
  (route) => ({
    id: route.tabId,
    path: route.path,
    label: route.label,
    readyChecks: [{ selector: "#root" }],
    readyMode: "any",
    timeoutMs: 30_000,
  }),
);

export const SETTINGS_SECTIONS: readonly AiQaSettingsSection[] =
  catalog.settingsSections.map((section) => ({
    id: section.id,
    label: section.label,
    match: section.label,
  }));
