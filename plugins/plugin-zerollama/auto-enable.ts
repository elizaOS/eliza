/**
 * Enables the provider when an Ollama endpoint is configured while keeping
 * auto-discovery free of runtime imports and other transitive work.
 */
import type { PluginAutoEnableContext } from "@elizaos/core";

/** Enable when an Ollama/zerollama endpoint is configured. */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  const env = ctx.env;
  return Boolean(
    (env.OLLAMA_BASE_URL && env.OLLAMA_BASE_URL.trim() !== "") ||
      (env.OLLAMA_API_ENDPOINT && env.OLLAMA_API_ENDPOINT.trim() !== "") ||
      (env.OLLAMA_API_URL && env.OLLAMA_API_URL.trim() !== "")
  );
}
