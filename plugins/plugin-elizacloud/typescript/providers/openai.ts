import { createOpenAI } from "@ai-sdk/openai";
import type { IAgentRuntime } from "@elizaos/core";
import { getApiKey, getBaseURL, isProxyMode } from "../utils/config";

/**
 * Create an OpenAI-compatible client configured for ElizaOS Cloud
 *
 * @param runtime The runtime context
 * @returns Configured OpenAI-compatible client for ElizaOS Cloud
 */
export function createOpenAIClient(runtime: IAgentRuntime) {
  const baseURL = getBaseURL(runtime);
  // In proxy mode (browser + proxy base URL), pass a harmless placeholder key.
  // The server proxy replaces Authorization; no secrets leave the server.
  const apiKey =
    getApiKey(runtime) ?? (isProxyMode(runtime) ? "eliza-proxy" : undefined);
  return createOpenAI({ apiKey: (apiKey ?? "") as string, baseURL });
}
