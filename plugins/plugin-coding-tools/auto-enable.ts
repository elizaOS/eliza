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
  const f = (config?.features as Record<string, unknown> | undefined)?.[key];
  if (f === true) return true;
  if (f && typeof f === "object" && f !== null) {
    return (f as Record<string, unknown>).enabled !== false;
  }
  return false;
}

/**
 * Enable when `config.features.codingTools` is truthy, or via the legacy
 * `config.features["coding-agent"]` key.
 */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  return (
    isFeatureEnabled(ctx.config, "codingTools") ||
    isFeatureEnabled(ctx.config, "coding-agent")
  );
}
