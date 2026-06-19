import {
  createOpenAICompatible,
  type OpenAICompatibleProvider,
  type OpenAICompatibleProviderSettings,
} from "@ai-sdk/openai-compatible";
import type { IAgentRuntime } from "@elizaos/core";
import { getApiKeyOptional, getBaseURL } from "../utils/config";

export type ZaiProvider = OpenAICompatibleProvider;
export type ZaiFetch = NonNullable<OpenAICompatibleProviderSettings["fetch"]>;

export function createZaiClient(
  runtime: IAgentRuntime,
  opts: { fetch?: ZaiFetch } = {}
): ZaiProvider {
  const apiKey = getApiKeyOptional(runtime) ?? undefined;
  const baseURL = getBaseURL(runtime);

  return createOpenAICompatible({
    name: "zai",
    baseURL,
    ...(apiKey ? { apiKey } : {}),
    fetch: opts.fetch ?? (runtime.fetch as ZaiFetch | undefined),
    includeUsage: true,
  });
}
