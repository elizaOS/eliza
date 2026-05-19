// Auto-enable check for @elizaos/plugin-edge-tts.
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
 * Enable when the runtime is provisioned by Eliza Cloud, or when the user has
 * explicitly enabled TTS via `config.features.tts`.
 */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  return (
    ctx.env.ELIZA_CLOUD_PROVISIONED === "1" ||
    isFeatureEnabled(ctx.config, "tts")
  );
}
