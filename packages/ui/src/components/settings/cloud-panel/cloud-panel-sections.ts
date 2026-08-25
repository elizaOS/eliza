/**
 * Cloud panel section registry.
 *
 * Declares the curated navigation and connected-account destinations for the
 * cloud-only desktop settings panel. Each section is lazy-loaded so only the
 * active section's body is in the initial chunk. The registry is a static
 * array (not the dynamic global-symbol-backed registry used by the legacy
 * settings) because the cloud panel has a fixed set of sections.
 */
import type { LucideIcon } from "lucide-react";
import {
  Bell,
  Building2,
  CreditCard,
  Keyboard,
  KeyRound,
  Lock,
  Mic,
  Monitor,
  Plug,
  Shield,
  SlidersHorizontal,
  Volume2,
} from "lucide-react";
import type { ComponentType, LazyExoticComponent } from "react";
import { lazy } from "react";
import type { CloudPanelGroupId } from "./cloud-panel-groups";

interface CloudPanelSectionBase {
  /** Stable id — also the URL hash. */
  id: string;
  /** Display label for the section heading or navigation entry. */
  label: string;
  /** One-line section description. */
  subtitle: string;
  /** Section icon. */
  icon: LucideIcon;
  /** Lazy-loaded section body. */
  Component: LazyExoticComponent<ComponentType>;
}

export interface CloudPanelNavigationSection extends CloudPanelSectionBase {
  placement: "navigation";
  /** Sidebar group. */
  group: CloudPanelGroupId;
  /** Sort priority within a group (lower first). */
  order: number;
}

export interface CloudPanelAccountFooterSection extends CloudPanelSectionBase {
  placement: "account-footer";
  /** Action label rendered in the connected-account menu. */
  footerLabel: string;
}

export type CloudPanelSection =
  | CloudPanelNavigationSection
  | CloudPanelAccountFooterSection;

// Lazy-load each section so only the active one is in the initial chunk.
const GeneralSection = lazy(() =>
  import("./sections/GeneralSection").then((m) => ({
    default: m.GeneralSection,
  })),
);
const VoiceSection = lazy(() =>
  import("./sections/VoiceSection").then((m) => ({ default: m.VoiceSection })),
);
const AgentSection = lazy(() =>
  import("./sections/AgentSection").then((m) => ({ default: m.AgentSection })),
);
const ConnectionsSection = lazy(() =>
  import("./sections/ConnectionsSection").then((m) => ({
    default: m.ConnectionsSection,
  })),
);
const PermissionsSection = lazy(() =>
  import("./sections/PermissionsSection").then((m) => ({
    default: m.PermissionsSection,
  })),
);
const NotificationsSection = lazy(() =>
  import("./sections/NotificationsSection").then((m) => ({
    default: m.NotificationsSection,
  })),
);
const ShortcutsSection = lazy(() =>
  import("./sections/ShortcutsSection").then((m) => ({
    default: m.ShortcutsSection,
  })),
);
const AdvancedSection = lazy(() =>
  import("./sections/AdvancedSection").then((m) => ({
    default: m.AdvancedSection,
  })),
);
const CloudBillingSection = lazy(() =>
  import("../../../cloud/settings/sections").then((m) => ({
    default: m.CloudBillingSection,
  })),
);
const CloudApiKeysSection = lazy(() =>
  import("../../../cloud/settings/sections").then((m) => ({
    default: m.CloudApiKeysSection,
  })),
);
const CloudSecuritySection = lazy(() =>
  import("../../../cloud/settings/sections").then((m) => ({
    default: m.CloudSecuritySection,
  })),
);
const CloudOrganizationSection = lazy(() =>
  import("../../../cloud/settings/sections").then((m) => ({
    default: m.CloudOrganizationSection,
  })),
);

