// Auto-enable check for @elizaos/plugin-ollama.
//
// Plugin manifest entry-point — referenced by package.json's
// `elizaos.plugin.autoEnableModule`. Keep this module light: env reads only,
// no service init, no transitive imports of the full plugin runtime. The
// auto-enable engine loads dozens of these per boot.
import type { PluginAutoEnableContext } from "@elizaos/core";

const ENV_KEYS = [
  "OLLAMA_BASE_URL",
  "OLLAMA_API_ENDPOINT",
  "OLLAMA_API_URL",
] as const;

/** Enable when any Ollama base/endpoint URL is configured. */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  return ENV_KEYS.some((k) => {
    const v = ctx.env[k];
    return typeof v === "string" && v.trim() !== "";
  });
}
