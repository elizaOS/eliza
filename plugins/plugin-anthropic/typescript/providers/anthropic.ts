/**
 * Anthropic client factory functions.
 *
 * These functions create properly configured Anthropic clients for use with the AI SDK.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import type { IAgentRuntime } from "@elizaos/core";
import { getApiKeyOptional, getBaseURL, isBrowser } from "../utils/config";

/**
 * Create an Anthropic client with standard configuration.
 *
 * @param runtime - The agent runtime for accessing configuration
 * @returns Configured Anthropic client factory
 */
export function createAnthropicClient(runtime: IAgentRuntime) {
  const apiKey = isBrowser() ? undefined : (getApiKeyOptional(runtime) ?? undefined);
  const baseURL = getBaseURL(runtime);

  return createAnthropic({
    apiKey,
    baseURL,
  });
}

/**
 * Create an Anthropic client with topP support.
 *
 * Anthropic's API doesn't allow both temperature and top_p to be specified together.
 * This client includes a custom fetch handler that removes temperature when it's 0
 * and top_p is present, allowing topP to actually take effect.
 *
 * @param runtime - The agent runtime for accessing configuration
 * @returns Configured Anthropic client factory with topP handling
 */
export function createAnthropicClientWithTopPSupport(runtime: IAgentRuntime) {
  const apiKey = isBrowser() ? undefined : (getApiKeyOptional(runtime) ?? undefined);
  const baseURL = getBaseURL(runtime);

  const customFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init && typeof init.body === "string") {
      const body: Record<string, unknown> = JSON.parse(init.body);

      // Strip out temperature when it's 0 and we have topP
      // This allows topP to actually be used
      const hasTopP = Object.hasOwn(body, "top_p") && body["top_p"] != null;
      const hasZeroTemp = Object.hasOwn(body, "temperature") && body["temperature"] === 0;

      if (hasTopP && hasZeroTemp) {
        delete body["temperature"];
        init.body = JSON.stringify(body);
      }
    }

    return fetch(input, init);
  };

  return createAnthropic({
    apiKey,
    baseURL,
    // Type assertion needed due to SDK type mismatch with native fetch
    fetch: customFetch as typeof fetch,
  });
}
