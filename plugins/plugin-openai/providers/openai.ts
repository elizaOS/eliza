import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import type { IAgentRuntime } from "@elizaos/core";
import { getApiKey, getBaseURL, isProxyMode } from "../utils/config";

const PROXY_API_KEY = "sk-proxy";

export function createOpenAIClient(runtime: IAgentRuntime): OpenAIProvider {
  const baseURL = getBaseURL(runtime);
  const apiKey = getApiKey(runtime);

  if (!apiKey && isProxyMode(runtime)) {
    return createOpenAI({
      apiKey: PROXY_API_KEY,
      baseURL,
    });
  }

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
