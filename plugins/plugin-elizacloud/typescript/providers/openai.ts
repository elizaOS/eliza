import { createOpenAI } from "@ai-sdk/openai";
import type { IAgentRuntime } from "@elizaos/core";
import { getApiKey, getBaseURL, isProxyMode } from "../utils/config";

export function createOpenAIClient(runtime: IAgentRuntime) {
  const baseURL = getBaseURL(runtime);
  const apiKey =
    getApiKey(runtime) ?? (isProxyMode(runtime) ? "eliza-proxy" : undefined);
  return createOpenAI({ apiKey: (apiKey ?? "") as string, baseURL });
}
