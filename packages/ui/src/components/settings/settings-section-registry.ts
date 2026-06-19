import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import type { SettingsSectionGroup } from "./settings-section-meta";

/**
 * Pluggable settings-section registry.
 *
 * Built-in sections (`settings-sections.ts`) and host apps / plugins both
 * contribute through {@link registerSettingsSection}; the Settings view renders
 * whatever {@link listSettingsSections} returns. The store is keyed on a global
 * symbol — mirroring `app-shell-registry` — so every bundle in the process
 * shares one registry even across module-identity splits.
 *
 * This is what makes settings modular: an app adds a section with one
 * `registerSettingsSection(...)` call at boot, no edits to the view.
 */

export type SettingsSectionTone =
  | "ok"
  | "warn"
  | "muted"
  | "accent"
  | "neutral";

/** Curated, token-safe medallion tints for the section icons. No blue. */
export type SettingsSectionHue = "accent" | "amber" | "rose" | "slate";

export interface SettingsSectionDef {
  /** Stable id — URL hash + agent-surface address. */
  id: string;
  /** i18n key for the nav label. */
  label: string;
  /** English fallback for {@link label}. */
  defaultLabel: string;
  icon: LucideIcon;
  tone: SettingsSectionTone;
  hue: SettingsSectionHue;
  /** i18n key for the section header (defaults to {@link label}). */
  titleKey: string;
  /** English fallback for {@link titleKey}. */
  defaultTitle: string;
  /**
   * Top-level group. The three built-in groups are {@link SettingsSectionGroup}
   * (`agent | system | security`); a host may also use a custom group id (e.g.
   * `"cloud"`) registered via the extra-group registry so the Settings view can
   * render it. Kept as a widened string so dynamic groups don't require editing
   * the pinned meta list.
   */
  group: SettingsSectionGroup | (string & {});
  /** Sort priority within a group (lower first). Built-ins use list order. */
  order?: number;
  /** Padding override for the section body panel. */
  bodyClassName?: string;
  Component: ComponentType;
}

interface SettingsSectionRegistryStore {
  entries: Map<string, SettingsSectionDef>;
  seq: number;
}

function registryKey(): symbol {
  return Symbol.for("elizaos.ui.settings-section-registry");
}

function getStore(): SettingsSectionRegistryStore {
  const globalObject = globalThis as Record<PropertyKey, unknown>;
  const key = registryKey();
  const existing = globalObject[key] as
    | SettingsSectionRegistryStore
    | undefined;
  if (existing) return existing;
  const created: SettingsSectionRegistryStore = {
    entries: new Map<string, SettingsSectionDef>(),
    seq: 0,
  };
  globalObject[key] = created;
  return created;
}

/**
 * Register (or replace) a settings section. Later registration with the same id
 * wins, so a host app can override a built-in section by re-registering its id.
 */
export function registerSettingsSection(section: SettingsSectionDef): void {
  const store = getStore();
  const order = section.order ?? store.seq;
  store.seq += 1;
  store.entries.set(section.id, { ...section, order });
}

/** All registered sections, sorted by `order` then registration sequence. */
export function listSettingsSections(): SettingsSectionDef[] {
  return [...getStore().entries.values()].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0),
  );
}

export function getSettingsSection(id: string): SettingsSectionDef | undefined {
  return getStore().entries.get(id);
}
