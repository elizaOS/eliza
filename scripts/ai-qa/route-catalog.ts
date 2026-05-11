/**
 * Source of truth for AI QA route coverage. Imports from the existing
 * Playwright route cases so we never drift from what already-shipped
 * smoke tests claim to support.
 */
import { DIRECT_ROUTE_CASES } from "../../packages/app/test/ui-smoke/apps-session-route-cases";

export type ReadyCheck =
  | { selector: string; text?: never }
  | { selector?: never; text: string };

export type AiQaRoute = {
  /** Stable id used as filename + dir name. kebab-case, no slashes. */
  id: string;
  /** Display label for the report. */
  label: string;
  /** App path to navigate to. */
  path: string;
  /** Selectors / text that must be present before we screenshot. */
  readyChecks: readonly ReadyCheck[];
  /** "all": every check must pass. "any": one is enough. */
  readyMode?: "all" | "any";
  /** Per-route navigation timeout in ms (defaults to 30000). */
  timeoutMs?: number;
  /** Where this route is meaningful. Default: ["desktop","tablet","mobile"]. */
  viewports?: readonly ViewportName[];
  /** Optional setup tag the spec can branch on (e.g. "settings-sub-route"). */
  tag?: string;
};

export type ViewportName = "desktop" | "tablet" | "mobile";

export const VIEWPORT_SIZES: Record<
  ViewportName,
  { width: number; height: number }
> = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 },
};

export type Theme = "light" | "dark";
export const THEMES: readonly Theme[] = ["light", "dark"] as const;

const CORE_ROUTES: readonly AiQaRoute[] = [
  {
    id: "chat",
    label: "Chat",
    path: "/chat",
    readyChecks: [
      { selector: '[data-testid="conversations-sidebar"]' },
      { selector: '[data-testid="chat-composer-textarea"]' },
    ],
    readyMode: "any",
  },
  {
    id: "connectors",
    label: "Connectors",
    path: "/connectors",
    readyChecks: [{ selector: "#root" }],
  },
  {
    id: "apps-catalog",
    label: "Apps Catalog",
    path: "/apps",
    readyChecks: [{ selector: '[data-testid="apps-catalog-grid"]' }],
    timeoutMs: 60_000,
  },
  {
    id: "automations",
    label: "Automations",
    path: "/automations",
    readyChecks: [{ selector: '[data-testid="automations-shell"]' }],
    timeoutMs: 60_000,
  },
  {
    id: "browser",
    label: "Browser Workspace",
    path: "/browser",
    readyChecks: [
      { selector: '[data-testid="browser-workspace-address-input"]' },
    ],
    timeoutMs: 60_000,
  },
  {
    id: "character",
    label: "Character Editor",
    path: "/character",
    readyChecks: [{ selector: '[data-testid="character-editor-view"]' }],
    timeoutMs: 60_000,
  },
  {
    id: "character-documents",
    label: "Character Knowledge",
    path: "/character/documents",
    readyChecks: [
      { selector: '[data-testid="character-editor-view"]' },
      { selector: '[data-testid="documents-view"]' },
    ],
    readyMode: "any",
    timeoutMs: 60_000,
  },
  {
    id: "wallet",
    label: "Wallet / Inventory",
    path: "/wallet",
    readyChecks: [{ selector: '[data-testid="wallet-shell"]' }],
    timeoutMs: 60_000,
  },
  {
    id: "settings",
    label: "Settings",
    path: "/settings",
    readyChecks: [{ selector: '[data-testid="settings-shell"]' }],
    timeoutMs: 60_000,
  },
];

const APP_TOOL_ROUTES: readonly AiQaRoute[] = DIRECT_ROUTE_CASES.map(
  (routeCase) => {
    const readyChecks: readonly ReadyCheck[] =
      "readyChecks" in routeCase
        ? routeCase.readyChecks
        : [{ selector: routeCase.selector }];
    const timeoutMs =
      "timeoutMs" in routeCase && typeof routeCase.timeoutMs === "number"
        ? routeCase.timeoutMs
        : 60_000;
    return {
      id: `app-${routeCase.name.replace(/\s+/g, "-")}`,
      label: `App: ${routeCase.name}`,
      path: routeCase.path,
      readyChecks,
      readyMode: "any" as const,
      timeoutMs,
    } satisfies AiQaRoute;
  },
);

/**
 * Sub-routes that live inside the settings shell. The harness clicks each
 * section button rather than navigating, since the settings router is
 * tab-state based.
 */
export const SETTINGS_SECTIONS: readonly {
  id: string;
  label: string;
  match: RegExp;
}[] = [
  { id: "settings-identity", label: "Settings — Identity", match: /^Identity\b/ },
  {
    id: "settings-providers",
    label: "Settings — Providers",
    match: /^AI Model\b/,
  },
  { id: "settings-runtime", label: "Settings — Runtime", match: /^Runtime\b/ },
  {
    id: "settings-appearance",
    label: "Settings — Appearance",
    match: /^Appearance\b/,
  },
  {
    id: "settings-capabilities",
    label: "Settings — Capabilities",
    match: /^Capabilities\b/,
  },
  { id: "settings-apps", label: "Settings — Apps", match: /^Apps\b/ },
  {
    id: "settings-app-permissions",
    label: "Settings — App Permissions",
    match: /^App Permissions\b/,
  },
  {
    id: "settings-wallet-rpc",
    label: "Settings — Wallet & RPC",
    match: /^Wallet\b/,
  },
  {
    id: "settings-permissions",
    label: "Settings — Permissions",
    match: /^Permissions\b/,
  },
  { id: "settings-vault", label: "Settings — Vault", match: /^(Vault|Secrets)\b/ },
  { id: "settings-cloud", label: "Settings — Cloud", match: /^Cloud\b/ },
  { id: "settings-policy", label: "Settings — Policy", match: /^Policy\b/ },
];

export const AI_QA_ROUTES: readonly AiQaRoute[] = [
  ...CORE_ROUTES,
  ...APP_TOOL_ROUTES,
];

export function listRouteIds(): string[] {
  return AI_QA_ROUTES.map((route) => route.id);
}
