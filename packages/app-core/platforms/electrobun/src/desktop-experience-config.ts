/** Resolves the product-level desktop startup experience independently of packaging profiles. */

export const DESKTOP_EXPERIENCE_ENV = "ELIZA_DESKTOP_EXPERIENCE";

export type DesktopExperience = "macos-assistant" | "workspace";

/**
 * macOS starts as the tray-owned assistant. Other desktop platforms retain the
 * ordinary Workspace window unless an explicit supported experience overrides
 * that default.
 */
export function resolveDesktopExperience(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): DesktopExperience {
  const configured = env[DESKTOP_EXPERIENCE_ENV]?.trim().toLowerCase();
  if (configured === "macos-assistant" || configured === "workspace") {
    return configured;
  }
  return platform === "darwin" ? "macos-assistant" : "workspace";
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
