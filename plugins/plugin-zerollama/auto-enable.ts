// Auto-enable check for @elizaos/plugin-zerollama.
// Keep this module light: env reads only, no transitive imports.
import type { PluginAutoEnableContext } from "@elizaos/core";

/** Enable when an Ollama/zerollama endpoint is configured. */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  const env = ctx.env;
  return Boolean(
    (env.OLLAMA_BASE_URL && env.OLLAMA_BASE_URL.trim() !== "") ||
    (env.OLLAMA_API_ENDPOINT && env.OLLAMA_API_ENDPOINT.trim() !== "") ||
    (env.OLLAMA_API_URL && env.OLLAMA_API_URL.trim() !== ""),
  );
}
