import {
  Archive,
  Brain,
  Carrot,
  KeyRound,
  LayoutGrid,
  Lock,
  type LucideIcon,
  Mic,
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
import { CarrotManagerSection } from "./CarrotManagerSection";
import { ConnectorsSection } from "./ConnectorsSection";
import { IdentitySettingsSection } from "./IdentitySettingsSection";
import { PermissionsSection } from "./PermissionsSection";
import { ProviderSwitcher } from "./ProviderSwitcher";
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

export interface SettingsSectionDef {
  id: string;
  label: string;
  defaultLabel: string;
  icon: LucideIcon;
  tone: SettingsSectionTone;
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
    titleKey: "settings.sections.apps.label",
    defaultTitle: "Apps",
    Component: AppsManagementSection,
  },
  {
    id: "carrots",
    label: "settings.sections.carrots.label",
    defaultLabel: "Carrots",
    icon: Carrot,
    tone: "accent",
    titleKey: "settings.sections.carrots.label",
    defaultTitle: "Carrots",
    Component: CarrotManagerSection,
  },
  {
    id: "connectors",
    label: "settings.sections.connectors.label",
    defaultLabel: "Connectors",
    icon: Webhook,
    tone: "accent",
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
