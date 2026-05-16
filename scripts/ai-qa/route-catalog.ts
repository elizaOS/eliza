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

const ROOT_READY: readonly ReadyCheck[] = [{ selector: "#root" }];

export const AI_QA_ROUTES: readonly AiQaRoute[] = [
  { id: "chat", path: "/chat", label: "Chat", readyChecks: ROOT_READY },
  {
    id: "connectors",
    path: "/connectors",
    label: "Connectors",
    readyChecks: ROOT_READY,
  },
  { id: "apps", path: "/apps", label: "Apps", readyChecks: ROOT_READY },
  { id: "views", path: "/views", label: "Views", readyChecks: ROOT_READY },
  {
    id: "lifeops",
    path: "/apps/lifeops",
    label: "LifeOps",
    readyChecks: ROOT_READY,
  },
  {
    id: "plugins",
    path: "/apps/plugins",
    label: "Plugins",
    readyChecks: ROOT_READY,
  },
  {
    id: "skills",
    path: "/apps/skills",
    label: "Skills",
    readyChecks: ROOT_READY,
  },
  {
    id: "fine-tuning",
    path: "/apps/fine-tuning",
    label: "Fine-Tuning",
    readyChecks: ROOT_READY,
  },
  {
    id: "trajectories",
    path: "/apps/trajectories",
    label: "Trajectories",
    readyChecks: ROOT_READY,
  },
  {
    id: "relationships",
    path: "/apps/relationships",
    label: "Relationships",
    readyChecks: ROOT_READY,
  },
  {
    id: "memories",
    path: "/apps/memories",
    label: "Memories",
    readyChecks: ROOT_READY,
  },
  {
    id: "runtime",
    path: "/apps/runtime",
    label: "Runtime",
    readyChecks: ROOT_READY,
  },
  {
    id: "database",
    path: "/apps/database",
    label: "Databases",
    readyChecks: ROOT_READY,
  },
  { id: "logs", path: "/apps/logs", label: "Logs", readyChecks: ROOT_READY },
  {
    id: "tasks",
    path: "/apps/tasks",
    label: "Tasks",
    readyChecks: ROOT_READY,
  },
  {
    id: "character",
    path: "/character",
    label: "Character",
    readyChecks: ROOT_READY,
  },
  {
    id: "documents",
    path: "/character/documents",
    label: "Knowledge",
    readyChecks: ROOT_READY,
  },
  {
    id: "wallet",
    path: "/wallet",
    label: "Wallet",
    readyChecks: ROOT_READY,
  },
  {
    id: "browser",
    path: "/browser",
    label: "Browser",
    readyChecks: ROOT_READY,
  },
  {
    id: "stream",
    path: "/stream",
    label: "Stream",
    readyChecks: ROOT_READY,
  },
  {
    id: "automations",
    path: "/automations",
    label: "Automations",
    readyChecks: ROOT_READY,
  },
  {
    id: "settings",
    path: "/settings",
    label: "Settings",
    readyChecks: [{ selector: '[data-testid="settings-shell"]' }],
    timeoutMs: 60_000,
  },
  {
    id: "voice",
    path: "/settings/voice",
    label: "Voice",
    readyChecks: ROOT_READY,
  },
];

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: "identity", label: "Basics", match: /Basics|Identity/i },
  { id: "ai-model", label: "Providers", match: /Providers|AI Model/i },
  { id: "runtime", label: "Runtime", match: /Runtime/i },
  { id: "appearance", label: "Appearance", match: /Appearance/i },
  { id: "capabilities", label: "Capabilities", match: /Capabilities/i },
  { id: "apps", label: "Apps", match: /Apps/i },
  {
    id: "app-permissions",
    label: "App Permissions",
    match: /App Permissions/i,
  },
  { id: "wallet-rpc", label: "Wallet & RPC", match: /Wallet|RPC/i },
  { id: "permissions", label: "Permissions", match: /^Permissions$/i },
  { id: "secrets", label: "Vault", match: /Vault|Secrets/i },
  { id: "security", label: "Security", match: /Security/i },
  { id: "updates", label: "Updates", match: /Updates/i },
  { id: "advanced", label: "Backup & Reset", match: /Backup|Reset|Advanced/i },
];
