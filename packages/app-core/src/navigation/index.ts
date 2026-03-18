/**
 * Navigation — tabs + onboarding.
 */

import type { LucideIcon } from "lucide-react";
import {
  Brain,
  Clock3,
  Gamepad2,
  MessageSquare,
  Radio,
  Settings,
  Share2,
  Sparkles,
  Wallet,
} from "lucide-react";
import { DEFAULT_BRANDING } from "../config/branding";

/** Apps are only enabled in dev mode; production builds hide this feature. */
export const APPS_ENABLED = false; // import.meta.env.DEV;

/** Stream routes stay addressable; the nav hides the tab unless streaming is enabled. */
export const STREAM_ENABLED = true;
/**
 * Companion tab — enabled by default since the VRM companion UI launch.
 * Previously opt-in; now opt-out via VITE_ENABLE_COMPANION_MODE=false.
 */
export const COMPANION_ENABLED =
  String(import.meta.env.VITE_ENABLE_COMPANION_MODE ?? "true").toLowerCase() !==
  "false";

export type Tab =
  | "chat"
  | "companion"
  | "stream"
  | "apps"
  | "character"
  | "character-select"
  | "wallets"
  | "knowledge"
  | "connectors"
  | "triggers"
  | "plugins"
  | "skills"
  | "actions"
  | "advanced"
  | "fine-tuning"
  | "trajectories"
  | "lifo"
  | "voice"
  | "runtime"
  | "database"
  | "settings"
  | "logs"
  | "security";

export interface TabGroup {
  label: string;
  tabs: Tab[];
  icon: LucideIcon;
  description?: string;
}

export const ALL_TAB_GROUPS: TabGroup[] = [
  {
    label: "Chat",
    tabs: ["chat"],
    icon: MessageSquare,
    description: "Conversations and messaging",
  },
  {
    label: "Stream",
    tabs: ["stream"],
    icon: Radio,
    description: "Live streaming controls",
  },
  {
    label: "Wallets",
    tabs: ["wallets"],
    icon: Wallet,
    description: "Crypto wallets and inventory",
  },
  {
    label: "Knowledge",
    tabs: ["knowledge"],
    icon: Brain,
    description: "Documents and memory",
  },
  {
    label: "Connectors",
    tabs: ["connectors"],
    icon: Share2,
    description: "Service and data source connections",
  },
  {
    label: "Apps",
    tabs: ["apps"],
    icon: Gamepad2,
    description: "Games and integrations",
  },
  {
    label: "Settings",
    tabs: ["settings"],
    icon: Settings,
    description: "Configuration and preferences",
  },
  {
    label: "Heartbeats",
    tabs: ["triggers"],
    icon: Clock3,
    description: "Scheduled autonomous automations",
  },

  {
    label: "Advanced",
    tabs: [
      "advanced",
      "plugins",
      "skills",
      "actions",
      "fine-tuning",
      "trajectories",
      "lifo",
      "runtime",
      "database",
      "logs",
      "security",
    ],
    icon: Sparkles,
    description: "Developer and power user tools",
  },
];

/** Compute visible tab groups. Pass streamEnabled explicitly for React reactivity. */
export function getTabGroups(streamEnabled = STREAM_ENABLED): TabGroup[] {
  return ALL_TAB_GROUPS.filter(
    (g) =>
      (APPS_ENABLED || g.label !== "Apps") &&
      (streamEnabled || g.label !== "Stream"),
  );
}

const TAB_PATHS: Record<Tab, string> = {
  chat: "/chat",
  companion: "/companion",
  stream: "/stream",
  apps: "/apps",
  character: "/character",
  "character-select": "/character-select",
  triggers: "/triggers",
  wallets: "/wallets",
  knowledge: "/knowledge",
  connectors: "/connectors",
  plugins: "/plugins",
  skills: "/skills",
  actions: "/actions",
  advanced: "/advanced",
  "fine-tuning": "/fine-tuning",
  trajectories: "/trajectories",
  lifo: "/lifo",
  voice: "/voice",
  runtime: "/runtime",
  database: "/database",
  settings: "/settings",
  logs: "/logs",
  security: "/security",
};

/** Legacy path redirects — old paths that now map to new tabs. */
const LEGACY_PATHS: Record<string, Tab> = {
  "/game": "apps",
  "/agent": "character",
  "/inventory": "wallets",
  "/features": "plugins",
  "/admin": "advanced",
  "/config": "settings",
  "/triggers": "triggers",
};

const PATH_TO_TAB = new Map(
  Object.entries(TAB_PATHS).map(([tab, p]) => [p, tab as Tab]),
);

export function pathForTab(tab: Tab, basePath = ""): string {
  const base = normalizeBasePath(basePath);
  const p = TAB_PATHS[tab];
  return base ? `${base}${p}` : p;
}

export function tabFromPath(pathname: string, basePath = ""): Tab | null {
  const base = normalizeBasePath(basePath);
  let p = pathname || "/";
  if (base) {
    if (p === base) p = "/";
    else if (p.startsWith(`${base}/`)) p = p.slice(base.length);
  }
  let normalized = normalizePath(p).toLowerCase();
  if (normalized.endsWith("/index.html")) normalized = "/";
  if (normalized === "/") return "chat";
  if (normalized === "/voice") return "settings";
  // Companion disabled unless explicitly feature-flagged
  if (
    !COMPANION_ENABLED &&
    (normalized === "/companion" || normalized === "/character-select")
  ) {
    return "chat";
  }
  // Apps disabled in production builds — redirect to chat
  if (!APPS_ENABLED && (normalized === "/apps" || normalized === "/game")) {
    return "chat";
  }
  // Stream tab (always enabled)
  // Check current paths first, then legacy redirects
  return PATH_TO_TAB.get(normalized) ?? LEGACY_PATHS[normalized] ?? null;
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

export function titleForTab(tab: Tab): string {
  switch (tab) {
    case "chat":
      return "Chat";
    case "companion":
      return "Companion";
    case "apps":
      return "Apps";
    case "character":
      return "Character";
    case "character-select":
      return "Character Select";
    case "triggers":
      return "Heartbeats";
    case "wallets":
      return "Wallets";
    case "knowledge":
      return "Knowledge";
    case "connectors":
      return "Connectors";
    case "plugins":
      return "Plugins";
    case "skills":
      return "Skills";
    case "actions":
      return "Actions";
    case "advanced":
      return "Advanced";
    case "fine-tuning":
      return "Fine-Tuning";
    case "trajectories":
      return "Trajectories";
    case "lifo":
      return "Lifo";
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
    case "security":
      return "Security";
    default:
      return DEFAULT_BRANDING.appName;
  }
}
