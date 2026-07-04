/**
 * Builds the `@ai-sdk/openai-compatible` client pointed at z.ai's general API
 * (base URL from config, validated against the blocked Coding/Anthropic paths).
 * Accepts an optional custom `fetch` so the text handlers can splice in the
 * `thinking` request body.
 */
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
