/**
 * Constructs the `@openrouter/ai-sdk-provider` client the model handlers call.
 * Omits the API key in browser environments (where `document` exists) so the
 * key never ships to the client — browser builds must point `getBaseURL` at a
 * key-injecting proxy via `OPENROUTER_BROWSER_BASE_URL`.
 */
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
