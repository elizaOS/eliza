import { type LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
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
export declare const SECTION_TONE_ICON_CLASS: Record<
  SettingsSectionTone,
  string
>;
export declare const SETTINGS_SECTIONS: SettingsSectionDef[];
export declare function settingsSectionLabel(
  section: SettingsSectionDef,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string;
export declare function settingsSectionTitle(
  section: SettingsSectionDef,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string;
export declare function readSettingsHashSection(): string | null;
export declare function replaceSettingsHash(sectionId: string): void;
//# sourceMappingURL=settings-sections.d.ts.map
