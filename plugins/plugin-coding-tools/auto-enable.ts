// Auto-enable check for @elizaos/plugin-coding-tools.
//
// Plugin manifest entry-point — referenced by package.json's
// `elizaos.plugin.autoEnableModule`. Keep this module light: env reads only,
// no service init, no transitive imports of the full plugin runtime. The
// auto-enable engine loads dozens of these per boot.
import type { PluginAutoEnableContext } from "@elizaos/core";

function isFeatureEnabled(
  config: PluginAutoEnableContext["config"],
  key: string,
): boolean {
  const f = (config.features as Record<string, unknown> | undefined)?.[key];
  if (f === true) return true;
  if (f && typeof f === "object" && !Array.isArray(f) && f !== null) {
    return (f as Record<string, unknown>).enabled !== false;
  }
  return false;
}

/**
 * Terminal support is decided by the declared runtime platform: mobile
 * platforms (android/ios) reject terminal tools unless running in local-yolo
 * mode on Android; every other platform (desktop, server, or unset) supports
 * terminals.
 *
 * Android SDK env vars (ANDROID_ROOT / ANDROID_DATA) are deliberately NOT
 * treated as a platform declaration — they are exported by the Android SDK on
 * ordinary desktop dev shells, and gating on them silently disabled explicitly
 * enabled coding tools for those users.
 */
function terminalSupportedByEnv(ctx: PluginAutoEnableContext): boolean {
  const env = ctx.env;
  const variant = (env.ELIZA_BUILD_VARIANT ?? "").trim().toLowerCase();
  if (variant === "store") return false;

  const platform = env.ELIZA_PLATFORM?.trim().toLowerCase();
  if (platform !== "android" && platform !== "ios") return true;

  const mode = (
    env.ELIZA_RUNTIME_MODE ??
    env.RUNTIME_MODE ??
    env.LOCAL_RUNTIME_MODE ??
    ""
  )
    .trim()
    .toLowerCase();
  return platform === "android" && mode === "local-yolo";
}

/**
 * Enable when `config.features.codingTools` is truthy, via the legacy
 * `config.features["coding-agent"]` key, or via `config.features.shell`
 * (the shell services formerly shipped as @elizaos/plugin-shell now live in
 * this plugin).
 */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  return (
    (isFeatureEnabled(ctx.config, "codingTools") ||
      isFeatureEnabled(ctx.config, "coding-agent") ||
      isFeatureEnabled(ctx.config, "shell")) &&
    terminalSupportedByEnv(ctx)
  );
}
