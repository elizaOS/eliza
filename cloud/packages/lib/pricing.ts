import { normalizeProviderKey } from "@/lib/providers/model-id-translation";
import {
  calculateImageGenerationCostFromCatalog,
  calculateSTTCostFromCatalog,
  calculateTextCostFromCatalog,
  calculateTTSCostFromCatalog,
  calculateVideoGenerationCostFromCatalog,
  calculateVoiceCloneCostFromCatalog,
} from "@/lib/services/ai-pricing";
import type { PricingBillingSource } from "@/lib/services/ai-pricing-definitions";

// Re-export constants from pricing-constants (safe for client components)
export {
  API_KEY_PREFIX_LENGTH,
  IMAGE_GENERATION_COST,
  MONTHLY_CREDIT_CAP,
  PLATFORM_MARKUP_MULTIPLIER,
  STT_COST_PER_MINUTE,
  STT_MINIMUM_COST,
  TTS_COST_PER_1K_CHARS,
  TTS_MINIMUM_COST,
  VIDEO_GENERATION_COST,
  VIDEO_GENERATION_FALLBACK_COST,
} from "@/lib/pricing-constants";

// Local import for constants used within this file
import { STT_MINIMUM_COST, TTS_MINIMUM_COST } from "@/lib/pricing-constants";

// =============================================================================
// COST CALCULATION INTERFACES & FUNCTIONS
// =============================================================================

/**
 * Breakdown of costs for a model request.
 */
export interface CostBreakdown {
  /** Cost for input tokens in USD (includes 20% platform markup). */
  inputCost: number;
  /** Cost for output tokens in USD (includes 20% platform markup). */
  outputCost: number;
  /** Total cost (input + output) in USD (includes 20% platform markup). */
  totalCost: number;
}

/**
 * Calculates the cost for a model request based on token usage.
 * Includes 20% platform markup on top of provider costs.
 *
 * @param model - Model identifier (e.g., "gpt-5-mini").
 * @param provider - Provider name (e.g., "openai").
 * @param inputTokens - Number of input tokens.
 * @param outputTokens - Number of output tokens.
 * @returns Cost breakdown with input, output, and total costs (with 20% markup).
 */
export async function calculateCost(
  model: string,
  provider: string,
  inputTokens: number,
  outputTokens: number,
  billingSource?: PricingBillingSource,
): Promise<CostBreakdown> {
  const breakdown = await calculateTextCostFromCatalog({
    model,
    provider,
    billingSource,
    inputTokens,
    outputTokens,
  });
  return {
    inputCost: breakdown.inputCost,
    outputCost: breakdown.outputCost,
    totalCost: breakdown.totalCost,
  };
}

/**
 * Extracts the provider name from a model identifier.
 *
 * Supports both prefixed format ("openai/gpt-5-mini") and non-prefixed format ("gpt-5-mini").
 *
 * @param model - Model identifier.
 * @returns Provider name (defaults to "openai" if unknown).
 */
export function getProviderFromModel(model: string): string {
  // Handle provider-prefixed format: "openai/gpt-5-mini" or "anthropic/claude-3"
  if (model.includes("/")) {
    const [provider] = model.split("/");
    return normalizeProviderKey(provider);
  }

  // Handle non-prefixed format: "gpt-5-mini"
  if (model.startsWith("gpt-")) return "openai";
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gemini-")) return "google";
  if (model.startsWith("llama")) return "meta";
  return "openai";
}

/**
 * Checks if a model is a reasoning model that doesn't support temperature.
 */
export function isReasoningModel(model: string): boolean {
  const name = normalizeModelName(model);
  return name.startsWith("claude-opus") || /^o[13](-|$)/.test(name);
}

/**
 * Returns provider-safe model parameters by stripping unsupported settings.
 * Anthropic doesn't support frequencyPenalty or presencePenalty.
 * Reasoning models (claude-opus, o1, o3) don't support temperature.
 */
export function getSafeModelParams(
  model: string,
  params: {
    temperature?: number;
    topP?: number;
    topK?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    stopSequences?: string[];
  },
): {
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stopSequences?: string[];
} {
  const provider = getProviderFromModel(model);
  const result: typeof params = { ...params };

  if (provider === "anthropic") {
    delete result.frequencyPenalty;
    delete result.presencePenalty;
  } else {
    delete result.topK;
  }

  if (isReasoningModel(model)) {
    delete result.temperature;
  }

  return result;
}

