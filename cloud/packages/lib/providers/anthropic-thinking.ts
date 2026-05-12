/**
 * Anthropic extended thinking: **`user_characters.settings`** per agent + optional deploy env defaults/caps.
 *
 * **Why per-agent setting:** Cloud agents (characters) own their inference policy; creators enable or
 * disable thinking and pick a token budget without redeploying the platform.
 * **Why still use env:** `ANTHROPIC_COT_BUDGET` is the default when the character omits
 * {@link ANTHROPIC_THINKING_BUDGET_CHARACTER_SETTINGS_KEY}. `ANTHROPIC_COT_BUDGET_MAX` optionally caps any
 * effective budget so operators bound worst-case cost. API request bodies must not carry thinking budgets
 * (not client-controlled).
 * **Why merge helpers:** Routes set `google` key alongside `anthropic`; shallow merge would drop nested keys.
 *
 * **Spread helpers** (pick one per call site):
 * - {@link mergeAnthropicCotProviderOptions} — plain `streamText` / `generateText`.
 * - {@link mergeGoogleImageModalitiesWithAnthropicCot} — Gemini-style image + optional agent budget.
 *
 * @see docs/anthropic-cot-budget.md
 */

import type { AnthropicProviderOptions } from "@ai-sdk/anthropic";
import { getProviderFromModel } from "@/lib/pricing";
import type { CloudJsonObject, CloudMergedProviderOptions } from "./cloud-provider-options";

/**
 * Models that support Anthropic extended thinking.
 * Supported: Claude Sonnet 4.x and Claude Opus 4.x model IDs, including 4.6 and 4.7.
 * Not supported: Haiku, Instant, Claude 3.x Sonnet/Opus, and older Claude 2 variants.
 * Note: Patterns do not use ^ anchor to support provider-prefixed model IDs (e.g. "anthropic/claude-sonnet-4.6").
 */
const EXTENDED_THINKING_MODEL_PATTERNS = [
  /claude-sonnet-4/, // Claude Sonnet 4
  /claude-opus-4/, // Claude Opus 4
];

/**
 * Check if the given model ID supports extended thinking.
 * Not all Anthropic models support this feature.
 * Handles both bare model IDs (e.g. "claude-sonnet-4-6") and
 * provider-prefixed IDs (e.g. "anthropic/claude-sonnet-4.6").
 */
export function supportsExtendedThinking(modelId: string): boolean {
  const normalizedId = modelId.toLowerCase();
  return EXTENDED_THINKING_MODEL_PATTERNS.some((pattern) => pattern.test(normalizedId));
}

const ENV_KEY = "ANTHROPIC_COT_BUDGET";
const ENV_MAX_KEY = "ANTHROPIC_COT_BUDGET_MAX";

/** `user_characters.settings` key for per-agent thinking token budget (integer ≥ 0). */
export const ANTHROPIC_THINKING_BUDGET_CHARACTER_SETTINGS_KEY = "anthropicThinkingBudgetTokens";

/** Subset of env used for tests and callers that only pass a few keys. */
export type AnthropicCotEnv = Record<string, string | undefined>;

export type { CloudMergedProviderOptions } from "./cloud-provider-options";

