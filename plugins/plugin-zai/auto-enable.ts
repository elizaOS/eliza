// Auto-enable check for @elizaos/plugin-zai.
//
// Plugin manifest entry-point — referenced by package.json's
// `elizaos.plugin.autoEnableModule`. Keep this module light: env reads only,
// no service init, no transitive imports of the full plugin runtime.
type PluginAutoEnableContext = {
  env: Record<string, string | undefined>;
};

/** Enable when a z.ai API key is present in the environment. */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  const env = ctx.env;
  return Boolean(
    (env.ZAI_API_KEY && env.ZAI_API_KEY.trim() !== "") ||
      (env.Z_AI_API_KEY && env.Z_AI_API_KEY.trim() !== "")
  );
}
