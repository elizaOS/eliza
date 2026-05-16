export type Theme = "light" | "dark";
export type ViewportName = "desktop" | "tablet" | "mobile";

export type ReadyCheck =
  | { selector: string; text?: never }
  | { selector?: never; text: string };

export type AiQaRoute = {
  id: string;
  label: string;
  path: string;
  readyChecks: readonly ReadyCheck[];
  readyMode?: "all" | "any";
  timeoutMs?: number;
  viewports?: readonly ViewportName[];
};

export type SettingsSection = {
  id: string;
  label: string;
  match: string | RegExp;
};

export const VIEWPORT_SIZES: Record<
  ViewportName,
  { width: number; height: number }
> = {
  desktop: { width: 1440, height: 1000 },
  tablet: { width: 1024, height: 768 },
  mobile: { width: 390, height: 844 },
};

export const AI_QA_ROUTES: readonly AiQaRoute[] = [
  {
    id: "chat",
    label: "Chat",
    path: "/chat",
    readyChecks: [
      { selector: '[data-testid="conversations-sidebar"]' },
      { selector: '[data-testid="chat-composer-textarea"]' },
      { selector: '[data-testid="chat-widgets-bar"]' },
    ],
    readyMode: "all",
  },
  {
    id: "apps",
    label: "Apps",
    path: "/apps",
    readyChecks: [{ text: "No views available" }],
  },
  {
    id: "settings",
    label: "Settings",
    path: "/settings",
    readyChecks: [{ selector: '[data-testid="settings-shell"]' }],
  },
];

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: "identity", label: "Basics", match: "Basics" },
  { id: "ai-model", label: "Providers", match: "Providers" },
  { id: "runtime", label: "Runtime", match: "Runtime" },
  { id: "appearance", label: "Appearance", match: "Appearance" },
  { id: "voice", label: "Voice", match: "Voice" },
  { id: "capabilities", label: "Capabilities", match: "Capabilities" },
  { id: "apps", label: "Apps", match: "Apps" },
  { id: "carrots", label: "Carrots", match: "Carrots" },
  { id: "connectors", label: "Connectors", match: "Connectors" },
  {
    id: "app-permissions",
    label: "App Permissions",
    match: "App Permissions",
  },
  { id: "wallet-rpc", label: "Wallet & RPC", match: "Wallet & RPC" },
  { id: "permissions", label: "Permissions", match: "Permissions" },
  { id: "advanced", label: "Advanced", match: "Advanced" },
];
