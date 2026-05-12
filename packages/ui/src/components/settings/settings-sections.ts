import {
  Archive,
  Brain,
  KeyRound,
  LayoutGrid,
  Lock,
  type LucideIcon,
  Palette,
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
import { RuntimeSettingsSection } from "./RuntimeSettingsSection";
import { SecretsManagerSection } from "./SecretsManagerSection";
import { SecuritySettingsSection } from "./SecuritySettingsSection";
import { WalletRpcSection } from "./WalletRpcSection";

export type SettingsSectionTone =
  | "ok"
  | "warn"
  | "muted"
  | "accent"
  | "neutral";

export interface SettingsSectionDef {
  id: string;
  label: string;
  defaultLabel: string;
  icon: LucideIcon;
  tone: SettingsSectionTone;
  tooltipDescription?: string;
  defaultTooltipDescription?: string;
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

export const SETTINGS_SECTIONS: SettingsSectionDef[] = [
  {
    id: "identity",
    label: "settings.sections.identity.label",
    defaultLabel: "Basics",
    icon: User,
    tone: "neutral",
    tooltipDescription: "settings.sections.identity.desc",
    defaultTooltipDescription: "Name, voice, prompt.",
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
    tooltipDescription: "settings.sections.aimodel.desc",
    defaultTooltipDescription: "Cloud, local, subscriptions, keys.",
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
    tooltipDescription: "settings.sections.runtime.desc",
    defaultTooltipDescription: "Local, cloud, or remote.",
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
    tooltipDescription: "settings.sections.appearance.desc",
    defaultTooltipDescription: "Language, theme, packs.",
    titleKey: "settings.sections.appearance.label",
    defaultTitle: "Appearance",
    Component: AppearanceSettingsSection,
  },
  {
    id: "capabilities",
    label: "settings.sections.capabilities.label",
    defaultLabel: "Capabilities",
    icon: SlidersHorizontal,
    tone: "accent",
    tooltipDescription: "settings.sections.capabilities.desc",
    defaultTooltipDescription: "Agent features and automations.",
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
    tooltipDescription: "settings.sections.apps.desc",
    defaultTooltipDescription: "Installed apps and creation.",
    titleKey: "settings.sections.apps.label",
    defaultTitle: "Apps",
    Component: AppsManagementSection,
  },
  {
    id: "connectors",
    label: "settings.sections.connectors.label",
    defaultLabel: "Connectors",
    icon: Webhook,
    tone: "accent",
    tooltipDescription: "settings.sections.connectors.desc",
    defaultTooltipDescription: "Telegram, Discord, iMessage.",
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
    tooltipDescription: "settings.sections.apppermissions.desc",
    defaultTooltipDescription: "Per-app filesystem and network grants.",
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
    tooltipDescription: "settings.sections.walletrpc.desc",
    defaultTooltipDescription: "Wallet network and RPC.",
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
    tooltipDescription: "settings.sections.permissions.desc",
    defaultTooltipDescription: "Browser and device access.",
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
    tooltipDescription: "settings.sections.secrets.desc",
    defaultTooltipDescription: "Secrets, logins, routing.",
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
    tooltipDescription: "settings.sections.security.desc",
    defaultTooltipDescription: "Local and remote access.",
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
    tooltipDescription: "settings.sections.updates.desc",
    defaultTooltipDescription: "Software updates.",
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
    tooltipDescription: "settings.sections.backupReset.desc",
    defaultTooltipDescription: "Export, import, reset.",
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

export function settingsSectionTooltip(
  section: SettingsSectionDef,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string | undefined {
  if (!section.tooltipDescription) return section.defaultTooltipDescription;
  return t(section.tooltipDescription, {
    defaultValue: section.defaultTooltipDescription ?? "",
  });
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
