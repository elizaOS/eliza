/**
 * Auto-enable gate for the browser automation plugin.
 *
 * The plugin manifest loads this module during boot, so it stays limited to
 * feature-config inspection and avoids runtime imports.
 */
import type { PluginAutoEnableContext } from "@elizaos/core";

function isFeatureEnabled(
  config: PluginAutoEnableContext["config"],
  key: string,
): boolean {
  const f = (config?.features as Record<string, unknown> | undefined)?.[key];
  if (f === true) return true;
  if (f && typeof f === "object" && f !== null) {
    return (f as Record<string, unknown>).enabled !== false;
  }
  return false;
}

/** Enable when `config.features.browser` is truthy / not explicitly disabled. */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  return isFeatureEnabled(ctx.config, "browser");
}
