import {
  createOpenAICompatible,
  type OpenAICompatibleProvider,
  type OpenAICompatibleProviderSettings,
} from "@ai-sdk/openai-compatible";
import type { IAgentRuntime } from "@elizaos/core";
import { getApiKeyOptional, getBaseURL } from "../utils/config";

export type NearAIProvider = OpenAICompatibleProvider;
export type NearAIFetch = NonNullable<OpenAICompatibleProviderSettings["fetch"]>;

export function createNearAIClient(
  runtime: IAgentRuntime,
  opts: { fetch?: NearAIFetch } = {}
): NearAIProvider {
  const apiKey = getApiKeyOptional(runtime) ?? undefined;
  const baseURL = getBaseURL(runtime);

  return createOpenAICompatible({
    name: "nearai",
    baseURL,
    ...(apiKey ? { apiKey } : {}),
    fetch: opts.fetch ?? (runtime.fetch as NearAIFetch | undefined),
    includeUsage: true,
  });
}