export const CLOUD_PANEL_SECTIONS: readonly CloudPanelSection[] = [
  {
    id: "general",
    label: "General",
    subtitle: "Desktop integration",
    icon: Monitor,
    placement: "navigation",
    group: "general",
    order: 0,
    Component: GeneralSection,
  },
  {
    id: "voice",
    label: "Voice",
    subtitle: "TTS, STT, conversation",
    icon: Volume2,
    placement: "navigation",
    group: "agent",
    order: 0,
    Component: VoiceSection,
  },
  {
    id: "agent",
    label: "Agent",
    subtitle: "Active agent, cloud agents",
    icon: Mic,
    placement: "navigation",
    group: "agent",
    order: 1,
    Component: AgentSection,
  },
  {
    id: "connections",
    label: "Connections",
    subtitle: "Discord, TG, MCP servers",
    icon: Plug,
    placement: "navigation",
    group: "agent",
    order: 2,
    Component: ConnectionsSection,
  },
  {
    id: "permissions",
    label: "Permissions",
    subtitle: "Mic, notif, accessibility",
    icon: Shield,
    placement: "navigation",
    group: "system",
    order: 0,
    Component: PermissionsSection,
  },
  {
    id: "notifications",
    label: "Notifications",
    subtitle: "Push, sound, badge",
    icon: Bell,
    placement: "navigation",
    group: "system",
    order: 1,
    Component: NotificationsSection,
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    subtitle: "Hotkeys, mouse",
    icon: Keyboard,
    placement: "navigation",
    group: "system",
    order: 2,
    Component: ShortcutsSection,
  },
  {
    id: "advanced",
    label: "Advanced",
    subtitle: "Dev mode, backups, reset",
    icon: SlidersHorizontal,
    placement: "navigation",
    group: "advanced",
    order: 0,
    Component: AdvancedSection,
  },
  {
    id: "cloud-billing",
    label: "Billing & Credits",
    subtitle: "Plans, credits, and invoices",
    icon: CreditCard,
    placement: "account-footer",
    footerLabel: "Manage billing",
    Component: CloudBillingSection,
  },
  {
    id: "cloud-api-keys",
    label: "API Keys",
    subtitle: "Cloud API credentials",
    icon: KeyRound,
    placement: "account-footer",
    footerLabel: "API keys",
    Component: CloudApiKeysSection,
  },
  {
    id: "cloud-security",
    label: "Sessions & Privacy",
    subtitle: "Sessions, privacy, and audit",
    icon: Lock,
    placement: "account-footer",
    footerLabel: "Sessions & privacy",
    Component: CloudSecuritySection,
  },
  {
    id: "cloud-organization",
    label: "Organization",
    subtitle: "Members and organization settings",
    icon: Building2,
    placement: "account-footer",
    footerLabel: "Organization",
    Component: CloudOrganizationSection,
  },
] as const;

/** Deep-link compatibility: old hash → new section id. */
const HASH_REDIRECTS: Record<string, string> = {
  identity: "voice",
  voice: "voice",
  "cloud-overview": "agent",
  "cloud-agents": "agent",
  "cloud-connectors": "connections",
  connectors: "connections",
  mcps: "connections",
  appearance: "general",
  background: "general",
  notifications: "notifications",
  permissions: "permissions",
  "app-permissions": "permissions",
  "cloud-plugin-grants": "permissions",
  advanced: "advanced",
};

/** Resolve a hash (possibly old) to a valid cloud panel section id. */
export function resolveCloudPanelSection(
  hash: string | null | undefined,
): string {
  if (!hash) return "general";
  const direct = CLOUD_PANEL_SECTIONS.find((s) => s.id === hash);
  if (direct) return hash;
  const redirected = HASH_REDIRECTS[hash];
  if (redirected) return redirected;
  return "general";
}

/** Sections grouped by group id, in display order. */
export function groupedCloudPanelSections(): Record<
  string,
  CloudPanelNavigationSection[]
> {
  const groups: Record<string, CloudPanelNavigationSection[]> = {};
  for (const section of CLOUD_PANEL_SECTIONS) {
    if (section.placement !== "navigation") continue;
    const group = groups[section.group] ?? [];
    group.push(section);
    groups[section.group] = group;
  }
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => a.order - b.order);
  }
  return groups;
}

/** Account-menu destinations, in their authored display order. */
export function cloudPanelAccountFooterSections(): CloudPanelAccountFooterSection[] {
  return CLOUD_PANEL_SECTIONS.filter(
    (section): section is CloudPanelAccountFooterSection =>
      section.placement === "account-footer",
  );
}
