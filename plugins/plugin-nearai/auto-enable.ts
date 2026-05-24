// Auto-enable check for @elizaos/plugin-nearai.
//
// Plugin manifest entry point, referenced by package.json's
// `elizaos.plugin.autoEnableModule`. Keep this module light: env reads only,
// no service init, no transitive imports of the full plugin runtime.
type PluginAutoEnableContext = {
  env: Record<string, string | undefined>;
};

/** Enable when a NEAR AI API key is present in the environment. */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  const env = ctx.env;
  return Boolean(env.NEARAI_API_KEY && env.NEARAI_API_KEY.trim() !== "");
}
