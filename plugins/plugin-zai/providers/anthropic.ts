import { createAnthropic } from "@ai-sdk/anthropic";
import type { IAgentRuntime } from "@elizaos/core";
import { getApiKeyOptional, getBaseURL, isBrowser } from "../utils/config";

export function createAnthropicClient(runtime: IAgentRuntime) {
  const apiKey = isBrowser() ? undefined : (getApiKeyOptional(runtime) ?? undefined);
  const baseURL = getBaseURL(runtime);

  return createAnthropic({
    apiKey,
    baseURL,
  });
}

export function createAnthropicClientWithTopPSupport(runtime: IAgentRuntime) {
  const apiKey = isBrowser() ? undefined : (getApiKeyOptional(runtime) ?? undefined);
  const baseURL = getBaseURL(runtime);

  const customFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init && typeof init.body === "string") {
      try {
        const body: Record<string, unknown> = JSON.parse(init.body);

        const hasTopP = Object.hasOwn(body, "top_p") && body.top_p != null;
        const hasAnyTemp = Object.hasOwn(body, "temperature");

        if (hasTopP && hasAnyTemp) {
          delete body.temperature;
          init.body = JSON.stringify(body);
        }
      } catch {
        return fetch(input, init);
      }
    }

    return fetch(input, init);
  };

  return createAnthropic({
    apiKey,
    baseURL,
    fetch: customFetch as typeof fetch,
  });
}
