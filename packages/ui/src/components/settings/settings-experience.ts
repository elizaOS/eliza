/**
 * Resolves settings experience policy independently from runtime and platform
 * capability checks so every application shell can consume one registry.
 */
import type { SettingsSectionDef } from "./settings-section-registry";

export type SettingsExperience =
  | "standard"
  | "consumer-cloud"
  | "managed-cloud";

export interface SettingsExperienceContext {
  experience: SettingsExperience;
  androidCloudBuild: boolean;
}

export function resolveSettingsExperience(options: {
  cloudOnlyBranding: boolean;
  managedCloudRuntime: boolean;
}): SettingsExperience {
  if (options.cloudOnlyBranding) return "consumer-cloud";
  if (options.managedCloudRuntime) return "managed-cloud";
  return "standard";
}

/** Applies new experience policy first, then the legacy flags during migration. */
export function isSettingsSectionAvailable(
  section: SettingsSectionDef,
  context: SettingsExperienceContext,
): boolean {
  if (
    section.experiences &&
    !section.experiences.includes(context.experience)
  ) {
    return false;
  }

  const cloudExperience = context.experience !== "standard";
  if (section.cloudOnly && !cloudExperience) return false;
  if (section.hideOnManagedCloud && cloudExperience) return false;
  if (section.hideOnCloud && context.androidCloudBuild) return false;
  return true;
}
