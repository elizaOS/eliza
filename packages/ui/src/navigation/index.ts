/**
 * Navigation — tabs + onboarding.
 */

/// <reference types="vite/client" />

import { Capacitor } from "@capacitor/core";
import type { LucideIcon } from "lucide-react";
import {
  Clock3,
  Gamepad2,
  MessageSquare,
  Monitor,
  Phone,
  Radio,
  Settings,
  UserRound,
  Wallet,
} from "lucide-react";
import { resolveDefaultLandingTab } from "./main-tab";

/** Apps are enabled by default; opt-out via VITE_ENABLE_APPS=false. */
export const APPS_ENABLED =
  String(import.meta.env?.VITE_ENABLE_APPS ?? "true").toLowerCase() !== "false";

/** Stream routes stay addressable; the nav hides the tab unless streaming is enabled. */
export const STREAM_ENABLED = true;
/** Companion tab — enabled by default; opt-out via VITE_ENABLE_COMPANION_MODE=false. */
export const COMPANION_ENABLED =
  String(import.meta.env?.VITE_ENABLE_COMPANION_MODE ?? "true").toLowerCase() !==
  "false";

/** Built-in tab identifiers. */
export type BuiltinTab =
  | "chat"
  | "phone"
  | "messages"
  | "contacts"
  | "lifeops"
  | "tasks"
  | "automations"
  | "browser"
  | "companion"
  | "stream"
  | "apps"
  | "character"
  | "character-select"
  | "inventory"
  | "documents"
  | "triggers"
  | "plugins"
  | "skills"
  | "advanced"
  | "fine-tuning"
  | "trajectories"
  | "relationships"
  | "memories"
  | "rolodex"
  | "voice"
  | "runtime"
  | "database"
  | "desktop"
  | "settings"
  | "logs";

/**
 * Tab identifier — includes all built-in tabs plus arbitrary strings
 * for dynamic plugin-provided nav-page widgets.
 */
export type Tab = BuiltinTab | (string & {});

export const APPS_TOOL_TABS = [
  "lifeops",
  "plugins",
  "skills",
  "fine-tuning",
  "trajectories",
  "relationships",
  "memories",
  "runtime",
  "database",
  "logs",
  // Legacy hidden alias for old /advanced routes.
  "advanced",
] as const satisfies readonly Tab[];

const APPS_TOOL_TAB_SET = new Set<Tab>(APPS_TOOL_TABS);

export function isAppsToolTab(tab: Tab): boolean {
  return APPS_TOOL_TAB_SET.has(tab);
}

export interface TabGroup {
  label: string;
  tabs: Tab[];
  icon: LucideIcon;
  description?: string;
}

export interface AndroidPhoneSurfaceDetection {
  platform?: string;
  isNative?: boolean;
  search?: string;
  hash?: string;
}

function hasAndroidTestFlag(search: string, hash: string): boolean {
  const searchParams = new URLSearchParams(search);
  if (searchParams.get("android") === "true") return true;
  const hashQuery = hash.includes("?") ? hash.slice(hash.indexOf("?")) : "";
  if (!hashQuery) return false;
  return new URLSearchParams(hashQuery).get("android") === "true";
}

export function isAndroidPhoneSurfaceEnabled(
  detection: AndroidPhoneSurfaceDetection = {},
): boolean {
  const search =
    detection.search ??
    (typeof window === "undefined" ? "" : window.location.search);
  const hash =
    detection.hash ??
    (typeof window === "undefined" ? "" : window.location.hash);
  if (hasAndroidTestFlag(search, hash)) return true;

  const platform = detection.platform ?? Capacitor.getPlatform();
  const isNative = detection.isNative ?? Capacitor.isNativePlatform();
  return isNative && platform === "android";
}

interface WindowNavigationLocation {
  protocol: string;
  search: string;
  hash: string;
  pathname: string;
}

function getWindowNavigationLocation(): WindowNavigationLocation | undefined {
  return typeof window === "undefined" ? undefined : window.location;
}

