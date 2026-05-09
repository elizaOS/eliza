// Auto-enable check for @elizaos/plugin-anthropic.
//
// Plugin manifest entry-point — referenced by package.json's
// `elizaos.plugin.autoEnableModule`. Keep this module light: env reads only,
// no service init, no transitive imports of the full plugin runtime. The
// auto-enable engine loads dozens of these per boot.
import type { PluginAutoEnableContext } from "@elizaos/shared";

/** Enable when an Anthropic / Claude API key is present in the environment. */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  const env = ctx.env;
  return Boolean(
    (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim() !== "") ||
      (env.CLAUDE_API_KEY && env.CLAUDE_API_KEY.trim() !== ""),
  );
}
