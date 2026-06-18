/**
 * Canonical metadata for the built-in settings sections: id, English label, and
 * top-level group. Pure data (no React, no icons) so non-renderer consumers —
 * notably app-core's `dev-route-catalog` parity test — can import it and assert
 * the QA catalog never drifts from the UI without pulling the renderer graph.
 *
 * The React registry (`settings-sections.ts`) reads this list and attaches the
 * icon, medallion hue, and section component per id. This is the single source
 * of truth for built-in section ids, labels, and grouping.
 */

export type SettingsSectionGroup = "agent" | "system" | "security";

export interface SettingsSectionMeta {
  /** Stable id — also the URL hash and agent-surface address. */
  id: string;
  /** English display label (the i18n default value). */
  defaultLabel: string;
  group: SettingsSectionGroup;
}

export const SETTINGS_GROUP_ORDER: SettingsSectionGroup[] = [
  "agent",
  "system",
  "security",
];

export const SETTINGS_GROUP_LABEL: Record<SettingsSectionGroup, string> = {
  agent: "Agent",
  system: "System",
  security: "Security",
};

/**
 * Display order is array order, bucketed by group. Keep new built-ins grouped
 * with their peers so the nav reads top-to-bottom the way it renders.
 */
export const SETTINGS_SECTION_META: SettingsSectionMeta[] = [
  { id: "identity", defaultLabel: "Basics", group: "agent" },
  { id: "ai-model", defaultLabel: "Models & Providers", group: "agent" },
  { id: "voice", defaultLabel: "Voice", group: "agent" },
  { id: "capabilities", defaultLabel: "Capabilities", group: "agent" },
  { id: "apps", defaultLabel: "Apps", group: "agent" },
  { id: "connectors", defaultLabel: "Connectors", group: "agent" },
  { id: "runtime", defaultLabel: "Runtime", group: "system" },
  { id: "appearance", defaultLabel: "Appearance", group: "system" },
  { id: "remote-plugins", defaultLabel: "Remote Plugins", group: "system" },
  { id: "wallet-rpc", defaultLabel: "Wallet & RPC", group: "system" },
  { id: "updates", defaultLabel: "Updates", group: "system" },
  { id: "advanced", defaultLabel: "Backup & Reset", group: "system" },
  { id: "app-permissions", defaultLabel: "App Permissions", group: "security" },
  { id: "permissions", defaultLabel: "Permissions", group: "security" },
  { id: "secrets", defaultLabel: "Vault", group: "security" },
  { id: "security", defaultLabel: "Security", group: "security" },
];