/**
 * Normalizes a model name by removing the provider prefix if present.
 *
 * @param model - Model identifier (e.g., "openai/gpt-5-mini" or "gpt-5-mini").
 * @returns Model name without provider prefix (e.g., "gpt-5-mini").
 */
export function normalizeModelName(model: string): string {
  if (model.includes("/")) {
    const [, modelName] = model.split("/");
    return modelName;
  }
  return model;
}

/**
 * Estimates token count from text using a rough approximation.
 *
 * Uses the average ratio of 1 token ≈ 4 characters.
 *
 * @param text - Text to estimate tokens for.
 * @returns Estimated number of tokens.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimates the cost for a chat request before making the API call.
 * Includes 20% platform markup.
 *
 * Used for pre-flight credit checking. Handles both string and multimodal content.
 *
 * @param model - Model identifier.
 * @param messages - Array of messages with role and content (string or multimodal object).
 * @param maxOutputTokens - Optional explicit output token estimate from the caller.
 * @returns Estimated cost in USD with a 50% safety buffer (includes 20% markup).
 */
export async function estimateRequestCost(
  model: string,
  messages: Array<{ role: string; content: string | object }>,
  maxOutputTokens?: number,
): Promise<number> {
  const provider = getProviderFromModel(model);
  const normalizedModel = normalizeModelName(model);

  // Estimate input tokens from messages
  // Handle both string content and multimodal content
  const messageText = messages
    .map((m) => {
      if (typeof m.content === "string") {
        return m.content;
      } else if (m.content && typeof m.content === "object") {
        // For multimodal content, stringify and estimate
        // This is a rough approximation
        return JSON.stringify(m.content);
      }
      return "";
    })
    .join(" ");

  const estimatedInputTokens = estimateTokens(messageText);

  const estimatedOutputTokens =
    typeof maxOutputTokens === "number" && maxOutputTokens > 0 ? maxOutputTokens : 500;

  const { totalCost } = await calculateCost(
    normalizedModel,
    provider,
    estimatedInputTokens,
    estimatedOutputTokens,
  );

  // Add 50% buffer for safety (increased from 20% to handle usage spikes)
  const bufferedCost = totalCost * 1.5;
  return Math.max(0.000001, Math.ceil(bufferedCost * 1_000_000) / 1_000_000);
}

/**
 * Calculates TTS cost based on character count.
 * Includes 20% platform markup.
 *
 * @param characterCount - Number of characters in the text.
 * @returns Cost in USD (with 20% markup).
 */
export async function calculateTTSCost(
  characterCount: number,
  model: string = "elevenlabs/eleven_flash_v2_5",
): Promise<number> {
  const cost = await calculateTTSCostFromCatalog({
    model,
    characterCount,
  });
  return Math.max(TTS_MINIMUM_COST, cost.totalCost);
}

/**
 * Calculates STT cost based on audio duration.
 * Includes 20% platform markup.
 *
 * @param durationMinutes - Duration of audio in minutes.
 * @returns Cost in USD (with 20% markup).
 */
export async function calculateSTTCost(
  durationMinutes: number,
  model: string = "elevenlabs/scribe_v1",
): Promise<number> {
  const cost = await calculateSTTCostFromCatalog({
    model,
    durationSeconds: durationMinutes * 60,
  });
  return Math.max(STT_MINIMUM_COST, cost.totalCost);
}

export async function calculateImageCost(
  model: string,
  provider: string,
  imageCount: number,
  dimensions?: Record<string, unknown>,
): Promise<number> {
  const cost = await calculateImageGenerationCostFromCatalog({
    model,
    provider,
    imageCount,
    dimensions,
  });
  return cost.totalCost;
}

export async function calculateVideoCost(
  model: string,
  durationSeconds: number,
  dimensions?: Record<string, unknown>,
): Promise<number> {
  const cost = await calculateVideoGenerationCostFromCatalog({
    model,
    durationSeconds,
    dimensions,
  });
  return cost.totalCost;
}

export async function calculateVoiceCloneCost(
  cloneType: "instant" | "professional",
): Promise<number> {
  const cost = await calculateVoiceCloneCostFromCatalog({ cloneType });
  return cost.totalCost;
}
