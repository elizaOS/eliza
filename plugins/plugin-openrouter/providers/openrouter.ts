import type { IAgentRuntime } from "@elizaos/core";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { getApiKey, getBaseURL } from "../utils/config";

export function createOpenRouterProvider(runtime: IAgentRuntime) {
  const apiKey = getApiKey(runtime);
  const isBrowser =
    typeof globalThis !== "undefined" && (globalThis as Record<string, unknown>).document;
  const baseURL = getBaseURL(runtime);

  return createOpenRouter({
    apiKey: isBrowser ? undefined : apiKey,
    baseURL,
  });
}
