import {
  Archive,
  Bot,
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
import { CloudAgentsSection } from "./CloudAgentsSection";
import { ConnectorsSection } from "./ConnectorsSection";
import { IdentitySettingsSection } from "./IdentitySettingsSection";
import { PermissionsSection } from "./PermissionsSection";
import { ProviderSwitcher } from "./ProviderSwitcher";
import { RemotePluginHostSection } from "./RemotePluginHostSection";
import { RuntimeSettingsSection } from "./RuntimeSettingsSection";
import { SecretsManagerSection } from "./SecretsManagerSection";
import { SecuritySettingsSection } from "./SecuritySettingsSection";
import {
  SETTINGS_GROUP_LABEL,
  SETTINGS_GROUP_ORDER,
  SETTINGS_SECTION_META,
  type SettingsSectionGroup,
} from "./settings-section-meta";
import {
  listSettingsSections,
  registerSettingsSection,
  type SettingsSectionDef,
  type SettingsSectionHue,
  type SettingsSectionTone,
} from "./settings-section-registry";
import { VoiceSectionMount } from "./VoiceSectionMount";
import { WalletRpcSection } from "./WalletRpcSection";

export {
  getSettingsSection,
  listSettingsSections,
  registerSettingsSection,
} from "./settings-section-registry";
export type {
  SettingsSectionDef,
  SettingsSectionGroup,
  SettingsSectionHue,
  SettingsSectionTone,
};
export { SETTINGS_GROUP_LABEL, SETTINGS_GROUP_ORDER };

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

/** Per-section visuals + component, keyed by the id declared in the meta list. */
interface SectionVisual {
  icon: LucideIcon;
  tone: SettingsSectionTone;
  hue: SettingsSectionHue;
  /** i18n key for the nav label. */
  labelKey: string;
  /** i18n key for the section header, when it differs from the label. */
  titleKey?: string;
  bodyClassName?: string;
  Component: ComponentType;
}

const SECTION_VISUALS: Record<string, SectionVisual> = {
  identity: {
    icon: User,
    tone: "neutral",
    hue: "slate",
    labelKey: "settings.sections.identity.label",
    Component: IdentitySettingsSection,
  },
  "ai-model": {
    icon: Brain,
    tone: "accent",
    hue: "accent",
    labelKey: "settings.sections.aimodel.label",
    Component: ProviderSwitcher,
  },
  voice: {
    icon: Mic,
    tone: "accent",
    hue: "accent",
    labelKey: "settings.sections.voice.label",
    Component: VoiceSectionMount,
  },
  capabilities: {
    icon: SlidersHorizontal,
    tone: "accent",
    hue: "accent",
    labelKey: "settings.sections.capabilities.label",
    titleKey: "common.capabilities",
    Component: CapabilitiesSection,
  },
  apps: {
    icon: LayoutGrid,
    tone: "accent",
    hue: "accent",
    labelKey: "settings.sections.apps.label",
    Component: AppsManagementSection,
  },
  connectors: {
    icon: Webhook,
    tone: "accent",
    hue: "accent",
    labelKey: "settings.sections.connectors.label",
    Component: ConnectorsSection,
  },
  runtime: {
    icon: Server,
    tone: "neutral",
    hue: "slate",
    labelKey: "settings.sections.runtime.label",
    Component: RuntimeSettingsSection,
  },
  appearance: {
    icon: Palette,
    tone: "neutral",
    hue: "rose",
    labelKey: "settings.sections.appearance.label",
    Component: AppearanceSettingsSection,
  },
  "remote-plugins": {
    icon: Puzzle,
    tone: "accent",
    hue: "rose",
    labelKey: "settings.sections.remote-plugins.label",
    Component: RemotePluginHostSection,
  },
  "wallet-rpc": {
    icon: Wallet,
    tone: "neutral",
    hue: "slate",
    labelKey: "settings.sections.walletrpc.label",
    bodyClassName: "p-4 sm:p-5",
    Component: WalletRpcSection,
  },
  updates: {
    icon: RefreshCw,
    tone: "neutral",
    hue: "slate",
    labelKey: "settings.sections.updates.label",
    Component: ReleaseCenterView,
  },
  advanced: {
    icon: Archive,
    tone: "neutral",
    hue: "slate",
    labelKey: "settings.sections.backupReset.label",
    Component: AdvancedSection,
  },
  "app-permissions": {
    icon: ShieldCheck,
    tone: "warn",
    hue: "amber",
    labelKey: "settings.sections.apppermissions.label",
    Component: AppPermissionsSection,
  },
  permissions: {
    icon: Shield,
    tone: "warn",
    hue: "amber",
    labelKey: "settings.sections.permissions.label",
    titleKey: "common.permissions",
    Component: PermissionsSection,
  },
  secrets: {
    icon: KeyRound,
    tone: "warn",
    hue: "amber",
    labelKey: "settings.sections.secrets.label",
    Component: SecretsManagerSection,
  },
  security: {
    icon: Lock,
    tone: "warn",
    hue: "amber",
    labelKey: "settings.sections.security.label",
    Component: SecuritySettingsSection,
  },
};

/** Built-in sections, in display order, derived from the canonical meta list. */
export const SETTINGS_SECTIONS: SettingsSectionDef[] =
  SETTINGS_SECTION_META.map((meta, index): SettingsSectionDef => {
    const visual = SECTION_VISUALS[meta.id];
    if (!visual) {
      throw new Error(`Missing settings-section visuals for "${meta.id}"`);
    }
    return {
      id: meta.id,
      label: visual.labelKey,
      defaultLabel: meta.defaultLabel,
      icon: visual.icon,
      tone: visual.tone,
      hue: visual.hue,
      group: meta.group,
      titleKey: visual.titleKey ?? visual.labelKey,
      defaultTitle: meta.defaultLabel,
      bodyClassName: visual.bodyClassName,
      order: index,
      Component: visual.Component,
    };
  });

for (const section of SETTINGS_SECTIONS) registerSettingsSection(section);

// Eliza Cloud agent manager — contributed through the pluggable registry rather
// than the canonical META list, so it surfaces in Settings (list / switch /
// create+name / delete agents) without changing the built-in section count that
// the dev-route-catalog test pins. Ordered right after the AI Model section.
registerSettingsSection({
  id: "cloud-agents",
  label: "settings.sections.cloudAgents.label",
  defaultLabel: "Agents",
  icon: Bot,
  tone: "accent",
  hue: "accent",
  group: "agent",
  titleKey: "settings.sections.cloudAgents.title",
  defaultTitle: "Eliza Cloud Agents",
  order: 1.5,
  Component: CloudAgentsSection,
});

/** Every section the Settings view should render — built-ins plus any added by
 *  a host app / plugin through {@link registerSettingsSection}. */
export function getAllSettingsSections(): SettingsSectionDef[] {
  return listSettingsSections();
}

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
  if (hash === "cloud" || hash === "providers") return "ai-model";
  return getAllSettingsSections().some((section) => section.id === hash)
    ? hash
    : null;
}

export function replaceSettingsHash(sectionId: string): void {
  if (typeof window === "undefined") return;
  const nextHash = `#${sectionId}`;
  if (window.location.hash === nextHash) return;
  window.history.replaceState(null, "", nextHash);
}
