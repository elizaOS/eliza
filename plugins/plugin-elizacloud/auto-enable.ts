// Auto-enable check for @elizaos/plugin-elizacloud.
//
// Plugin manifest entry-point — referenced by package.json's
// `elizaos.plugin.autoEnableModule`. Keep this module light: env reads only,
// no service init, no transitive imports of the full plugin runtime. The
// auto-enable engine loads dozens of these per boot.
import type { PluginAutoEnableContext } from "@elizaos/core";

const ENV_KEYS = ["ELIZAOS_CLOUD_API_KEY", "ELIZAOS_CLOUD_ENABLED"] as const;

/** Enable when an Eliza Cloud API key or enabled flag is present. */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  return ENV_KEYS.some((k) => {
    const v = ctx.env[k];
    return typeof v === "string" && v.trim() !== "";
  });
}