function parsePositiveIntStrict(raw: string, keyLabel: string): number {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new Error(`${keyLabel} is non-empty but whitespace-only`);
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `${keyLabel} must be a non-negative integer string, got: ${JSON.stringify(raw)}`,
    );
  }
  const n = Number.parseInt(trimmed, 10);
  if (n > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${keyLabel} exceeds safe integer range`);
  }
  return n;
}

/**
 * Reads ANTHROPIC_COT_BUDGET from env.
 * - unset / empty → null (off)
 * - "0" or negative as string not possible with strict digit regex; 0 from digits → null
 * - invalid non-empty → throws
 */
export function parseAnthropicCotBudgetFromEnv(env: AnthropicCotEnv = process.env): number | null {
  const raw = env[ENV_KEY];
  if (raw === undefined || raw === "") {
    return null;
  }
  const n = parsePositiveIntStrict(raw, ENV_KEY);
  if (n <= 0) {
    return null;
  }
  return n;
}

/**
 * Optional ceiling for any effective thinking budget (env default or per-character setting).
 * Unset / empty / "0" → no cap. Positive → clamp `min(effective, max)`.
 */
export function parseAnthropicCotBudgetMaxFromEnv(
  env: AnthropicCotEnv = process.env,
): number | null {
  const raw = env[ENV_MAX_KEY];
  // Note: allows flexibility in configuring the budget cap via environmental settings.
  if (raw === undefined || raw === "") {
    return null;
  }
  const n = parsePositiveIntStrict(raw, ENV_MAX_KEY);
  if (n <= 0) {
    return null;
  }
  return n;
}

/**
 * Reads {@link ANTHROPIC_THINKING_BUDGET_CHARACTER_SETTINGS_KEY} from character `settings` JSON.
 * Invalid or missing values → `undefined` (caller should fall back to env default).
 */
export function parseThinkingBudgetFromCharacterSettings(
  settings: Record<string, unknown> | null | undefined,
): number | undefined {
  if (!settings || typeof settings !== "object") {
    return undefined;
  }
  const raw = settings[ANTHROPIC_THINKING_BUDGET_CHARACTER_SETTINGS_KEY];
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return undefined;
  }
  if (raw < 0 || raw > Number.MAX_SAFE_INTEGER) {
    return undefined;
  }
  return raw;
}

/**
 * Single place that decides whether thinking runs and with how many tokens.
 *
 * **Why `agentThinkingBudgetTokens` wins when defined:** Stored character settings are owner-controlled;
 * `0` explicitly disables even if `ANTHROPIC_COT_BUDGET` is set. **Why `undefined` falls back to env:**
 * Generic routes and agents without a setting inherit deploy policy. **Why clamp with max:** Operators
 * bound worst-case spend regardless of character JSON.
 */
export function resolveAnthropicThinkingBudgetTokens(
  modelId: string,
  env: AnthropicCotEnv,
  agentThinkingBudgetTokens?: number,
): number | null {
  if (getProviderFromModel(modelId) !== "anthropic") {
    return null;
  }
  // Not all Anthropic models support extended thinking (e.g. Haiku, Instant, Claude 2)
  if (!supportsExtendedThinking(modelId)) {
    return null;
  }
  const maxCap = parseAnthropicCotBudgetMaxFromEnv(env);
  let base: number | null;
  if (agentThinkingBudgetTokens !== undefined) {
    if (agentThinkingBudgetTokens <= 0) {
      return null;
    }
    base = agentThinkingBudgetTokens;
  } else {
    base = parseAnthropicCotBudgetFromEnv(env);
  }
  if (base === null) {
    return null;
  }
  if (maxCap !== null && base > maxCap) {
    return maxCap;
  }
  return base;
}

const anthropicThinkingOptions = (budgetTokens: number): AnthropicProviderOptions => ({
  thinking: { type: "enabled", budgetTokens },
});

/**
 * AI SDK provider options fragment when budget is active and model is Anthropic.
 *
 * @param agentThinkingBudgetTokens When set (including `0` handled as off via {@link resolveAnthropicThinkingBudgetTokens}),
 * uses the character's budget; when omitted, uses `ANTHROPIC_COT_BUDGET` only.
 */
export function anthropicThinkingProviderOptions(
  modelId: string,
  env: AnthropicCotEnv = process.env,
  agentThinkingBudgetTokens?: number,
): { providerOptions: CloudMergedProviderOptions } | Record<string, never> {
  const budget = resolveAnthropicThinkingBudgetTokens(modelId, env, agentThinkingBudgetTokens);
  if (budget === null) {
    return {};
  }
  const anthropic = anthropicThinkingOptions(budget) as CloudJsonObject;
  return {
    providerOptions: {
      anthropic,
    },
  };
}

/**
 * Deep-merge nested provider keys so google / anthropic fragments are preserved.
 *
 * Note: Only `anthropic` and `google` keys are deep-merged. Other provider keys
 * (e.g. `openai`, `mistral`) present in both `base` and `extra` will be clobbered by the
 * top-level spread. Extend the merge list below if additional providers need deep merging.
 */
export function mergeProviderOptions(
  base?: { providerOptions?: CloudMergedProviderOptions },
  extra?: { providerOptions?: CloudMergedProviderOptions },
): { providerOptions: CloudMergedProviderOptions } | Record<string, never> {
  const a = base?.providerOptions;
  const b = extra?.providerOptions;
  if (!a && !b) {
    return {};
  }
  const out: CloudMergedProviderOptions = { ...a, ...b };
  if (a?.anthropic && b?.anthropic) {
    out.anthropic = { ...a.anthropic, ...b.anthropic };
  }
  if (a?.google && b?.google) {
    out.google = { ...a.google, ...b.google };
  }
  return { providerOptions: out };
}

/**
 * Spread into `streamText` / `generateText` after model and messages.
 * Equivalent to `mergeProviderOptions(undefined, anthropicThinkingProviderOptions(modelId))`.
 */
export function mergeAnthropicCotProviderOptions(
  modelId: string,
  env: AnthropicCotEnv = process.env,
  agentThinkingBudgetTokens?: number,
): { providerOptions: CloudMergedProviderOptions } | Record<string, never> {
  return mergeProviderOptions(
    undefined,
    anthropicThinkingProviderOptions(modelId, env, agentThinkingBudgetTokens),
  );
}

const GOOGLE_IMAGE_MODALITIES: CloudJsonObject = {
  responseModalities: ["TEXT", "IMAGE"],
};

/**
 * Gemini (and similar) image generation: `google.responseModalities` plus optional COT merge.
 * For non-Anthropic `modelId`, the COT fragment is empty (no-op).
 */
export function mergeGoogleImageModalitiesWithAnthropicCot(
  modelId: string,
  env: AnthropicCotEnv = process.env,
  agentThinkingBudgetTokens?: number,
): { providerOptions: CloudMergedProviderOptions } | Record<string, never> {
  return mergeProviderOptions(
    { providerOptions: { google: GOOGLE_IMAGE_MODALITIES } },
    anthropicThinkingProviderOptions(modelId, env, agentThinkingBudgetTokens),
  );
}
