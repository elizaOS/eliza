/**
 * AI SDK provider factory for mlx-lm.server.
 *
 * `mlx-lm.server`'s HTTP API is OpenAI-compatible, so we use
 * `@ai-sdk/openai-compatible` (not `@ai-sdk/openai`) — that adapter is
 * purpose-built for OpenAI-shaped servers that don't implement the full OpenAI
 * feature surface (assistants, image generation, etc), which describes mlx-lm
 * exactly.
 *
 * Why a thin wrapper: the AI SDK exposes `createOpenAICompatible` with a `name`,
 * `baseURL`, and optional `apiKey`. Centralizing the factory means tests can mock
 * one entry point, and the auto-detect + init paths share the same client construction.
 */

import { createOpenAICompatible, type OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import type { IAgentRuntime } from "@elizaos/core";
import { getApiKey, getBaseURL } from "./config";

export type MlxProvider = OpenAICompatibleProvider;

export function createMlxClient(runtime: IAgentRuntime): MlxProvider {
  const baseURL = getBaseURL(runtime);
  const apiKey = getApiKey(runtime);

  return createOpenAICompatible({
    name: "mlx",
    baseURL,
    ...(apiKey ? { apiKey } : {}),
    fetch: runtime.fetch ?? undefined,
    includeUsage: true,
  });
}
