/**
 * OpenAI client provider
 *
 * Creates and configures the OpenAI client instance.
 */

import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import type { IAgentRuntime } from "@elizaos/core";
import { getApiKey, getBaseURL, isProxyMode } from "../utils/config";

// ============================================================================
// Constants
// ============================================================================

/**
 * Placeholder API key used in browser proxy mode.
 * The server proxy replaces this with the real key.
 */
const PROXY_API_KEY = "sk-proxy";

// ============================================================================
// Public Functions
// ============================================================================

/**
 * Creates a configured OpenAI client.
 *
 * In browser proxy mode, uses a placeholder API key since the
 * server-side proxy will inject the real credentials.
 *
 * @param runtime - The agent runtime
 * @returns Configured OpenAI provider
 * @throws Error if no API key is available and not in proxy mode
 */
export function createOpenAIClient(runtime: IAgentRuntime): OpenAIProvider {
  const baseURL = getBaseURL(runtime);
  const apiKey = getApiKey(runtime);

  // In proxy mode, we don't need a real API key
  if (!apiKey && isProxyMode(runtime)) {
    return createOpenAI({
      apiKey: PROXY_API_KEY,
      baseURL,
    });
  }

  // API key is required in non-proxy mode
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required. Set it in your environment variables or runtime settings."
    );
  }

  return createOpenAI({
    apiKey,
    baseURL,
  });
}
