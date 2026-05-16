import { buildRouteCatalog } from "../../packages/app-core/src/api/dev-route-catalog.ts";

export type Theme = "light" | "dark";
export type ViewportName = "desktop" | "tablet" | "mobile";

export type ReadyCheck =
  | { selector: string; text?: never }
  | { selector?: never; text: string };

export interface AiQaRoute {
  id: string;
  path: string;
  label: string;
  readyChecks: readonly ReadyCheck[];
  readyMode?: "all" | "any";
  timeoutMs?: number;
  viewports?: readonly ViewportName[];
}

export interface SettingsSection {
  id: string;
  label: string;
  match: string | RegExp;
}

export const VIEWPORT_SIZES: Record<
  ViewportName,
  { width: number; height: number }
> = {
  desktop: { width: 1440, height: 1000 },
  tablet: { width: 900, height: 1100 },
  mobile: { width: 390, height: 844 },
};

const catalog = buildRouteCatalog(new Date("2026-01-01T00:00:00.000Z"));
const ROOT_READY: readonly ReadyCheck[] = [{ selector: "#root" }];

export const AI_QA_ROUTES: readonly AiQaRoute[] = catalog.routes.map(
  (route) => ({
    id: route.tabId,
    path: route.path,
    label: route.label,
    readyChecks: ROOT_READY,
    readyMode: "any",
    timeoutMs: 30_000,
  }),
);

export const SETTINGS_SECTIONS: readonly SettingsSection[] =
  catalog.settingsSections.map((section) => ({
    id: section.id,
    label: section.label,
    match: section.label,
  }));
