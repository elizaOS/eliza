/**
 * Cost estimation for RLM inference.
 *
 * Provides model pricing data and cost estimation utilities matching
 * the Python implementation (client.py).
 *
 * Pricing is per 1M tokens (USD). Override via ELIZA_RLM_PRICING_JSON env var.
 */

// ============================================================================
// Types
// ============================================================================

/** Cost per 1M tokens for a model. */
export interface ModelPricingEntry {
  /** Cost per 1M input tokens (USD). */
  input: number;
  /** Cost per 1M output tokens (USD). */
  output: number;
}

/** Result of a cost estimation. */
export interface CostEstimate {
  /** Model name. */
  model: string;
  /** Backend name (openai, anthropic, gemini, groq). */
  backend: string;
  /** Number of input tokens. */
  inputTokens: number;
  /** Number of output tokens. */
  outputTokens: number;
  /** Cost for input tokens (USD). */
  inputCostUsd: number;
  /** Cost for output tokens (USD). */
  outputCostUsd: number;
  /** Total cost (USD). */
  totalCostUsd: number;
}

type PricingTable = Record<string, Record<string, ModelPricingEntry>>;

// ============================================================================
// Pricing Data — matches Python MODEL_PRICING in client.py
// ============================================================================

/**
 * Default model pricing per 1M tokens (USD).
 *
 * Organized by backend → model → {input, output}.
 * Matches the Python MODEL_PRICING dictionary exactly.
 */
export const MODEL_PRICING: PricingTable = {
  openai: {
    "gpt-5": { input: 2.5, output: 10.0 },
    "gpt-5-preview": { input: 10.0, output: 30.0 },
    "gpt-5-mini": { input: 0.15, output: 0.6 },
    "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
  },
  anthropic: {
    "claude-3-5-sonnet-20241022": { input: 3.0, output: 15.0 },
    "claude-3-5-haiku-20241022": { input: 0.8, output: 4.0 },
    "claude-3-opus-20240229": { input: 15.0, output: 75.0 },
    "claude-3-sonnet-20240229": { input: 3.0, output: 15.0 },
    "claude-3-haiku-20240307": { input: 0.25, output: 1.25 },
  },
  gemini: {
    "gemini-2.0-flash-exp": { input: 0.0, output: 0.0 },
    "gemini-2.0-flash": { input: 0.075, output: 0.3 },
    "gemini-1.5-flash": { input: 0.075, output: 0.3 },
    "gemini-1.5-pro": { input: 1.25, output: 5.0 },
  },
  groq: {
    "openai/gpt-oss-120b": { input: 0.5, output: 0.8 },
  },
};

/** Fallback pricing when model is not found in the table. */
export const DEFAULT_PRICING: ModelPricingEntry = { input: 1.0, output: 3.0 };

// ============================================================================
// Pricing Management
// ============================================================================

/**
 * Set or override pricing for a model (costs per 1M tokens USD).
 *
 * Matches Python `set_model_pricing()`.
 */
export function setModelPricing(
  backend: string,
  model: string,
  inputCost: number,
  outputCost: number,
): void {
  if (!MODEL_PRICING[backend]) {
    MODEL_PRICING[backend] = {};
  }
  MODEL_PRICING[backend][model] = { input: inputCost, output: outputCost };
}

/**
 * Load custom pricing from ELIZA_RLM_PRICING_JSON environment variable.
 *
 * JSON format: `{ "backend": { "model": { "input": X, "output": Y } } }`
 *
 * Matches Python `load_pricing_from_env()`.
 */
export function loadPricingFromEnv(): void {
  const env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {};
  const pricingJson = env.ELIZA_RLM_PRICING_JSON;
  if (!pricingJson) return;

  try {
    const customPricing = JSON.parse(pricingJson) as PricingTable;
    for (const [backend, models] of Object.entries(customPricing)) {
      for (const [model, prices] of Object.entries(models)) {
        setModelPricing(backend, model, prices.input ?? 1.0, prices.output ?? 3.0);
      }
    }
  } catch (e) {
    console.warn(`[RLM] Failed to parse ELIZA_RLM_PRICING_JSON: ${e}`);
  }
}

// Load custom pricing on module import
loadPricingFromEnv();

// ============================================================================
// Cost Estimation Functions
// ============================================================================

/**
 * Estimate API cost in USD based on token counts.
 *
 * Looks up pricing for the given model. If `backend` is provided, searches
 * only that backend; otherwise searches all backends. Falls back to
 * DEFAULT_PRICING if the model is not found.
 *
 * Matches Python `estimate_cost()`.
 *
 * @param model - Model identifier (e.g. "gpt-5", "claude-3-opus-20240229")
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens
 * @param backend - Optional backend to restrict search (e.g. "openai")
 * @returns CostEstimate with computed costs
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  backend?: string,
): CostEstimate {
  let pricing: ModelPricingEntry | undefined;
  let resolvedBackend = backend ?? "";

  if (backend) {
    pricing = MODEL_PRICING[backend]?.[model];
  } else {
    // Search all backends for the model
    for (const [b, models] of Object.entries(MODEL_PRICING)) {
      if (models[model]) {
        pricing = models[model];
        resolvedBackend = b;
        break;
      }
    }
  }

  if (!pricing) {
    pricing = DEFAULT_PRICING;
  }

  const inputCostUsd = (inputTokens / 1_000_000) * pricing.input;
  const outputCostUsd = (outputTokens / 1_000_000) * pricing.output;

  return {
    model,
    backend: resolvedBackend,
    inputTokens,
    outputTokens,
    inputCostUsd,
    outputCostUsd,
    totalCostUsd: inputCostUsd + outputCostUsd,
  };
}

/**
 * Estimate token count for a text string.
 *
 * Uses a len/4 approximation (~4 characters per token). This matches
 * the Python fallback when tiktoken is not available.
 *
 * Matches Python `estimate_token_count()`.
 *
 * @param text - Input text to estimate tokens for
 * @returns Estimated number of tokens
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Detect RLM strategy from generated code.
 *
 * Strategies (from Paper Section 4.1):
 * - **peek**: Examining prefix/suffix of the prompt (`[:=`, `[:-`, `prompt[`)
 * - **grep**: Regex filtering (`re.search`, `re.findall`, `grep`)
 * - **chunk**: Splitting for parallel processing (`split(`, `partition(`, `chunk`)
 * - **stitch**: Combining sub-call results (`join(`, `concat`, `+=`)
 * - **subcall**: Recursive self-call (`rlm(`, `completion(`, `subcall`)
 * - **other**: Unclassified strategy
 *
 * Matches Python `detect_strategy()`.
 *
 * @param code - Code string to classify
 * @returns Strategy name
 */
export function detectStrategy(code: string): string {
  const c = code.toLowerCase();

  if (code.includes("[:=") || code.includes("[:-") || c.includes("prompt[")) {
    return "peek";
  }
  if (["re.search", "re.findall", "grep"].some((p) => c.includes(p))) {
    return "grep";
  }
  if (["split(", "partition(", "chunk"].some((p) => c.includes(p))) {
    return "chunk";
  }
  if (c.includes("join(") || c.includes("concat") || code.includes("+=")) {
    return "stitch";
  }
  if (["rlm(", "completion(", "subcall"].some((p) => c.includes(p))) {
    return "subcall";
  }
  return "other";
}
