type ModelProvider = "anthropic" | "openai";

/**
 * Make eliza-code a drop-in replacement for the `opencode` coding sub-agent:
 * when explicit `OPENAI_*` aren't set, inherit the coding-agent provider config
 * the elizaOS orchestrator already uses for opencode (`ELIZA_OPENCODE_*`, which
 * points at Cerebras or any OpenAI-compatible endpoint). The orchestrator
 * forwards the parent env to the spawned ACP process, so a host already
 * configured for opencode runs eliza-code with no extra model config.
 *
 * Mutates `env` in place; only fills values that are unset, so an explicit
 * `OPENAI_*` / `ELIZA_CODE_PROVIDER` always wins.
 */
export function applyOpencodeProviderEnv(
  env: Record<string, string | undefined> = process.env,
): void {
  const has = (v: string | undefined): v is string =>
    typeof v === "string" && v.trim().length > 0;
  if (!has(env.OPENAI_API_KEY) && has(env.ELIZA_OPENCODE_API_KEY)) {
    env.OPENAI_API_KEY = env.ELIZA_OPENCODE_API_KEY;
    if (!has(env.ELIZA_CODE_PROVIDER)) env.ELIZA_CODE_PROVIDER = "openai";
  }
  if (!has(env.OPENAI_BASE_URL) && has(env.ELIZA_OPENCODE_BASE_URL))
    env.OPENAI_BASE_URL = env.ELIZA_OPENCODE_BASE_URL;
  if (!has(env.OPENAI_LARGE_MODEL) && has(env.ELIZA_OPENCODE_MODEL_POWERFUL))
    env.OPENAI_LARGE_MODEL = env.ELIZA_OPENCODE_MODEL_POWERFUL;
  if (!has(env.OPENAI_SMALL_MODEL) && has(env.ELIZA_OPENCODE_MODEL_FAST))
    env.OPENAI_SMALL_MODEL = env.ELIZA_OPENCODE_MODEL_FAST;
  if (!has(env.OPENAI_MEDIUM_MODEL) && has(env.ELIZA_OPENCODE_MODEL_FAST))
    env.OPENAI_MEDIUM_MODEL = env.ELIZA_OPENCODE_MODEL_FAST;
}

export function resolveModelProvider(
  env: Record<string, string | undefined>,
): ModelProvider {
  const explicitRaw =
    env.ELIZA_CODE_PROVIDER ?? env.ELIZA_CODE_MODEL_PROVIDER ?? "";
  const explicit = explicitRaw.trim().toLowerCase();

  if (explicit === "anthropic" || explicit === "claude") return "anthropic";
  if (explicit === "openai" || explicit === "codex") return "openai";

  // Auto-detect based on available keys (incl. the opencode-compatible key).
  if (env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim().length > 0)
    return "openai";
  if (
    env.ELIZA_OPENCODE_API_KEY &&
    env.ELIZA_OPENCODE_API_KEY.trim().length > 0
  )
    return "openai";
  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim().length > 0)
    return "anthropic";

  throw new Error(
    "No model provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY (or ELIZA_CODE_PROVIDER=anthropic|openai).",
  );
}
