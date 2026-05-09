// Auto-enable check for @elizaos/plugin-suno.
//
// Plugin manifest entry-point — referenced by package.json's
// `elizaos.plugin.autoEnableModule`. Keep this module light: env reads only,
// no service init, no transitive imports of the full plugin runtime. The
// auto-enable engine loads dozens of these per boot.
import type { PluginAutoEnableContext } from "@elizaos/core";

/**
 * Enable when a Suno API key is in the environment, or when the user has
 * explicitly selected Suno as the audio provider in own-key mode.
 */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  const apiKey = ctx.env.SUNO_API_KEY;
  if (apiKey && apiKey.trim() !== "") return true;
  const audio = ctx.config?.media?.audio;
  return audio?.provider === "suno" && audio?.mode === "own-key";
}
