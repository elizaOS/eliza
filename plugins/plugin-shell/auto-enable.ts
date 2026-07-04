/**
 * Auto-enable gate for the shell execution plugin.
 * The manifest loads this module during boot, so it stays limited to feature/env checks and avoids service imports.
 */

import type { PluginAutoEnableContext } from "@elizaos/core";

function isFeatureEnabled(config: PluginAutoEnableContext["config"], key: string): boolean {
  const f = (config.features as Record<string, unknown> | undefined)?.[key];
  if (f === true) return true;
  if (f && typeof f === "object" && f !== null) {
    return (f as Record<string, unknown>).enabled !== false;
  }
  return false;
}

function terminalSupportedByEnv(ctx: PluginAutoEnableContext): boolean {
  const env = ctx.env;
  const variant = (env.ELIZA_BUILD_VARIANT ?? "").trim().toLowerCase();
  if (variant === "store") return false;

  const platform = env.ELIZA_PLATFORM?.trim().toLowerCase();
  const mobile =
    platform === "android" || platform === "ios" || Boolean(env.ANDROID_ROOT || env.ANDROID_DATA);
  if (!mobile) return true;

  const mode = (env.ELIZA_RUNTIME_MODE ?? env.RUNTIME_MODE ?? env.LOCAL_RUNTIME_MODE ?? "")
    .trim()
    .toLowerCase();
  return platform === "android" && mode === "local-yolo";
}

/** Enable when `config.features.shell` is truthy / not explicitly disabled. */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  return isFeatureEnabled(ctx.config, "shell") && terminalSupportedByEnv(ctx);
}
