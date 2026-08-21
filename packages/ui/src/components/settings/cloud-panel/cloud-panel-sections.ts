/**
 * Cloud panel section registry.
 *
 * Declares the 8 sections of the cloud-only desktop settings panel. Each
 * section is lazy-loaded so only the active section's body is in the initial
 * chunk. The registry is a static array (not the dynamic global-symbol-backed
 * registry used by the legacy settings) because the cloud panel has a fixed,
 * curated set of sections.
 */
import type { LucideIcon } from "lucide-react";
import {
  Bell,
  Keyboard,
  Mic,
  Palette,
  Plug,
  Shield,
  SlidersHorizontal,
  Volume2,
} from "lucide-react";
import type { ComponentType, LazyExoticComponent } from "react";
import { lazy } from "react";
import type { CloudPanelGroupId } from "./cloud-panel-groups";

export interface CloudPanelSection {
  /** Stable id — also the URL hash. */
  id: string;
  /** Display label in the sidebar. */
  label: string;
  /** One-line subtitle shown in the narrow hub list. */
  subtitle: string;
  /** Sidebar icon. */
  icon: LucideIcon;
  /** Sidebar group. */
  group: CloudPanelGroupId;
  /** Sort priority within a group (lower first). */
  order: number;
  /** Lazy-loaded section body. */
  Component: LazyExoticComponent<ComponentType>;
}

// Lazy-load each section so only the active one is in the initial chunk.
const GeneralSection = lazy(() =>
  import("./sections/GeneralSection").then((m) => ({ default: m.GeneralSection })),
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

export const CLOUD_PANEL_SECTIONS: readonly CloudPanelSection[] = [
  {
    id: "general",
    label: "General",
    subtitle: "Appearance, desktop",
    icon: Palette,
    group: "general",
    order: 0,
    Component: GeneralSection,
  },
  {
    id: "voice",
    label: "Voice",
    subtitle: "TTS, STT, conversation",
    icon: Volume2,
    group: "agent",
    order: 0,
    Component: VoiceSection,
  },
  {
    id: "agent",
    label: "Agent",
    subtitle: "Active agent, cloud agents",
    icon: Mic,
    group: "agent",
    order: 1,
    Component: AgentSection,
  },
  {
    id: "connections",
    label: "Connections",
    subtitle: "Discord, TG, MCP servers",
    icon: Plug,
    group: "agent",
    order: 2,
    Component: ConnectionsSection,
  },
  {
    id: "permissions",
    label: "Permissions",
    subtitle: "Mic, notif, accessibility",
    icon: Shield,
    group: "system",
    order: 0,
    Component: PermissionsSection,
  },
  {
    id: "notifications",
    label: "Notifications",
    subtitle: "Push, sound, badge",
    icon: Bell,
    group: "system",
    order: 1,
    Component: NotificationsSection,
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    subtitle: "Hotkeys, mouse",
    icon: Keyboard,
    group: "system",
    order: 2,
    Component: ShortcutsSection,
  },
  {
    id: "advanced",
    label: "Advanced",
    subtitle: "Dev mode, backups, reset",
    icon: SlidersHorizontal,
    group: "advanced",
    order: 0,
    Component: AdvancedSection,
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
  CloudPanelSection[]
> {
  const groups: Record<string, CloudPanelSection[]> = {};
  for (const section of CLOUD_PANEL_SECTIONS) {
    (groups[section.group] ??= []).push(section);
  }
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => a.order - b.order);
  }
  return groups;
}
