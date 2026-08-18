// Provides shared support logic for the Code example.
type ModelProvider = "anthropic" | "openai";

/**
 * Materialize Eliza Code's provider contract onto the provider-plugin env.
 * Explicit `OPENAI_*` values win; otherwise the native Eliza Code settings or
 * an authorized Cerebras configuration supply the compatible endpoint/model.
 */
export function applyElizaCodeProviderEnv(
  env: Record<string, string | undefined> = process.env,
): void {
  const has = (v: string | undefined): v is string =>
    typeof v === "string" && v.trim().length > 0;
  const hadExplicitOpenAiKey = has(env.OPENAI_API_KEY);
  const apiKey = has(env.ELIZA_CODE_API_KEY)
    ? env.ELIZA_CODE_API_KEY
    : env.CEREBRAS_API_KEY;
  if (!has(env.OPENAI_API_KEY) && has(apiKey)) {
    env.OPENAI_API_KEY = apiKey;
    if (!has(env.ELIZA_CODE_PROVIDER)) env.ELIZA_CODE_PROVIDER = "openai";
  }
  const baseUrl = has(env.ELIZA_CODE_BASE_URL)
    ? env.ELIZA_CODE_BASE_URL
    : has(env.CEREBRAS_BASE_URL)
      ? env.CEREBRAS_BASE_URL
      : has(env.CEREBRAS_API_KEY)
        ? "https://api.cerebras.ai/v1"
        : undefined;
  if (!has(env.OPENAI_BASE_URL) && has(baseUrl)) env.OPENAI_BASE_URL = baseUrl;
  const powerful = has(env.ELIZA_CODE_MODEL_POWERFUL)
    ? env.ELIZA_CODE_MODEL_POWERFUL
    : has(env.ELIZA_ELIZAOS_MODEL_POWERFUL)
      ? env.ELIZA_ELIZAOS_MODEL_POWERFUL
      : has(env.CEREBRAS_LARGE_MODEL)
        ? env.CEREBRAS_LARGE_MODEL
        : env.CEREBRAS_MODEL;
  const fast = has(env.ELIZA_CODE_MODEL_FAST)
    ? env.ELIZA_CODE_MODEL_FAST
    : has(env.ELIZA_ELIZAOS_MODEL_FAST)
      ? env.ELIZA_ELIZAOS_MODEL_FAST
      : env.CEREBRAS_SMALL_MODEL;
  if (!has(env.OPENAI_LARGE_MODEL) && has(powerful))
    env.OPENAI_LARGE_MODEL = powerful;
  if (!has(env.OPENAI_SMALL_MODEL) && has(fast)) env.OPENAI_SMALL_MODEL = fast;
  if (!has(env.OPENAI_MEDIUM_MODEL) && has(fast))
    env.OPENAI_MEDIUM_MODEL = fast;

  const effectiveBaseUrl = env.OPENAI_BASE_URL;
  const usesCerebrasEndpoint = (() => {
    if (has(effectiveBaseUrl)) {
      try {
        return (
          new URL(effectiveBaseUrl).hostname.toLowerCase() === "api.cerebras.ai"
        );
      } catch {
        return false;
      }
    }
    return (
      !hadExplicitOpenAiKey &&
      !has(env.ELIZA_CODE_API_KEY) &&
      has(env.CEREBRAS_API_KEY)
    );
  })();
  if (usesCerebrasEndpoint) {
    for (const key of [
      "OPENAI_LARGE_MODEL",
      "OPENAI_MEDIUM_MODEL",
      "OPENAI_SMALL_MODEL",
    ] as const) {
      const value = env[key]?.trim();
      if (value) env[key] = value.replace(/^(?:cerebras|openai)\//i, "");
    }
  }
}

/**
 * A short human label for the active coding model, for the status bar — the
 * model name if one is configured (what the user cares about: "which model am I
 * talking to"), else the bare provider. Returns null when no provider is
 * resolvable (unconfigured) so the caller can omit it rather than crash — the
 * status bar renders on every frame and must never throw.
 */
export function describeActiveModel(
  env: Record<string, string | undefined> = process.env,
): string | null {
  let provider: ModelProvider;
  try {
    provider = resolveModelProvider(env);
  } catch {
    return null;
  }
  // Only the env vars the provider plugins actually honor — showing a model
  // from a var the agent ignores (OPENAI_MODEL / ANTHROPIC_MODEL) would lie.
  const model =
    provider === "openai"
      ? (env.OPENAI_LARGE_MODEL ?? env.OPENAI_SMALL_MODEL)
      : (env.ANTHROPIC_LARGE_MODEL ?? env.ANTHROPIC_SMALL_MODEL);
  const trimmed = model?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : provider;
}

export function resolveModelProvider(
  env: Record<string, string | undefined>,
): ModelProvider {
  const explicitRaw =
    env.ELIZA_CODE_PROVIDER ?? env.ELIZA_CODE_MODEL_PROVIDER ?? "";
  const explicit = explicitRaw.trim().toLowerCase();

  if (explicit === "anthropic" || explicit === "claude") return "anthropic";
  if (explicit === "openai" || explicit === "codex") return "openai";

  // Auto-detect based on available native/provider keys.
  if (env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim().length > 0)
    return "openai";
  if (env.ELIZA_CODE_API_KEY && env.ELIZA_CODE_API_KEY.trim().length > 0)
    return "openai";
  if (env.CEREBRAS_API_KEY && env.CEREBRAS_API_KEY.trim().length > 0)
    return "openai";
  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim().length > 0)
    return "anthropic";

  throw new Error(
    "No model provider configured. Set ELIZA_CODE_API_KEY, CEREBRAS_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY (or ELIZA_CODE_PROVIDER=anthropic|openai).",
  );
}
