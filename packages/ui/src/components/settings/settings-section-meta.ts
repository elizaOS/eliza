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
  /**
   * Extra friendly tokens a user can type to jump here via `/settings <token>`,
   * beyond the `id` itself (which is always a token). This is the single source
   * of truth for a section's aliases; `settings-section-tokens.ts` derives the
   * token map from this field so the two never drift. Owner-declared, so a
   * plugin-registered section carries its own aliases (see the `aliases` field
   * on {@link SettingsSectionDef}) instead of needing a host edit to a central
   * literal.
   */
  aliases?: readonly string[];
}

export interface SettingsNonCatalogSectionMeta {
  /** Stable id — also the URL hash and agent-surface address. */
  id: string;
  /** English display label (the i18n default value). */
  defaultLabel: string;
  /** Group may include host-registered groups outside the pinned catalog. */
  group: SettingsSectionGroup | (string & {});
  aliases?: readonly string[];
}

export const SETTINGS_GROUP_ORDER: SettingsSectionGroup[] = [
  "agent",
  "system",
  "security",
];

export const SETTINGS_GROUP_LABEL: Record<SettingsSectionGroup, string> = {
  agent: "Agent",
  system: "App",
  security: "Privacy & Security",
};

/**
 * Display order is array order, bucketed by group. Keep new built-ins grouped
 * with their peers so the nav reads top-to-bottom the way it renders.
 */
export const SETTINGS_SECTION_META: SettingsSectionMeta[] = [
  {
    id: "identity",
    defaultLabel: "Basics",
    group: "agent",
    aliases: ["basics", "profile"],
  },
  {
    id: "ai-model",
    defaultLabel: "Models & Providers",
    group: "agent",
    aliases: ["model", "models", "provider", "providers", "ai", "cloud"],
  },
  {
    id: "voice",
    defaultLabel: "Voice",
    group: "agent",
    aliases: ["tts", "speech"],
  },
  {
    id: "capabilities",
    defaultLabel: "Capabilities",
    group: "agent",
    aliases: ["abilities"],
  },
  { id: "apps", defaultLabel: "Apps", group: "agent", aliases: ["views"] },
  {
    id: "connectors",
    defaultLabel: "Connectors",
    group: "agent",
    aliases: ["connections", "integrations"],
  },
  // System group: most-used personalization first (appearance, background),
  // then infrastructure (runtime, wallet, remote plugins), then maintenance
  // (updates, backups) last so common taps are not buried behind rare ones.
  {
    id: "appearance",
    defaultLabel: "Appearance",
    group: "system",
    aliases: ["theme", "look"],
  },
  { id: "background", defaultLabel: "Background", group: "system" },
  { id: "runtime", defaultLabel: "Runtime", group: "system" },
  {
    id: "wallet-rpc",
    defaultLabel: "Wallet & RPC",
    group: "system",
    aliases: ["wallet", "rpc"],
  },
  {
    id: "remote-plugins",
    defaultLabel: "Remote Plugins",
    group: "system",
    aliases: ["remote"],
  },
  {
    id: "updates",
    defaultLabel: "Updates",
    group: "system",
    aliases: ["update"],
  },
  {
    id: "advanced",
    defaultLabel: "Backups",
    group: "system",
    aliases: ["fine-tuning", "backup", "backups"],
  },
  // Security group: the everyday key/secret store (Vault) first, then the two
  // permission surfaces, then the host-only remote-access section last.
  {
    id: "secrets",
    defaultLabel: "Vault",
    group: "security",
    aliases: ["vault", "keys"],
  },
  {
    id: "permissions",
    defaultLabel: "Permissions",
    group: "security",
    aliases: ["perms"],
  },
  { id: "app-permissions", defaultLabel: "App Permissions", group: "security" },
  { id: "security", defaultLabel: "Security", group: "security" },
];

/**
 * Built-in settings sections that intentionally stay out of the app-core route
 * catalog but still register in Settings. Action-side audits consume this list
 * so chat-write coverage for late-registered sections cannot drift silently.
 */
export const SETTINGS_NON_CATALOG_SECTION_META = [
  {
    id: "cloud-overview",
    defaultLabel: "Overview",
    group: "cloud",
  },
  {
    id: "cloud-agents",
    defaultLabel: "Agents",
    group: "cloud",
  },
  {
    id: "my-runtimes",
    defaultLabel: "My Runtimes",
    group: "system",
  },
] as const satisfies readonly SettingsNonCatalogSectionMeta[];
