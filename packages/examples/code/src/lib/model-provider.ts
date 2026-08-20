// Provides shared support logic for the Code example.
export type ModelProvider = "anthropic" | "cerebras" | "openai";

const DEFAULT_CEREBRAS_MODEL = "gemma-4-31b";

function hasValue(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Make direct Cerebras configuration first-class for eliza-code. The OpenAI
 * plugin owns the transport and already supports Cerebras natively, so this
 * selects that mode without copying the Cerebras credential into OPENAI_*.
 */
export function applyCerebrasProviderEnv(
  env: Record<string, string | undefined> = process.env,
): void {
  if (!hasValue(env.CEREBRAS_API_KEY)) return;
  const explicitCodeProvider = (
    env.ELIZA_CODE_PROVIDER ??
    env.ELIZA_CODE_MODEL_PROVIDER ??
    ""
  )
    .trim()
    .toLowerCase();
  if (explicitCodeProvider && explicitCodeProvider !== "cerebras") return;
  if (!explicitCodeProvider) env.ELIZA_CODE_PROVIDER = "cerebras";
  // The code-provider choice is authoritative here. Replacing a stale
  // OpenAI/OpenRouter transport hint prevents a mixed-provider process while
  // still preserving an explicit non-Cerebras ELIZA_CODE_PROVIDER above.
  env.ELIZA_PROVIDER = "cerebras";
  if (!hasValue(env.CEREBRAS_MODEL)) {
    env.CEREBRAS_MODEL = DEFAULT_CEREBRAS_MODEL;
  }
}

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
  const explicitCodeProvider = (
    env.ELIZA_CODE_PROVIDER ??
    env.ELIZA_CODE_MODEL_PROVIDER ??
    ""
  )
    .trim()
    .toLowerCase();
  if (explicitCodeProvider === "cerebras") return;
  if (!hasValue(env.OPENAI_API_KEY) && hasValue(env.ELIZA_OPENCODE_API_KEY)) {
    env.OPENAI_API_KEY = env.ELIZA_OPENCODE_API_KEY;
    if (!hasValue(env.ELIZA_CODE_PROVIDER)) env.ELIZA_CODE_PROVIDER = "openai";
  }
  if (!hasValue(env.OPENAI_BASE_URL) && hasValue(env.ELIZA_OPENCODE_BASE_URL))
    env.OPENAI_BASE_URL = env.ELIZA_OPENCODE_BASE_URL;
  if (
    !hasValue(env.OPENAI_LARGE_MODEL) &&
    hasValue(env.ELIZA_OPENCODE_MODEL_POWERFUL)
  )
    env.OPENAI_LARGE_MODEL = env.ELIZA_OPENCODE_MODEL_POWERFUL;
  if (
    !hasValue(env.OPENAI_SMALL_MODEL) &&
    hasValue(env.ELIZA_OPENCODE_MODEL_FAST)
  )
    env.OPENAI_SMALL_MODEL = env.ELIZA_OPENCODE_MODEL_FAST;
  if (
    !hasValue(env.OPENAI_MEDIUM_MODEL) &&
    hasValue(env.ELIZA_OPENCODE_MODEL_FAST)
  )
    env.OPENAI_MEDIUM_MODEL = env.ELIZA_OPENCODE_MODEL_FAST;
}

export function hasModelProviderCredential(
  provider: ModelProvider,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return provider === "anthropic"
    ? hasValue(env.ANTHROPIC_API_KEY)
    : provider === "cerebras"
      ? hasValue(env.CEREBRAS_API_KEY)
      : hasValue(env.OPENAI_API_KEY);
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
      : provider === "cerebras"
        ? (env.CEREBRAS_LARGE_MODEL ??
          env.CEREBRAS_MODEL ??
          env.CEREBRAS_SMALL_MODEL ??
          DEFAULT_CEREBRAS_MODEL)
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
  if (explicit === "cerebras") return "cerebras";
  if (explicit === "openai" || explicit === "codex") return "openai";

  // Auto-detect based on available keys (incl. the opencode-compatible key).
  if (hasValue(env.CEREBRAS_API_KEY)) return "cerebras";
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
    "No model provider configured. Set CEREBRAS_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY (or ELIZA_CODE_PROVIDER=cerebras|anthropic|openai).",
  );
}
