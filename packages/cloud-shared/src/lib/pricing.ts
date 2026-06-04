import { normalizeProviderKey } from "./providers/model-id-translation";
import {
  calculateImageGenerationCostFromCatalog,
  calculateSTTCostFromCatalog,
  calculateTextCostFromCatalog,
  calculateTTSCostFromCatalog,
  calculateVideoGenerationCostFromCatalog,
  calculateVoiceCloneCostFromCatalog,
} from "./services/ai-pricing";
import type { PricingBillingSource } from "./services/ai-pricing-definitions";

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
} from "./pricing-constants";

// Local import for constants used within this file
import { STT_MINIMUM_COST, TTS_MINIMUM_COST } from "./pricing-constants";

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

  if (model.startsWith("cerebras:")) return "cerebras";

  // Handle non-prefixed format: "gpt-5-mini"
  if (model.startsWith("gpt-")) return "openai";
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gemini-")) return "google";
  if (model.startsWith("llama")) return "meta";
  return "openai";
}

/**
 * Checks if a model is a reasoning model that doesn't support temperature.
 *
 * NOTE: this is intentionally narrow. It governs ONLY temperature stripping in
 * {@link getSafeModelParams}; broadening it would strip temperature from models
 * that do accept it. For "does this model spend output tokens on hidden
 * reasoning before emitting an answer" (the token-budget concern), use
 * {@link modelUsesReasoningTokens} instead.
 */
export function isReasoningModel(model: string): boolean {
  const name = normalizeModelName(model);
  return name.startsWith("claude-opus") || /^o[13](-|$)/.test(name);
}

/**
 * Patterns for models that consume output tokens on hidden chain-of-thought /
 * reasoning before emitting any visible answer. When max_tokens is too small to
 * cover both the reasoning and a response, these models truncate mid-reasoning
 * and return empty content while still billing the consumed tokens.
 *
 * Matched against the provider-stripped model name (see normalizeModelName), so
 * e.g. "minimax/minimax-m3" is matched as "minimax-m3". Kept broad on purpose:
 * a false positive only raises the effective token floor slightly; a false
 * negative silently bills the caller for empty output.
 */
const REASONING_MODEL_PATTERNS: RegExp[] = [
  // OpenAI o-series + gpt-5 reasoning tiers
  /^o[1345](-|$|\.)/,
  /^gpt-5.*\b(thinking|reasoning)\b/,
  // Anthropic extended-thinking opus/sonnet
  /^claude-(opus|sonnet)/,
  // DeepSeek R-series + explicit reasoner
  /^deepseek-(r\d|reasoner)/,
  /\bdeepseek-r\d/,
  // MiniMax M-series (M1/M2/M3...) are reasoning models
  /^minimax-m\d/,
  // Qwen / QwQ thinking tiers
  /^qwq/,
  /^qwen.*(think|reasoning|-max)/,
  // Generic "think"/"reasoning" suffixes used across many vendors
  // (olmo-3-32b-think, nemotron-...-reasoning, glm-...-thinking, kimi-...-think)
  /(think|thinking|reasoning|reasoner)(:|$|-)/,
  // Grok reasoning builds
  /^grok.*(reasoning|think)/,
  // Z.ai GLM reasoning
  /^glm-.*(think|reasoning)/,
];

/**
 * Authoritative signal: a model is a reasoning model if the upstream catalog
 * advertises a reasoning parameter for it. Many reasoning models (kimi-k2.6,
 * glm-5.1, deepseek-v4-pro, minimax-m3, ...) do NOT carry "think"/"reasoning"
 * in their id, so name patterns alone miss them — but they all list
 * "reasoning" / "include_reasoning" in supported_parameters.
 */
function supportedParametersIndicateReasoning(
  supportedParameters: readonly string[] | undefined,
): boolean {
  if (!supportedParameters || supportedParameters.length === 0) return false;
  return supportedParameters.some((p) => {
    const k = p.toLowerCase();
    return k === "reasoning" || k === "include_reasoning" || k === "reasoning_effort";
  });
}

/**
 * Whether a model spends output tokens on hidden reasoning before answering.
 * Used to guarantee a minimum response-token budget so reasoning models do not
 * truncate mid-thought and return empty (but billed) completions.
 *
 * Prefers the authoritative catalog signal (supported_parameters); falls back to
 * id name patterns when catalog metadata is unavailable (e.g. the catalog fetch
 * failed or the model is not listed). Either signal being positive is enough —
 * a false positive only nudges the token floor up; a false negative silently
 * bills the caller for empty output.
 *
 * @param model The model id (provider-prefixed is fine).
 * @param supportedParameters Optional catalog-advertised parameters for the model.
 */
export function modelUsesReasoningTokens(
  model: string,
  supportedParameters?: readonly string[],
): boolean {
  if (supportedParametersIndicateReasoning(supportedParameters)) return true;
  const name = normalizeModelName(model).toLowerCase();
  return REASONING_MODEL_PATTERNS.some((re) => re.test(name));
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
  if (model.startsWith("cerebras:")) {
    return model.slice("cerebras:".length);
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
