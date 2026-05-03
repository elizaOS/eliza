/**
 * Cost estimator for LLM API requests.
 *
 * Parses token usage from OpenAI and Anthropic response bodies
 * and applies model-specific pricing to estimate per-request cost.
 *
 * For unknown APIs or models, returns 0 (tracked but not billed).
 */

/** Pricing per 1K tokens (USD) */
interface ModelPricing {
  input: number;
  output: number;
}

/**
 * Model pricing table — top models as of March 2026.
 * Prices per 1,000 tokens.
 */
const PRICING: Record<string, ModelPricing> = {
  // OpenAI
  "gpt-4o": { input: 0.0025, output: 0.01 },
  "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
  "gpt-4.1": { input: 0.002, output: 0.008 },
  "gpt-4.1-mini": { input: 0.0004, output: 0.0016 },
  "gpt-4.1-nano": { input: 0.0001, output: 0.0004 },
  "o3-mini": { input: 0.0011, output: 0.0044 },

  // Anthropic
  "claude-sonnet-4-6": { input: 0.003, output: 0.015 },
  "claude-opus-4-6": { input: 0.015, output: 0.075 },
  "claude-haiku-3.5": { input: 0.0008, output: 0.004 },
  "claude-3-5-sonnet-20241022": { input: 0.003, output: 0.015 },
};

/**
 * Hosts we know how to parse cost from.
 */
const KNOWN_HOSTS = new Set(["api.openai.com", "api.anthropic.com"]);

/**
 * Try to match a model string to our pricing table.
 * Handles cases like "gpt-4o-2024-08-06" → "gpt-4o"
 */
function findModelPricing(model: string): ModelPricing | null {
  // Direct match
  if (PRICING[model]) return PRICING[model]!;

  // Try prefix match (e.g. "gpt-4o-2024-08-06" → "gpt-4o")
  for (const key of Object.keys(PRICING)) {
    if (model.startsWith(key)) return PRICING[key]!;
  }

  return null;
}

/**
 * Parse token usage from an OpenAI API response.
 */
function parseOpenAIUsage(responseBody: any): { inputTokens: number; outputTokens: number } | null {
  const usage = responseBody?.usage;
  if (!usage) return null;

  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
  };
}

/**
 * Parse token usage from an Anthropic API response.
 */
function parseAnthropicUsage(
  responseBody: any,
): { inputTokens: number; outputTokens: number } | null {
  const usage = responseBody?.usage;
  if (!usage) return null;

  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
  };
}

/**
 * Estimate the cost of an API request in USD.
 *
 * @param host - The API host (e.g. "api.openai.com")
 * @param requestBody - The parsed request body (needs .model)
 * @param responseBody - The parsed response body (needs .usage)
 * @returns Cost in USD, or 0 for unknown APIs/models
 */
export function estimateCost(host: string, requestBody: any, responseBody: any): number {
  if (!KNOWN_HOSTS.has(host)) return 0;

  // Determine model from request or response
  const model: string = requestBody?.model || responseBody?.model || "";
  if (!model) return 0;

  const pricing = findModelPricing(model);
  if (!pricing) return 0;

  // Parse usage based on host
  let usage: { inputTokens: number; outputTokens: number } | null = null;

  if (host === "api.openai.com") {
    usage = parseOpenAIUsage(responseBody);
  } else if (host === "api.anthropic.com") {
    usage = parseAnthropicUsage(responseBody);
  }

  if (!usage) return 0;

  // Cost = (input_tokens / 1000 * input_price) + (output_tokens / 1000 * output_price)
  const cost =
    (usage.inputTokens / 1000) * pricing.input + (usage.outputTokens / 1000) * pricing.output;

  return Math.round(cost * 1_000_000) / 1_000_000; // round to 6 decimal places
}

/**
 * Get the pricing table (for debugging / admin endpoints).
 */
export function getPricingTable(): Record<string, ModelPricing> {
  return { ...PRICING };
}

/**
 * Check if a host is a known LLM provider.
 */
export function isKnownHost(host: string): boolean {
  return KNOWN_HOSTS.has(host);
}
