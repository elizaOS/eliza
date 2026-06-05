import {
  Archive,
  Brain,
  KeyRound,
  LayoutGrid,
  Lock,
  type LucideIcon,
  Mic,
  Palette,
  Puzzle,
  RefreshCw,
  Server,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  User,
  Wallet,
  Webhook,
} from "lucide-react";
import type { ComponentType } from "react";
import { ReleaseCenterView } from "../pages/ReleaseCenterView";
import { AdvancedSection } from "./AdvancedSection";
import { AppearanceSettingsSection } from "./AppearanceSettingsSection";
import { AppPermissionsSection } from "./AppPermissionsSection";
import { AppsManagementSection } from "./AppsManagementSection";
import { CapabilitiesSection } from "./CapabilitiesSection";
import { ConnectorsSection } from "./ConnectorsSection";
import { IdentitySettingsSection } from "./IdentitySettingsSection";
import { PermissionsSection } from "./PermissionsSection";
import { ProviderSwitcher } from "./ProviderSwitcher";
import { RemotePluginHostSection } from "./RemotePluginHostSection";
import { RuntimeSettingsSection } from "./RuntimeSettingsSection";
import { SecretsManagerSection } from "./SecretsManagerSection";
import { SecuritySettingsSection } from "./SecuritySettingsSection";
import { VoiceSectionMount } from "./VoiceSectionMount";
import { WalletRpcSection } from "./WalletRpcSection";

export type SettingsSectionTone =
  | "ok"
  | "warn"
  | "muted"
  | "accent"
  | "neutral";

/** Curated, token-safe medallion tints for the settings hub tiles. No blue. */
export type SettingsSectionHue = "accent" | "amber" | "rose" | "slate";

/** Top-level grouping for the visual hub. */
export type SettingsSectionGroup = "agent" | "system" | "security";

export interface SettingsSectionDef {
  id: string;
  label: string;
  defaultLabel: string;
  icon: LucideIcon;
  tone: SettingsSectionTone;
  hue: SettingsSectionHue;
  group: SettingsSectionGroup;
  titleKey: string;
  defaultTitle: string;
  bodyClassName?: string;
  Component: ComponentType;
}

export const SECTION_TONE_ICON_CLASS: Record<SettingsSectionTone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  muted: "text-muted",
  accent: "text-accent",
  neutral: "",
};

/**
 * Medallion styling per hue. All colors resolve from theme tokens (orange
 * accent + neutrals) so light and dark themes both work, and there is no blue.
 */
export const SECTION_HUE_MEDALLION_CLASS: Record<SettingsSectionHue, string> = {
  accent: "bg-accent/12 text-accent ring-1 ring-accent/20",
  amber: "bg-warn/12 text-warn ring-1 ring-warn/20",
  rose: "bg-[color-mix(in_oklab,var(--accent)_14%,var(--surface))] text-accent ring-1 ring-accent/15",
  slate: "bg-surface text-txt-strong ring-1 ring-border",
};

export const SETTINGS_GROUP_LABEL: Record<SettingsSectionGroup, string> = {
  agent: "Agent",
  system: "System",
  security: "Security",
};

export const SETTINGS_GROUP_ORDER: SettingsSectionGroup[] = [
  "agent",
  "system",
  "security",
];

