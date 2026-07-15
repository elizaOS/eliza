/**
 * Provider model-env defaults seeded synchronously by runtime boot before
 * provider selection and plugin initialization. Lives apart from the boot
 * monolith so the seeding rules are unit-testable and have one owner.
 *
 * Seeding order matters: every default here is set-if-missing, so explicit
 * operator config (env or character settings folded into env) always wins.
 */
import { DEFAULT_CEREBRAS_TEXT_MODEL } from "@elizaos/shared";

/** Set an env default without clobbering an operator-provided value. */
export function setEnvIfMissing(key: string, value: string | undefined): void {
  if (!value || process.env[key]) return;
  process.env[key] = value;
}

/**
 * True for model ids that identify OpenAI-only text families. Open-weight GPT
 * OSS ids are deliberately excluded because Groq, Cerebras, and other
 * OpenAI-compatible providers serve them too.
 */
export function isLikelyOpenAiTextModel(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;

  const unqualified = normalized.startsWith("openai/")
    ? normalized.slice("openai/".length)
    : normalized;
  if (unqualified.startsWith("gpt-oss-")) return false;

  const model = unqualified.startsWith("ft:")
    ? unqualified.slice("ft:".length)
    : unqualified;
  return (
    model.startsWith("gpt-") ||
    model.startsWith("chatgpt-") ||
    model.startsWith("codex-") ||
    /^o[134](?:-|$)/.test(model)
  );
}

export function applyProviderModelEnvDefaults(): void {
  // Normalize Google AI API key aliases — the elizaOS plugin and @google/genai
  // SDK expect different env var names. Canonicalize to the long form that
  // @elizaos/plugin-google-genai reads via runtime.getSetting(). Users can set
  // any of: GEMINI_API_KEY, GOOGLE_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY.
  setEnvIfMissing(
    "GOOGLE_GENERATIVE_AI_API_KEY",
    process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
  );

  // Default Google model names — the Google GenAI plugin's getSetting() returns
  // null (not undefined) for missing keys, but the plugin checks !== undefined
  // causing String(null) = "null" to be sent as the model name. Set sensible
  // defaults so the plugin always has valid model names.
  setEnvIfMissing("GOOGLE_SMALL_MODEL", "gemini-3-flash-preview");
  setEnvIfMissing("GOOGLE_LARGE_MODEL", "gemini-3.1-pro-preview");

  // Default Groq model names — plugin-groq still ships a deprecated large-model
  // fallback. Seed runtime defaults before plugin init so direct Groq provider
  // sessions use the approved GPT-OSS default.
  const currentSharedSmallModel =
    process.env.OPENAI_SMALL_MODEL ?? process.env.SMALL_MODEL;
  const currentSharedLargeModel =
    process.env.OPENAI_LARGE_MODEL ?? process.env.LARGE_MODEL;
  setEnvIfMissing(
    "GROQ_SMALL_MODEL",
    currentSharedSmallModel && !isLikelyOpenAiTextModel(currentSharedSmallModel)
      ? currentSharedSmallModel
      : "openai/gpt-oss-120b",
  );
  setEnvIfMissing(
    "GROQ_LARGE_MODEL",
    currentSharedLargeModel && !isLikelyOpenAiTextModel(currentSharedLargeModel)
      ? currentSharedLargeModel
      : "openai/gpt-oss-120b",
  );

  // Default Cerebras model — plugin-openai's Cerebras mode otherwise falls
  // back to OpenAI-only ids when CEREBRAS_MODEL is unset. CEREBRAS_MODEL is
  // the FALLBACK for every tier whose explicit OPENAI_*_MODEL var is unset
  // (response-handler, planner, nano, medium), so it must seed from the
  // shared SMALL model: seeding it from the large model silently promoted
  // all of those tiers to the large (reasoning) model — nano/medium triage
  // calls burned zai-glm-4.7 reasoning budgets, and Stage-1 latency spiked
  // 1.2s→10s+ on its thinking bursts. Tiers that want the large model keep
  // it explicitly via OPENAI_LARGE_MODEL / LARGE_MODEL.
  setEnvIfMissing(
    "CEREBRAS_MODEL",
    currentSharedSmallModel && !isLikelyOpenAiTextModel(currentSharedSmallModel)
      ? currentSharedSmallModel
      : DEFAULT_CEREBRAS_TEXT_MODEL,
  );
}
