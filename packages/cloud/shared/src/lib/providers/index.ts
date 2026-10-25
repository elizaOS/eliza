/**
 * AI provider implementations and singleton access.
 *
 * The Worker calls each provider DIRECTLY when we hold its native key (Groq,
 * Vast, OpenAI, Anthropic). OpenRouter (BYOK) is the backup: it serves models we
 * have no native key for. Per-family on-error failover lives in the AI-SDK
 * middleware in `language-model.ts` (`withRetryableFallback`).
 */

import { CEREBRAS_NATIVE_TEXT_MODELS, isGroqNativeModel, isVastNativeModel } from "../models";
import { AnthropicDirectProvider } from "./anthropic-direct";
import { CerebrasDirectProvider } from "./cerebras-direct";
import { GroqProvider } from "./groq";
import { canonicalizeCerebrasModelId } from "./language-model";
import { OpenAIDirectProvider } from "./openai-direct";
import { OpenRouterProvider } from "./openrouter";
import { getProviderKey, getRequiredProviderKey } from "./provider-env";
import type { AIProvider } from "./types";
import { VastProvider } from "./vast";
import { resolveVastEndpointConfig } from "./vast-endpoints";

export { AnthropicDirectProvider } from "./anthropic-direct";
// Note: anthropic-thinking parse helpers (parseAnthropicCotBudgetFromEnv, etc.) are exported
// as public API. Whitespace-only env values (e.g. "   ") will throw at startup rather than
// silently disable thinking - this is intentional fail-fast behavior.
export * from "./anthropic-thinking";
export { CerebrasDirectProvider } from "./cerebras-direct";
export { GroqProvider } from "./groq";
export { OpenAIDirectProvider } from "./openai-direct";
export { OpenRouterProvider } from "./openrouter";
export * from "./types";
export { VastProvider } from "./vast";
export * from "./vast-endpoints";

interface ProviderSingleton {
  apiKey: string;
  provider: AIProvider;
}

interface OpenAIDirectProviderSingleton extends ProviderSingleton {
  baseUrl?: string;
}

let groqProviderInstance: ProviderSingleton | null = null;
let cerebrasDirectProviderInstance: ProviderSingleton | null = null;
let openAIDirectProviderInstance: OpenAIDirectProviderSingleton | null = null;
let anthropicDirectProviderInstance: ProviderSingleton | null = null;
let openRouterProviderInstance: OpenAIDirectProviderSingleton | null = null;
let vastProviderInstances = new Map<string, AIProvider>();

export function hasGroqProviderConfigured(): boolean {
  return Boolean(getProviderKey("GROQ_API_KEY"));
}

export function getGroqProvider(): AIProvider {
  const apiKey = getRequiredProviderKey("GROQ_API_KEY");
  if (!groqProviderInstance || groqProviderInstance.apiKey !== apiKey) {
    groqProviderInstance = {
      apiKey,
      provider: new GroqProvider(apiKey),
    };
  }

  return groqProviderInstance.provider;
}

function cerebrasModelId(model: string): string | null {
  const canonical = canonicalizeCerebrasModelId(model);
  return CEREBRAS_NATIVE_TEXT_MODELS.includes(
    canonical as (typeof CEREBRAS_NATIVE_TEXT_MODELS)[number],
  )
    ? canonical
    : null;
}

function isCerebrasCatalogModel(model: string): boolean {
  let id = model.trim();
  if (id.startsWith("openai/")) id = id.slice("openai/".length);
  else if (id.startsWith("cerebras/")) id = id.slice("cerebras/".length);
  else if (id.startsWith("cerebras:")) id = id.slice("cerebras:".length);
  const baseId = id.split(":")[0];
  return CEREBRAS_NATIVE_TEXT_MODELS.includes(
    baseId as (typeof CEREBRAS_NATIVE_TEXT_MODELS)[number],
  );
}

function hasCerebrasDirectConfigured(): boolean {
  return Boolean(getProviderKey("CEREBRAS_API_KEY"));
}

