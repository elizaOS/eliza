// Auto-enable check for @elizaos/plugin-shell.
//
// Plugin manifest entry-point — referenced by package.json's
// `elizaos.plugin.autoEnableModule`. Keep this module light: env reads only,
// no service init, no transitive imports of the full plugin runtime. The
// auto-enable engine loads dozens of these per boot.
import type { PluginAutoEnableContext } from "@elizaos/core";

function isFeatureEnabled(config: PluginAutoEnableContext["config"], key: string): boolean {
  const f = (config?.features as Record<string, unknown> | undefined)?.[key];
  if (f === true) return true;
  if (f && typeof f === "object" && f !== null) {
    return (f as Record<string, unknown>).enabled !== false;
  }
  return false;
}

function isTruthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

function terminalSupportedByEnv(ctx: PluginAutoEnableContext): boolean {
  const env = ctx.env;
<<<<<<< HEAD
  const variant = (env.ELIZA_BUILD_VARIANT ?? env.MILADY_BUILD_VARIANT ?? "").trim().toLowerCase();
=======
  const variant = (env.ELIZA_BUILD_VARIANT ?? "").trim().toLowerCase();
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
  if (variant === "store") return false;

  const platform = env.ELIZA_PLATFORM?.trim().toLowerCase();
  const mobile =
    platform === "android" || platform === "ios" || Boolean(env.ANDROID_ROOT || env.ANDROID_DATA);
  if (!mobile) return true;

  const mode = (env.ELIZA_RUNTIME_MODE ?? env.RUNTIME_MODE ?? env.LOCAL_RUNTIME_MODE ?? "")
    .trim()
    .toLowerCase();
  return platform === "android" && isTruthy(env.ELIZA_AOSP_BUILD) && mode === "local-yolo";
}

/** Enable when `config.features.shell` is truthy / not explicitly disabled. */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  return isFeatureEnabled(ctx.config, "shell") && terminalSupportedByEnv(ctx);
}