export const SETTINGS_SECTIONS: SettingsSectionDef[] = [
  {
    id: "identity",
    label: "settings.sections.identity.label",
    defaultLabel: "Basics",
    icon: User,
    tone: "neutral",
    hue: "slate",
    group: "agent",
    titleKey: "settings.sections.identity.label",
    defaultTitle: "Basics",
    Component: IdentitySettingsSection,
  },
  {
    id: "ai-model",
    label: "settings.sections.aimodel.label",
    defaultLabel: "Providers",
    icon: Brain,
    tone: "accent",
    hue: "accent",
    group: "agent",
    titleKey: "common.providers",
    defaultTitle: "Providers",
    Component: ProviderSwitcher,
  },
  {
    id: "runtime",
    label: "settings.sections.runtime.label",
    defaultLabel: "Runtime",
    icon: Server,
    tone: "neutral",
    hue: "slate",
    group: "system",
    titleKey: "settings.sections.runtime.label",
    defaultTitle: "Runtime",
    Component: RuntimeSettingsSection,
  },
  {
    id: "appearance",
    label: "settings.sections.appearance.label",
    defaultLabel: "Appearance",
    icon: Palette,
    tone: "neutral",
    hue: "rose",
    group: "system",
    titleKey: "settings.sections.appearance.label",
    defaultTitle: "Appearance",
    Component: AppearanceSettingsSection,
  },
  {
    id: "voice",
    label: "settings.sections.voice.label",
    defaultLabel: "Voice",
    icon: Mic,
    tone: "accent",
    hue: "accent",
    group: "agent",
    titleKey: "settings.sections.voice.label",
    defaultTitle: "Voice",
    Component: VoiceSectionMount,
  },
  {
    id: "capabilities",
    label: "settings.sections.capabilities.label",
    defaultLabel: "Capabilities",
    icon: SlidersHorizontal,
    tone: "accent",
    hue: "accent",
    group: "agent",
    titleKey: "common.capabilities",
    defaultTitle: "Capabilities",
    Component: CapabilitiesSection,
  },
  {
    id: "apps",
    label: "settings.sections.apps.label",
    defaultLabel: "Apps",
    icon: LayoutGrid,
    tone: "accent",
    hue: "accent",
    group: "agent",
    titleKey: "settings.sections.apps.label",
    defaultTitle: "Apps",
    Component: AppsManagementSection,
  },
  {
    id: "remote-plugins",
    label: "settings.sections.remote-plugins.label",
    defaultLabel: "Remote Plugins",
    icon: Puzzle,
    tone: "accent",
    hue: "rose",
    group: "system",
    titleKey: "settings.sections.remote-plugins.label",
    defaultTitle: "Remote Plugins",
    Component: RemotePluginHostSection,
  },
  {
    id: "connectors",
    label: "settings.sections.connectors.label",
    defaultLabel: "Connectors",
    icon: Webhook,
    tone: "accent",
    hue: "accent",
    group: "agent",
    titleKey: "settings.sections.connectors.label",
    defaultTitle: "Connectors",
    Component: ConnectorsSection,
  },
  {
    id: "app-permissions",
    label: "settings.sections.apppermissions.label",
    defaultLabel: "App Permissions",
    icon: ShieldCheck,
    tone: "warn",
    hue: "amber",
    group: "security",
    titleKey: "settings.sections.apppermissions.label",
    defaultTitle: "App Permissions",
    Component: AppPermissionsSection,
  },
  {
    id: "wallet-rpc",
    label: "settings.sections.walletrpc.label",
    defaultLabel: "Wallet & RPC",
    icon: Wallet,
    tone: "neutral",
    hue: "slate",
    group: "system",
    titleKey: "settings.sections.walletrpc.label",
    defaultTitle: "Wallet & RPC",
    bodyClassName: "p-4 sm:p-5",
    Component: WalletRpcSection,
  },
  {
    id: "permissions",
    label: "settings.sections.permissions.label",
    defaultLabel: "Permissions",
    icon: Shield,
    tone: "warn",
    hue: "amber",
    group: "security",
    titleKey: "common.permissions",
    defaultTitle: "Permissions",
    Component: PermissionsSection,
  },
  {
    id: "secrets",
    label: "settings.sections.secrets.label",
    defaultLabel: "Vault",
    icon: KeyRound,
    tone: "warn",
    hue: "amber",
    group: "security",
    titleKey: "settings.sections.secrets.label",
    defaultTitle: "Vault",
    Component: SecretsManagerSection,
  },
  {
    id: "security",
    label: "settings.sections.security.label",
    defaultLabel: "Security",
    icon: Lock,
    tone: "warn",
    hue: "amber",
    group: "security",
    titleKey: "settings.sections.security.label",
    defaultTitle: "Security",
    Component: SecuritySettingsSection,
  },
  {
    id: "updates",
    label: "settings.sections.updates.label",
    defaultLabel: "Updates",
    icon: RefreshCw,
    tone: "neutral",
    hue: "slate",
    group: "system",
    titleKey: "settings.sections.updates.label",
    defaultTitle: "Updates",
    Component: ReleaseCenterView,
  },
  {
    id: "advanced",
    label: "settings.sections.backupReset.label",
    defaultLabel: "Backup & Reset",
    icon: Archive,
    tone: "neutral",
    hue: "slate",
    group: "system",
    titleKey: "settings.sections.backupReset.label",
    defaultTitle: "Backup & Reset",
    Component: AdvancedSection,
  },
];

export function settingsSectionLabel(
  section: SettingsSectionDef,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string {
  return t(section.label, { defaultValue: section.defaultLabel });
}

export function settingsSectionTitle(
  section: SettingsSectionDef,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string {
  return t(section.titleKey, { defaultValue: section.defaultTitle });
}

export function readSettingsHashSection(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return null;
  if (hash === "cloud") return "ai-model";
  return SETTINGS_SECTIONS.some((section) => section.id === hash) ? hash : null;
}

export function replaceSettingsHash(sectionId: string): void {
  if (typeof window === "undefined") return;
  const nextHash = `#${sectionId}`;
  if (window.location.hash === nextHash) return;
  window.history.replaceState(null, "", nextHash);
}
