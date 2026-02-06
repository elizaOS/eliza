import { modelPricingRepository } from "@/db/repositories";

// Re-export constants from pricing-constants (safe for client components)
export {
  API_KEY_PREFIX_LENGTH,
  IMAGE_GENERATION_COST,
  VIDEO_GENERATION_COST,
  VIDEO_GENERATION_FALLBACK_COST,
  MONTHLY_CREDIT_CAP,
  PLATFORM_MARKUP_MULTIPLIER,
  TTS_COST_PER_1K_CHARS,
  STT_COST_PER_MINUTE,
  TTS_MINIMUM_COST,
  STT_MINIMUM_COST,
} from "@/lib/pricing-constants";

import { PLATFORM_MARKUP_MULTIPLIER } from "@/lib/pricing-constants";

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
 * @param model - Model identifier (e.g., "gpt-4o-mini").
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
): Promise<CostBreakdown> {
  const pricing = await modelPricingRepository.findByModelAndProvider(
    model,
    provider,
  );

  if (!pricing) {
    const fallbackCosts = getFallbackPricing(model, inputTokens, outputTokens);
    return fallbackCosts;
  }

  // Calculate base provider costs in cents
  const baseInputCostCents = Math.ceil(
    (inputTokens / 1000) *
      parseFloat(pricing.input_cost_per_1k.toString()) *
      100,
  );
  const baseOutputCostCents = Math.ceil(
    (outputTokens / 1000) *
      parseFloat(pricing.output_cost_per_1k.toString()) *
      100,
  );

  // Apply 20% platform markup
  const inputCostCents = Math.ceil(
    baseInputCostCents * PLATFORM_MARKUP_MULTIPLIER,
  );
  const outputCostCents = Math.ceil(
    baseOutputCostCents * PLATFORM_MARKUP_MULTIPLIER,
  );

  const inputCost = Math.round(inputCostCents) / 100;
  const outputCost = Math.round(outputCostCents) / 100;

  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
  };
}

/**
 * Gets fallback pricing when model pricing is not found in database.
 * Includes 20% platform markup.
 *
 * @param model - Model identifier.
 * @param inputTokens - Number of input tokens.
 * @param outputTokens - Number of output tokens.
 * @returns Cost breakdown using fallback pricing (with 20% markup).
 */
function getFallbackPricing(
  model: string,
  inputTokens: number,
  outputTokens: number,
): CostBreakdown {
  // Base provider pricing per 1k tokens (before markup)
  const pricingMap: Record<string, { input: number; output: number }> = {
    "gpt-4o": { input: 0.0025, output: 0.01 },
    "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
    "gpt-4-turbo": { input: 0.01, output: 0.03 },
    "gpt-3.5-turbo": { input: 0.0005, output: 0.0015 },
    "claude-3-5-sonnet-20241022": { input: 0.003, output: 0.015 },
    "claude-3-5-haiku-20241022": { input: 0.001, output: 0.005 },
  };

  const pricing = pricingMap[model] || { input: 0.0025, output: 0.01 };

  // Calculate base costs in cents
  const baseInputCostCents = Math.ceil(
    (inputTokens / 1000) * pricing.input * 100,
  );
  const baseOutputCostCents = Math.ceil(
    (outputTokens / 1000) * pricing.output * 100,
  );

  // Apply 20% platform markup
  const inputCostCents = Math.ceil(
    baseInputCostCents * PLATFORM_MARKUP_MULTIPLIER,
  );
  const outputCostCents = Math.ceil(
    baseOutputCostCents * PLATFORM_MARKUP_MULTIPLIER,
  );

  const inputCost = Math.round(inputCostCents) / 100;
  const outputCost = Math.round(outputCostCents) / 100;

  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
  };
}

/**
 * Extracts the provider name from a model identifier.
 *
 * Supports both prefixed format ("openai/gpt-4o-mini") and non-prefixed format ("gpt-4o-mini").
 *
 * @param model - Model identifier.
 * @returns Provider name (defaults to "openai" if unknown).
 */
export function getProviderFromModel(model: string): string {
  // Handle provider-prefixed format: "openai/gpt-4o-mini" or "anthropic/claude-3"
  if (model.includes("/")) {
    const [provider] = model.split("/");
    return provider;
  }

  // Handle non-prefixed format: "gpt-4o-mini"
  if (model.startsWith("gpt-")) return "openai";
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gemini-")) return "google";
  if (model.startsWith("llama")) return "meta";
  return "openai";
}

/**
 * Normalizes a model name by removing the provider prefix if present.
 *
 * @param model - Model identifier (e.g., "openai/gpt-4o-mini" or "gpt-4o-mini").
 * @returns Model name without provider prefix (e.g., "gpt-4o-mini").
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
 * @returns Estimated cost in USD with a 50% safety buffer (includes 20% markup).
 */
export async function estimateRequestCost(
  model: string,
  messages: Array<{ role: string; content: string | object }>,
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

  // Estimate output tokens (conservative estimate: 500 tokens)
  const estimatedOutputTokens = 500;

  const { totalCost } = await calculateCost(
    normalizedModel,
    provider,
    estimatedInputTokens,
    estimatedOutputTokens,
  );

  // Add 50% buffer for safety (increased from 20% to handle usage spikes)
  // Round to nearest cent (2 decimal places), minimum $0.01
  const bufferedCost = totalCost * 1.5;
  return Math.max(0.01, Math.ceil(bufferedCost * 100) / 100);
}

/**
 * Calculates TTS cost based on character count.
 * Includes 20% platform markup.
 *
 * @param characterCount - Number of characters in the text.
 * @returns Cost in USD (with 20% markup).
 */
export function calculateTTSCost(characterCount: number): number {
  const {
    TTS_COST_PER_1K_CHARS,
    TTS_MINIMUM_COST,
  } = require("@/lib/pricing-constants");
  const cost = (characterCount / 1000) * TTS_COST_PER_1K_CHARS;
  return Math.max(TTS_MINIMUM_COST, Math.round(cost * 10000) / 10000);
}

/**
 * Calculates STT cost based on audio duration.
 * Includes 20% platform markup.
 *
 * @param durationMinutes - Duration of audio in minutes.
 * @returns Cost in USD (with 20% markup).
 */
export function calculateSTTCost(durationMinutes: number): number {
  const {
    STT_COST_PER_MINUTE,
    STT_MINIMUM_COST,
  } = require("@/lib/pricing-constants");
  const cost = durationMinutes * STT_COST_PER_MINUTE;
  return Math.max(STT_MINIMUM_COST, Math.round(cost * 10000) / 10000);
}
