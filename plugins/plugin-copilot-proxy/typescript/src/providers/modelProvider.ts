import {
  createOpenAICompatible,
  type OpenAICompatibleProvider,
} from "@ai-sdk/openai-compatible";
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  getBaseUrl,
  getContextWindow,
  getLargeModel,
  getMaxTokens,
  getSmallModel,
  isBrowser,
  isPluginEnabled,
} from "../environment";
import type { ModelName, ValidatedBaseUrl } from "../types";

/**
 * Default models available through Copilot Proxy.
 */
export const DEFAULT_MODELS = [
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5-mini",
  "claude-opus-4.5",
  "claude-sonnet-4.5",
  "claude-haiku-4.5",
  "gemini-3-pro",
  "gemini-3-flash",
  "grok-code-fast-1",
] as const;

export type DefaultModelId = (typeof DEFAULT_MODELS)[number];

/**
 * Model definition for Copilot Proxy models.
 */
export interface CopilotProxyModelDefinition {
  readonly id: string;
  readonly name: string;
  readonly api: "openai-completions";
  readonly reasoning: boolean;
  readonly input: readonly string[];
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
  readonly contextWindow: number;
  readonly maxTokens: number;
}

/**
 * Build a model definition for a given model ID.
 */
export function buildModelDefinition(
  modelId: string,
  contextWindow: number = 128000,
  maxTokens: number = 8192,
): CopilotProxyModelDefinition {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

/**
 * Model provider configuration.
 */
export interface ModelProviderConfig {
  readonly baseUrl: ValidatedBaseUrl;
  readonly smallModel: ModelName;
  readonly largeModel: ModelName;
  readonly contextWindow: number;
  readonly maxTokens: number;
}

/**
 * Get model provider configuration from runtime.
 */
export function getModelProviderConfig(
  runtime: IAgentRuntime,
): ModelProviderConfig | null {
  if (!isPluginEnabled(runtime)) {
    logger.debug("[CopilotProxy] Plugin is disabled");
    return null;
  }

  const baseUrl = getBaseUrl(runtime);
  const smallModel = getSmallModel(runtime);
  const largeModel = getLargeModel(runtime);
  const contextWindow = getContextWindow(runtime);
  const maxTokens = getMaxTokens(runtime);

  return {
    baseUrl,
    smallModel,
    largeModel,
    contextWindow,
    maxTokens,
  };
}

/**
 * Cached provider instance.
 */
let cachedProvider: OpenAICompatibleProvider<string> | null = null;
let cachedBaseUrl: string | null = null;

/**
 * Create an OpenAI-compatible model provider for Copilot Proxy.
 *
 * This provider uses the Vercel AI SDK's OpenAI-compatible adapter
 * to communicate with the Copilot Proxy server.
 */
export function createCopilotProxyProvider(
  runtime: IAgentRuntime,
): OpenAICompatibleProvider<string> {
  const baseURL = isBrowser() ? undefined : getBaseUrl(runtime);
  const urlString = baseURL ?? "http://localhost:3000/v1";

  // Return cached provider if URL hasn't changed
  if (cachedProvider && cachedBaseUrl === urlString) {
    return cachedProvider;
  }

  const provider = createOpenAICompatible({
    name: "copilot-proxy",
    baseURL: urlString,
    // Copilot Proxy doesn't require authentication
    apiKey: "n/a",
    // Don't send authorization header
    headers: {},
  });

  cachedProvider = provider;
  cachedBaseUrl = urlString;

  return provider;
}

/**
 * Create a model instance for a specific model ID.
 */
export function createModelInstance(runtime: IAgentRuntime, modelId: string) {
  const provider = createCopilotProxyProvider(runtime);
  return provider(modelId);
}

/**
 * Get the small model instance.
 */
export function getSmallModelInstance(runtime: IAgentRuntime) {
  const modelId = getSmallModel(runtime);
  return createModelInstance(runtime, modelId);
}

/**
 * Get the large model instance.
 */
export function getLargeModelInstance(runtime: IAgentRuntime) {
  const modelId = getLargeModel(runtime);
  return createModelInstance(runtime, modelId);
}

/**
 * Check if a model ID is a known default model.
 */
export function isDefaultModel(modelId: string): modelId is DefaultModelId {
  return DEFAULT_MODELS.includes(modelId as DefaultModelId);
}

/**
 * Get all available model definitions.
 */
export function getAvailableModels(
  contextWindow: number = 128000,
  maxTokens: number = 8192,
): CopilotProxyModelDefinition[] {
  return DEFAULT_MODELS.map((modelId) =>
    buildModelDefinition(modelId, contextWindow, maxTokens),
  );
}

export { createCopilotProxyProvider as createProvider };
