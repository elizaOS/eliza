/**
 * Import-free auto-enable predicate for the browser automation plugin.
 *
 * The plugin manifest references this module directly, so it only reads config
 * and avoids transitive imports of the full browser runtime.
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
