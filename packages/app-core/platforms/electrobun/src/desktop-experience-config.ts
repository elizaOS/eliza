/** Product-level desktop startup experience, separate from packaging profiles. */

export const DESKTOP_EXPERIENCE_ENV = "ELIZA_DESKTOP_EXPERIENCE";

export type DesktopExperience = "macos-assistant" | "workspace";

/**
 * The normal desktop product is the full Workspace application on every
 * platform. A focused macOS assistant build can explicitly opt into the
 * tray-owned pill experience without overloading ELIZA_DESKTOP_PROFILE (the
 * bundle-size profile).
 */
export function resolveDesktopExperience(
  env: Record<string, string | undefined> = process.env,
  _platform: NodeJS.Platform = process.platform,
): DesktopExperience {
  const configured = env[DESKTOP_EXPERIENCE_ENV]?.trim().toLowerCase();
  if (configured === "macos-assistant" || configured === "workspace") {
    return configured;
  }
  return "workspace";
}

export function isMacosAssistantExperience(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    platform === "darwin" &&
    resolveDesktopExperience(env, platform) === "macos-assistant"
  );
}
