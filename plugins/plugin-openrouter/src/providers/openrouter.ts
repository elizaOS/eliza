import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { logger, type IAgentRuntime } from "@elizaos/core";
import { getApiKey, getBaseURL } from "../utils/config";

/**
 * Create an OpenRouter provider instance with proper configuration
 *
 * @param runtime The runtime context
 * @returns Configured OpenRouter provider instance
 */
export function createOpenRouterProvider(runtime: IAgentRuntime) {
  const apiKey = getApiKey(runtime);
  const isBrowser =
    typeof globalThis !== "undefined" && (globalThis as any).document;
  const baseURL = getBaseURL(runtime);
  // In browser, omit apiKey and rely on proxy baseURL
  return createOpenRouter({
    apiKey: isBrowser ? undefined : apiKey,
    baseURL,
  });
}