export function isAppWindowRoute(
  location:
    | Pick<WindowNavigationLocation, "search">
    | undefined = getWindowNavigationLocation(),
): boolean {
  if (!location) return false;
  try {
    return new URLSearchParams(location.search).get("appWindow") === "1";
  } catch {
    return false;
  }
}

export function shouldUseHashNavigation(
  location:
    | Pick<WindowNavigationLocation, "protocol" | "search">
    | undefined = getWindowNavigationLocation(),
): boolean {
  if (!location) return false;
  return location.protocol === "file:" || isAppWindowRoute(location);
}

export function getWindowNavigationPath(
  location:
    | WindowNavigationLocation
    | undefined = getWindowNavigationLocation(),
): string {
  if (!location) return "/";
  return shouldUseHashNavigation(location)
    ? location.hash.replace(/^#/, "") || "/"
    : location.pathname;
}

export const ALL_TAB_GROUPS: TabGroup[] = [
  {
    label: "Chat",
    tabs: ["chat"],
    icon: MessageSquare,
    description:
      "Conversations with your agent, inbound messages from every connector, and connector management",
  },
  {
    label: "Phone",
    tabs: ["phone", "messages", "contacts"],
    icon: Phone,
    description: "ElizaOS dialer, SMS, and contact book",
  },
  {
    label: "Apps",
    tabs: ["apps", ...APPS_TOOL_TABS],
    icon: Gamepad2,
    description: "Games, LifeOps, integrations, and app tools",
  },
  {
    label: "Character",
    tabs: ["character", "character-select", "documents"],
    icon: UserRound,
    description: "Avatar identity, style, examples, and knowledge",
  },
  {
    label: "Wallet",
    tabs: ["inventory"],
    icon: Wallet,
    description: "Crypto wallets and token balances",
  },
  {
    label: "Browser",
    tabs: ["browser"],
    icon: Monitor,
    description: "Agent-controlled browser workspace",
  },
  {
    label: "Stream",
    tabs: ["stream"],
    icon: Radio,
    description: "Live streaming controls",
  },
  {
    label: "Automations",
    tabs: ["automations", "triggers", "tasks"],
    icon: Clock3,
    description: "Tasks, scheduled tasks, and recurring workflows",
  },
  {
    label: "Settings",
    tabs: ["settings"],
    icon: Settings,
    description: "Configuration and preferences",
  },
];

/** A plugin-provided nav-page widget that should appear in the navigation. */
export interface DynamicNavTab {
  /** Tab ID — used as the route path segment. */
  tabId: string;
  /** Human-readable label for the nav button. */
  label: string;
  /** Which existing TabGroup to join, or a new group label to create. */
  navGroup?: string;
  /** Icon for new groups (lucide component). Falls back to Gamepad2. */
  icon?: LucideIcon;
  /** Description for new groups. */
  description?: string;
}

/** Compute visible tab groups. Pass feature flags explicitly for React reactivity. */
export function getTabGroups(
  streamEnabled = STREAM_ENABLED,
  walletEnabled = true,
  browserEnabled = true,
  dynamicTabs?: DynamicNavTab[],
  phoneSurfaceEnabled = isAndroidPhoneSurfaceEnabled(),
  automationsEnabled = true,
): TabGroup[] {
  const groups = ALL_TAB_GROUPS.filter(
    (g) =>
      (APPS_ENABLED || g.label !== "Apps") &&
      (phoneSurfaceEnabled || g.label !== "Phone") &&
      (streamEnabled || g.label !== "Stream") &&
      (walletEnabled || g.label !== "Wallet") &&
      (browserEnabled || g.label !== "Browser") &&
      (automationsEnabled || g.label !== "Automations"),
  );

  // Merge dynamic plugin-provided nav-page tabs into groups.
  if (dynamicTabs?.length) {
    for (const dt of dynamicTabs) {
      const targetGroup = dt.navGroup
        ? groups.find((g) => g.label === dt.navGroup)
        : null;
      if (targetGroup) {
        if (!targetGroup.tabs.includes(dt.tabId)) {
          targetGroup.tabs.push(dt.tabId);
        }
      } else {
        // Create a new group for this tab.
        groups.push({
          label: dt.label,
          tabs: [dt.tabId],
          icon: dt.icon ?? Gamepad2,
          description: dt.description,
        });
      }
    }
  }

  return groups;
}

export const TAB_PATHS: Record<BuiltinTab, string> = {
  chat: "/chat",
  phone: "/phone",
  messages: "/messages",
  contacts: "/contacts",
  lifeops: "/apps/lifeops",
  tasks: "/apps/tasks",
  browser: "/browser",
  companion: "/companion",
  stream: "/stream",
  apps: "/apps",
  character: "/character",
  "character-select": "/character/select",
  automations: "/automations",
  triggers: "/automations",
  inventory: "/wallet",
  documents: "/character/documents",
  plugins: "/apps/plugins",
  skills: "/apps/skills",
  advanced: "/apps/fine-tuning",
  "fine-tuning": "/apps/fine-tuning",
  trajectories: "/apps/trajectories",
  relationships: "/apps/relationships",
  memories: "/apps/memories",
  rolodex: "/rolodex",
  voice: "/settings/voice",
  runtime: "/apps/runtime",
  database: "/apps/database",
  desktop: "/desktop",
  settings: "/settings",
  logs: "/apps/logs",
};

const PATH_TO_TAB = new Map(
  Object.entries(TAB_PATHS).map(([tab, p]) => [p, tab as Tab]),
);

function normalizePathForLookup(pathname: string, basePath = ""): string {
  const base = normalizeBasePath(basePath);
  let p = pathname || "/";
  const queryIndex = p.indexOf("?");
  if (queryIndex >= 0) p = p.slice(0, queryIndex);
  const hashIndex = p.indexOf("#");
  if (hashIndex >= 0) p = p.slice(0, hashIndex);
  if (base) {
    if (p === base) p = "/";
    else if (p.startsWith(`${base}/`)) p = p.slice(base.length);
  }
  let normalized = normalizePath(p).toLowerCase();
  if (normalized.endsWith("/index.html")) normalized = "/";
  return normalized;
}

export function pathForTab(tab: Tab, basePath = ""): string {
  const base = normalizeBasePath(basePath);
  const p = TAB_PATHS[tab as BuiltinTab] ?? `/${tab}`;
  return base ? `${base}${p}` : p;
}

export function canonicalPathForPath(
  _pathname: string,
  _basePath = "",
): string | null {
  return null;
}

export function isRouteRootPath(pathname: string, basePath = ""): boolean {
  return normalizePathForLookup(pathname, basePath) === "/";
}

export function resolveInitialTabForPath(
  pathname: string,
  fallbackTab: Tab,
  basePath = "",
): Tab {
  if (isRouteRootPath(pathname, basePath)) {
    return fallbackTab;
  }
  return tabFromPath(pathname, basePath) ?? fallbackTab;
}

/** Known apps-tool sub-paths under /apps/ (not actual app slugs). */
const APPS_SUB_TABS: Record<string, Tab> = {
  lifeops: "lifeops",
  tasks: "automations",
  plugins: "plugins",
  skills: "skills",
  "fine-tuning": "fine-tuning",
  trajectories: "trajectories",
  relationships: "relationships",
  memories: "memories",
  runtime: "runtime",
  database: "database",
  logs: "logs",
  // Internal-tool window targets that hit non-`/apps/` shell tabs. The window
  // path is `/apps/<slug>` so the route stays consistent with other internal
  // tools, but the renderer mounts the tab the original `targetTab` pointed
  // at (e.g. wallet for steward, chat for elizamaker).
  inventory: "inventory",
  elizamaker: "chat",
  // Note: "companion" is intentionally NOT here — /apps/companion is an app slug
  // that AppsView auto-launches as an overlay, not a tool tab.
};

export function tabFromPath(pathname: string, basePath = ""): Tab | null {
  const normalized = normalizePathForLookup(pathname, basePath);
  // The root path "/" lands on the discovered main-tab app. Reads the
  // cached apps catalog synchronously and falls back to the legacy
  // chat tab when no app declares elizaos.app.mainTab=true.
  if (normalized === "/") return resolveDefaultLandingTab();

  if (
    normalized === "/node-catalog" ||
    normalized === "/automations/node-catalog"
  ) {
    return "automations";
  }

  // Companion disabled unless explicitly feature-flagged
  if (
    !COMPANION_ENABLED &&
    (normalized === "/companion" ||
      normalized === "/apps/companion" ||
      normalized === "/character-select" ||
      normalized === "/character/select")
  ) {
    return "chat";
  }

  // Apps disabled in production builds — redirect to chat
  if (
    !APPS_ENABLED &&
    (normalized === "/apps" ||
      normalized.startsWith("/apps/") ||
      normalized === "/game")
  ) {
    return "chat";
  }

  // /apps/<sub> — known tool tabs resolve to their tab; everything else is an app slug
  if (normalized.startsWith("/apps/")) {
    const sub = normalized.slice("/apps/".length);
    return APPS_SUB_TABS[sub] ?? "apps";
  }

  // /character/<sub> — resolve nested character paths
  if (normalized.startsWith("/character/")) {
    const sub = normalized.slice("/character/".length);
    if (sub === "documents") return "documents";
    if (sub === "select") return "character-select";
    return "character";
  }

  // /settings/<sub> — resolve nested settings paths
  if (normalized.startsWith("/settings/")) {
    const sub = normalized.slice("/settings/".length);
    if (sub === "voice") return "settings";
    return "settings";
  }

  // Legacy /connectors — redirect into Settings → Connectors.
  if (normalized === "/connectors") return "settings";

  // Check current paths first, then legacy redirects
  return PATH_TO_TAB.get(normalized) ?? null;
}

function normalizeBasePath(basePath: string): string {
  if (!basePath) return "";
  let base = basePath.trim();
  if (!base.startsWith("/")) base = `/${base}`;
  if (base === "/") return "";
  if (base.endsWith("/")) base = base.slice(0, -1);
  return base;
}

function normalizePath(p: string): string {
  if (!p) return "/";
  let normalized = p.trim();
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  if (normalized.length > 1 && normalized.endsWith("/"))
    normalized = normalized.slice(0, -1);
  return normalized;
}

/**
 * Extract an app slug from a `/apps/<slug>` path.
 * Returns `null` when the path doesn't contain a slug segment.
 */
export function getAppSlugFromPath(
  pathname: string,
  basePath = "",
): string | null {
  const normalized = normalizePathForLookup(pathname, basePath);
  if (!normalized.startsWith("/apps/")) return null;
  const slug = normalized.slice("/apps/".length);
  return slug || null;
}

export function titleForTab(tab: Tab): string {
  switch (tab) {
    case "chat":
      return "Chat";
    case "phone":
      return "Phone";
    case "messages":
      return "Messages";
    case "contacts":
      return "Contacts";
    case "lifeops":
      return "LifeOps";
    case "browser":
      return "Browser";
    case "companion":
      return "Companion";
    case "apps":
      return "Apps";
    case "character":
      return "Character";
    case "character-select":
      return "Character Select";
    case "automations":
      return "Automations";
    case "triggers":
      return "Automations";
    case "inventory":
      return "Wallet";
    case "documents":
      return "Knowledge";
    case "plugins":
      return "Plugins";
    case "skills":
      return "Skills";
    case "advanced":
      return "Fine-Tuning";
    case "fine-tuning":
      return "Fine-Tuning";
    case "trajectories":
      return "Trajectories";
    case "relationships":
      return "Relationships";
    case "memories":
      return "Memories";
    case "rolodex":
      return "Rolodex";
    case "voice":
      return "Voice";
    case "runtime":
      return "Runtime";
    case "database":
      return "Databases";
    case "settings":
      return "Settings";
    case "logs":
      return "Logs";
    case "stream":
      return "Stream";
    default:
      // Dynamic plugin tabs — capitalize the tab ID as a fallback title.
      return tab.charAt(0).toUpperCase() + tab.slice(1).replace(/-/g, " ");
  }
}

export {
  getMainTabApp,
  MAIN_TAB_FALLBACK,
  type MainTabApp,
  resolveDefaultLandingTab,
} from "./main-tab";
