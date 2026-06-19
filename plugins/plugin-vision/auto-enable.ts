// Auto-enable check for @elizaos/plugin-vision.
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
 * Enable when `config.features.vision` is truthy, or when the user has
 * explicitly chosen a vision provider via `config.media.vision.provider`.
 */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  if (isFeatureEnabled(ctx.config, "vision")) return true;
  const visionProvider = ctx.config?.media?.vision?.provider;
  return typeof visionProvider === "string" && visionProvider.length > 0;
}