function getCerebrasDirectProvider(): AIProvider {
  const apiKey = getRequiredProviderKey("CEREBRAS_API_KEY");
  if (!cerebrasDirectProviderInstance || cerebrasDirectProviderInstance.apiKey !== apiKey) {
    cerebrasDirectProviderInstance = {
      apiKey,
      provider: new CerebrasDirectProvider(apiKey),
    };
  }
  return cerebrasDirectProviderInstance.provider;
}

function hasOpenAIDirectConfigured(): boolean {
  return Boolean(getProviderKey("OPENAI_API_KEY"));
}

function getOpenAIDirectProvider(): AIProvider {
  const apiKey = getRequiredProviderKey("OPENAI_API_KEY");
  const baseUrl = getProviderKey("OPENAI_BASE_URL") ?? undefined;
  if (
    !openAIDirectProviderInstance ||
    openAIDirectProviderInstance.apiKey !== apiKey ||
    openAIDirectProviderInstance.baseUrl !== baseUrl
  ) {
    openAIDirectProviderInstance = {
      apiKey,
      baseUrl,
      provider: new OpenAIDirectProvider(apiKey, baseUrl),
    };
  }
  return openAIDirectProviderInstance.provider;
}

function hasAnthropicDirectConfigured(): boolean {
  return Boolean(getProviderKey("ANTHROPIC_API_KEY"));
}

function getAnthropicDirectProvider(): AIProvider {
  const apiKey = getRequiredProviderKey("ANTHROPIC_API_KEY");
  if (!anthropicDirectProviderInstance || anthropicDirectProviderInstance.apiKey !== apiKey) {
    anthropicDirectProviderInstance = {
      apiKey,
      provider: new AnthropicDirectProvider(apiKey),
    };
  }
  return anthropicDirectProviderInstance.provider;
}

export function hasOpenRouterProviderConfigured(): boolean {
  return Boolean(getProviderKey("OPENROUTER_API_KEY"));
}

/**
 * OpenRouter direct provider (BYOK) — the backup for models we have no native
 * key for.
 */
export function getOpenRouterProvider(): AIProvider {
  const apiKey = getRequiredProviderKey("OPENROUTER_API_KEY");
  const baseUrl = getProviderKey("OPENROUTER_BASE_URL") ?? undefined;
  if (
    !openRouterProviderInstance ||
    openRouterProviderInstance.apiKey !== apiKey ||
    openRouterProviderInstance.baseUrl !== baseUrl
  ) {
    openRouterProviderInstance = {
      apiKey,
      baseUrl,
      provider: new OpenRouterProvider(apiKey, baseUrl),
    };
  }
  return openRouterProviderInstance.provider;
}

export function hasVastProviderConfigured(model = "vast/eliza-1-27b"): boolean {
  return resolveVastEndpointConfig(model) !== null;
}

export function getVastProvider(model = "vast/eliza-1-27b"): AIProvider {
  const config = resolveVastEndpointConfig(model);
  if (!config) {
    throw new Error(`Vast endpoint is not configured for ${model}`);
  }
  const cacheKey = `${config.model}|${config.apiKey}|${config.baseUrl}|${config.apiModelId}`;
  const cached = vastProviderInstances.get(cacheKey);
  if (cached) return cached;
  const provider = new VastProvider(config.apiKey, config.baseUrl, {
    apiModelId: config.apiModelId,
  });
  vastProviderInstances.set(cacheKey, provider);
  return provider;
}

export function getProviderForModel(model: string): AIProvider {
  if (isGroqNativeModel(model)) {
    return getGroqProvider();
  }

  if (isVastNativeModel(model)) {
    return getVastProvider(model);
  }

  const directCerebrasModel = cerebrasModelId(model);
  if (directCerebrasModel || isCerebrasCatalogModel(model)) {
    if (directCerebrasModel && hasCerebrasDirectConfigured()) {
      return getCerebrasDirectProvider();
    }
    return getOpenRouterProvider();
  }

  if (model.startsWith("openai/") && hasOpenAIDirectConfigured()) {
    return getOpenAIDirectProvider();
  }

  if (model.startsWith("anthropic/") && hasAnthropicDirectConfigured()) {
    return getAnthropicDirectProvider();
  }

  return getOpenRouterProvider();
}
