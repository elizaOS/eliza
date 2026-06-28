/**
 * Token counter utilities (sync-only)
 *
 * These helpers are used by engine-side batching logic (e.g. MarketDecisionEngine)
 * without depending on `@feed/api` (to avoid circular dependencies).
 */

/**
 * Count tokens in text (synchronous approximation).
 *
 * Approximation: 1 token per 4 characters (conservative).
 */
export function countTokensSync(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Model-specific INPUT CONTEXT token limits.
 *
 * Note: Output limits are separate from input limits on modern models.
 */
const MODEL_TOKEN_LIMITS: Record<string, number> = {
  // OpenAI (input context)
  "gpt-5.1": 128000,
  "gpt-5-nano": 128000,
  "gpt-5-mini": 128000,
  "gpt-5": 128000,
  "gpt-5.1-turbo": 128000,
  "gpt-3.5-turbo": 16385,
  "gpt-3.5-turbo-16k": 16385,

  // ElizaCloud provider-prefixed OpenAI models
  "openai/gpt-5-nano": 128000,
  "openai/gpt-5-mini": 128000,
  "openai/gpt-5": 128000,
  "openai/gpt-5.1": 128000,
  "openai/gpt-5.1-instant": 128000,
  "openai/gpt-4o": 128000,
  "openai/gpt-4o-mini": 128000,
  "openai/gpt-4.1": 128000,
  "openai/gpt-4.1-mini": 128000,
  "openai/gpt-4.1-nano": 128000,

  // Gemma 4 / Feed strategy models
  "google/gemma-4-E2B-it": 131072,
  "google/gemma-4-E4B-it": 131072,
  "google/gemma-4-12B-it": 262144,
  "google/gemma-4-31B-it": 262144,

  // Legacy strategy models retained for old run metadata
  "unsloth/Qwen3-4B-128K": 131072,
  "unsloth/Qwen3-8B-128K": 131072,
  "unsloth/Qwen3-14B-128K": 131072,
  "unsloth/Qwen3-32B-128K": 131072,
  "OpenPipe/Qwen3-14B-Instruct": 32768,
  "Qwen/Qwen2.5-32B-Instruct": 131072,

  // Groq models (per https://console.groq.com/docs/models)
  "llama-3.1-8b-instant": 131072,
  "llama-3.3-70b-versatile": 131072,
  "llama-3.1-70b-versatile": 131072,
  "meta-llama/llama-guard-4-12b": 131072,
  "openai/gpt-oss-120b": 131072,
  "openai/gpt-oss-20b": 131072,
  "whisper-large-v3": 0,
  "whisper-large-v3-turbo": 0,

  // Groq preview models
  "meta-llama/llama-4-maverick-17b-128e-instruct": 131072,
  "meta-llama/llama-4-scout-17b-16e-instruct": 131072,
  "moonshotai/kimi-k2-instruct": 262144,
  "moonshotai/kimi-k2-instruct-0905": 262144,
  "openai/gpt-oss-safeguard-20b": 131072,
  "mixtral-8x7b-32768": 32768,

  // Anthropic (input context)
  "claude-sonnet-4-5": 200000,
  "claude-sonnet-4-5-20250929": 200000,
  "claude-haiku-4-5": 200000,
  "claude-haiku-4-5-20251001": 200000,
  "claude-opus-4-1": 200000,
  "claude-opus-4-1-20250805": 200000,
};

function getModelTokenLimit(model: string): number {
  return MODEL_TOKEN_LIMITS[model] || 8192; // Conservative default
}

/**
 * Calculate safe context limit with safety margin.
 *
 * Input and output are separate limits on modern models, so the default safety
 * margin is minimal (2%).
 */
export function getSafeContextLimit(
  model: string,
  _outputTokens = 8000, // Kept for API compatibility, but input/output are separate
  safetyMargin = 0.02,
): number {
  const inputLimit = getModelTokenLimit(model);
  const safeLimit = Math.floor(inputLimit * (1 - safetyMargin));
  return Math.max(1000, safeLimit);
}

/**
 * Truncate text to fit within token limit (synchronous approximation).
 */
export function truncateToTokenLimitSync(
  text: string,
  maxTokens: number,
  options: { ellipsis?: boolean; preserveEnd?: boolean } = {},
): { text: string; tokens: number } {
  const { ellipsis = true, preserveEnd = false } = options;

  const currentTokens = countTokensSync(text);
  if (currentTokens <= maxTokens) {
    return { text, tokens: currentTokens };
  }

  const ellipsisText = ellipsis ? "..." : "";
  const ellipsisTokens = ellipsis ? countTokensSync(ellipsisText) : 0;
  const targetTokens = maxTokens - ellipsisTokens;

  const targetChars = Math.floor(targetTokens * 4); // 4 chars per token

  const truncated = preserveEnd
    ? ellipsisText + text.slice(text.length - targetChars)
    : text.slice(0, targetChars) + ellipsisText;

  const finalTokens = countTokensSync(truncated);
  return { text: truncated, tokens: finalTokens };
}
