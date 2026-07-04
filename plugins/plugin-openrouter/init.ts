/**
 * Boot-time API key validation for the plugin's `init` hook (node builds only).
 * Warns rather than throws when `OPENROUTER_API_KEY` is missing so the agent can
 * still start with limited functionality, and no-ops in browser environments
 * where the key lives behind the proxy. Also silences the AI SDK warning log
 * before any provider is constructed.
 */
import { type IAgentRuntime, logger } from "@elizaos/core";
import { getApiKey, getBaseURL } from "./utils/config";

(globalThis as Record<string, unknown>).AI_SDK_LOG_WARNINGS ??= false;

export function initializeOpenRouter(
  _config: Record<string, unknown>,
  runtime: IAgentRuntime
): void {
  (async () => {
    try {
      const isBrowser =
        typeof globalThis !== "undefined" && (globalThis as Record<string, unknown>).document;
      if (isBrowser) {
        return;
      }

      if (!getApiKey(runtime)) {
        logger.warn(
          "OPENROUTER_API_KEY is not set in environment - OpenRouter functionality will be limited"
        );
        return;
      }

      const baseURL = getBaseURL(runtime);
      const response = await fetch(`${baseURL}/models`, {
        headers: { Authorization: `Bearer ${getApiKey(runtime)}` },
      });

      if (!response.ok) {
        logger.warn(`OpenRouter API key validation failed: ${response.statusText}`);
      } else {
        logger.log("OpenRouter API key validated successfully");
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Error validating OpenRouter API key: ${message}`);
    }
  })();
}
