/** Adapts the SDK transport for one OpenAI-compatible model operation using explicit native funding when selected. */
import { applyNativeApplicationInferenceHeaders } from "@elizaos/cloud-sdk";
import { createOpenAI } from "@ai-sdk/openai";
import type { IAgentRuntime } from "@elizaos/core";
import { getApiKey, getBaseURL, getNativeApplicationSlot, isProxyMode } from "../utils/config";

export function createOpenAIClient(runtime: IAgentRuntime, operationId?: string) {
  const baseURL = getBaseURL(runtime);
  const apiKey = getApiKey(runtime) ?? (isProxyMode(runtime) ? "eliza-proxy" : undefined);
  const headers = new Headers(operationId ? {"Idempotency-Key":operationId} : undefined);
  applyNativeApplicationInferenceHeaders({slotKey:getNativeApplicationSlot(runtime),method:"POST",path:"/chat/completions",headers});
  // NOTE: Callers must use openai.chat(modelName) instead of openai(modelName)
  // to force the Chat Completions API.  The default openai(modelName) routes
  // to the Responses API which does not support presencePenalty,
  // frequencyPenalty, or stopSequences and emits noisy warnings.
  return createOpenAI({
    apiKey: (apiKey ?? "") as string,
    baseURL,
    headers: Object.fromEntries(headers),
  });
}
