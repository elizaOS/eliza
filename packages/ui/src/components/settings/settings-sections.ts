/**
 * Declares and registers every built-in settings section into the
 * settings-section registry (`settings-section-registry.ts`), which SettingsView
 * reads to build its nav + render the active section. Section bodies are lazy
 * chunks (see the note below); metadata/order/grouping come from
 * `settings-section-meta.ts`. Also owns the tone/hue icon-class maps and the
 * `#settings/<section>` hash-routing helpers. Importing this module for its side
 * effect is what populates the registry, so it is imported once at app boot.
 */

import {
  Archive,
  Bot,
  Brain,
  Cloud,
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
  Wallpaper,
  Webhook,
} from "lucide-react";
import { type ComponentType, type LazyExoticComponent, lazy } from "react";
import { registerCloudConnectorsSettingsSection } from "../../cloud/connectors";
import {
  CLOUD_SETTINGS_GROUP_ID,
  registerSettingsGroup,
} from "../../cloud/settings/cloud-settings-group";
import {
  SETTINGS_GROUP_LABEL,
  SETTINGS_GROUP_ORDER,
  SETTINGS_SECTION_META,
  type SettingsSectionGroup,
} from "./settings-section-meta";
import {
  getAllSettingsSections,
  registerSettingsSection,
  type SettingsSectionDef,
  type SettingsSectionHue,
  type SettingsSectionTone,
} from "./settings-section-registry";

/**
 * Section bodies are lazy-loaded (#11351): the settings-section registry used to
 * pull ~15 section components (Identity, ProviderSwitcher, Connectors, Runtime,
 * Advanced, ReleaseCenter, …) into the eager boot graph through the
 * `@elizaos/ui/browser` barrel. `SettingsView` is already lazy, but the whole
 * registry rode along on the initial chunk. Wrapping each `Component` in
 * `React.lazy` moves those bodies onto their own on-demand chunks; the active
 * section's `<Component/>` render in `SettingsView` sits behind a `<Suspense>`
 * boundary so the split is transparent. Named exports are normalized to the
 * `default` shape `lazy()` expects.
 */
const IdentitySettingsSection = lazy(() =>
  import("./IdentitySettingsSection").then((m) => ({
    default: m.IdentitySettingsSection,
  })),
);
const ProviderSwitcher = lazy(() =>
  import("./ProviderSwitcher").then((m) => ({ default: m.ProviderSwitcher })),
);
const VoiceSectionMount = lazy(() =>
  import("./VoiceSectionMount").then((m) => ({ default: m.VoiceSectionMount })),
);
const CapabilitiesSection = lazy(() =>
  import("./CapabilitiesSection").then((m) => ({
    default: m.CapabilitiesSection,
  })),
);
const AppsManagementSection = lazy(() =>
  import("./AppsManagementSection").then((m) => ({
    default: m.AppsManagementSection,
  })),
);
const ConnectorsSection = lazy(() =>
  import("./ConnectorsSection").then((m) => ({ default: m.ConnectorsSection })),
);
const RuntimeSettingsSection = lazy(() =>
  import("./RuntimeSettingsSection").then((m) => ({
    default: m.RuntimeSettingsSection,
  })),
);
const AppearanceSettingsSection = lazy(() =>
  import("./AppearanceSettingsSection").then((m) => ({
    default: m.AppearanceSettingsSection,
  })),
);
const BackgroundSettingsSection = lazy(() =>
  import("./BackgroundSettingsSection").then((m) => ({
    default: m.BackgroundSettingsSection,
  })),
);
const RemotePluginHostSection = lazy(() =>
  import("./RemotePluginHostSection").then((m) => ({
    default: m.RemotePluginHostSection,
  })),
);
const WalletRpcSection = lazy(() =>
  import("./WalletRpcSection").then((m) => ({ default: m.WalletRpcSection })),
);
const ReleaseCenterView = lazy(() =>
  import("../pages/ReleaseCenterView").then((m) => ({
    default: m.ReleaseCenterView,
  })),
);
const AdvancedSection = lazy(() =>
  import("./AdvancedSection").then((m) => ({ default: m.AdvancedSection })),
);
const AppPermissionsSection = lazy(() =>
  import("./AppPermissionsSection").then((m) => ({
    default: m.AppPermissionsSection,
  })),
);
const PermissionsSection = lazy(() =>
  import("./PermissionsSection").then((m) => ({
    default: m.PermissionsSection,
  })),
);
const SecretsManagerSection = lazy(() =>
  import("./SecretsManagerSection").then((m) => ({
    default: m.SecretsManagerSection,
  })),
);
const SecuritySettingsSection = lazy(() =>
  import("./SecuritySettingsSection").then((m) => ({
    default: m.SecuritySettingsSection,
  })),
);
const CloudOverviewSection = lazy(() =>
  import("./CloudOverviewSection").then((m) => ({
    default: m.CloudOverviewSection,
  })),
);
const CloudAgentsSection = lazy(() =>
  import("./CloudAgentsSection").then((m) => ({
    default: m.CloudAgentsSection,
  })),
);
const MyRuntimesContainer = lazy(() =>
  import("../cockpit/MyRuntimesContainer").then((m) => ({
    default: m.MyRuntimesContainer,
  })),
);

