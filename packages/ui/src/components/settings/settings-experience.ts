/**
 * Defines the product experience axis for the canonical Settings registry.
 * Host-only behavior remains in runtime capabilities, so Android and desktop
 * share sections unless a real runtime contract requires otherwise.
 */
import type { SettingsSectionDef } from "./settings-section-registry";

export type SettingsExperience = "standard" | "managed-cloud";

export function resolveSettingsExperience(
  managedCloudRuntime: boolean,
): SettingsExperience {
  return managedCloudRuntime ? "managed-cloud" : "standard";
}

export function settingsSectionMatchesExperience(
  section: Pick<SettingsSectionDef, "cloudOnly" | "hideOnManagedCloud">,
  experience: SettingsExperience,
): boolean {
  if (section.cloudOnly && experience !== "managed-cloud") return false;
  if (section.hideOnManagedCloud && experience === "managed-cloud") {
    return false;
  }
  return true;
}
