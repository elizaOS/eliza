import { createOpenAI } from "@ai-sdk/openai";
import type { IAgentRuntime } from "@elizaos/core";
import { getApiKey, getBaseURL, isProxyMode } from "../utils/config";

export function createOpenAIClient(runtime: IAgentRuntime) {
  const baseURL = getBaseURL(runtime);
  const apiKey = getApiKey(runtime) ?? (isProxyMode(runtime) ? "eliza-proxy" : undefined);
  // NOTE: Callers must use openai.chat(modelName) instead of openai(modelName)
  // to force the Chat Completions API.  The default openai(modelName) routes
  // to the Responses API which does not support presencePenalty,
  // frequencyPenalty, or stopSequences and emits noisy warnings.
  return createOpenAI({
    apiKey: (apiKey ?? "") as string,
    baseURL,
  });
}