export {
  getAllSettingsSections,
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
  accent: "bg-accent/12 text-accent  ",
  amber: "bg-warn/12 text-warn  ",
  rose: "bg-[color-mix(in_oklab,var(--accent)_14%,var(--surface))] text-accent  ",
  slate: "bg-surface text-txt-strong  ",
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
  /** Hide unless Developer Mode is on. */
  developerOnly?: boolean;
  /** Hide on the cloud mobile build (no host machine). */
  hideOnCloud?: boolean;
  Component: ComponentType | LazyExoticComponent<ComponentType>;
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
  background: {
    icon: Wallpaper,
    tone: "neutral",
    hue: "rose",
    labelKey: "settings.sections.background.label",
    // Chrome-light so the live wallpaper shows through while choices apply.
    Component: BackgroundSettingsSection,
  },
  "remote-plugins": {
    icon: Puzzle,
    tone: "accent",
    hue: "rose",
    labelKey: "settings.sections.remote-plugins.label",
    developerOnly: true,
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
    // Host/self-host concept ("set a remote password so other machines can log
    // into your host"). Meaningless for a cloud mobile user — the cloud
    // "Sessions & Privacy" section covers real account security on cloud.
    hideOnCloud: true,
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
      developerOnly: visual.developerOnly,
      hideOnCloud: visual.hideOnCloud,
      order: index,
      Component: visual.Component,
    };
  });

for (const section of SETTINGS_SECTIONS) registerSettingsSection(section);

registerSettingsGroup({
  id: CLOUD_SETTINGS_GROUP_ID,
  label: "Cloud",
  order: 1.5,
});

registerSettingsSection({
  id: "cloud-overview",
  label: "settings.sections.cloudOverview.label",
  defaultLabel: "Overview",
  icon: Cloud,
  tone: "accent",
  hue: "accent",
  group: CLOUD_SETTINGS_GROUP_ID,
  titleKey: "settings.sections.cloudOverview.title",
  defaultTitle: "Eliza Cloud",
  order: 1.45,
  Component: CloudOverviewSection,
});

// Eliza Cloud agent manager — contributed through the pluggable registry rather
// than the canonical META list, so it surfaces in Settings (list / switch /
// create+name / delete agents) without changing the built-in section count that
// the dev-route-catalog test pins. It lives under the local Cloud group with the
// upsell overview, while full Cloud-only account/billing/API surfaces remain
// opt-in through registerCloudSettingsSections().
registerSettingsSection({
  id: "cloud-agents",
  label: "settings.sections.cloudAgents.label",
  defaultLabel: "Agents",
  icon: Bot,
  tone: "accent",
  hue: "accent",
  group: CLOUD_SETTINGS_GROUP_ID,
  titleKey: "settings.sections.cloudAgents.title",
  defaultTitle: "Eliza Cloud Agents",
  order: 1.55,
  Component: CloudAgentsSection,
});

// "My Runtimes" — manage + switch between local / cloud-dedicated / VPS-remote
// runtimes (the cockpit's runtime registry). Contributed through the registry
// (not the pinned META list) so it doesn't change the built-in section count the
// dev-route-catalog test pins.
registerSettingsSection({
  id: "my-runtimes",
  label: "settings.sections.myRuntimes.label",
  defaultLabel: "My Runtimes",
  icon: Server,
  tone: "neutral",
  hue: "slate",
  group: "system",
  titleKey: "settings.sections.myRuntimes.title",
  defaultTitle: "My Runtimes",
  order: 3.5,
  Component: MyRuntimesContainer,
});

registerCloudConnectorsSettingsSection();

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

/**
 * Legacy hash aliases → section ids. `#billing` / `#api-keys` are the hashes
 * older in-app links and bookmarks carry; the registered cloud sections use
 * `cloud-*` ids so they never collide with the built-in local sections.
 */
const SETTINGS_HASH_ALIASES: Readonly<Record<string, string>> = {
  cloud: "ai-model",
  providers: "ai-model",
  billing: "cloud-billing",
  "api-keys": "cloud-api-keys",
};

export function readSettingsHashSection(): string | null {
  if (typeof window === "undefined") return null;
  const rawHash = window.location.hash.replace(/^#/, "");
  if (!rawHash) return null;
  const hash = SETTINGS_HASH_ALIASES[rawHash] ?? rawHash;
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
