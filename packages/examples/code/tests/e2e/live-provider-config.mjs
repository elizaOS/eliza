/** Resolves and applies the secret-safe provider configuration for live QA. */

export function resolveLiveProviderConfig(env = process.env) {
  const cerebrasKey =
    env.ELIZA_LIVE_QA_CEREBRAS_KEY?.trim() || env.CEREBRAS_API_KEY?.trim();
  if (cerebrasKey) {
    return {
      apiKey: cerebrasKey,
      provider: "Cerebras via @elizaos/plugin-openai",
      model: env.ELIZA_LIVE_QA_MODEL?.trim() || "gemma-4-31b",
      kind: "cerebras",
    };
  }
  throw new Error(
    "CEREBRAS_API_KEY (or ELIZA_LIVE_QA_CEREBRAS_KEY) is required for this acceptance harness.",
  );
}

export function applyLiveProviderConfig(config, env = process.env) {
  // A stale OpenRouter/OpenAI launch config must not override direct Cerebras.
  for (const key of [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_SMALL_MODEL",
    "OPENAI_MEDIUM_MODEL",
    "OPENAI_LARGE_MODEL",
    "OPENAI_RESPONSE_HANDLER_MODEL",
    "OPENAI_ACTION_PLANNER_MODEL",
    "ELIZA_OPENCODE_API_KEY",
    "ELIZA_OPENCODE_BASE_URL",
    "ELIZA_OPENCODE_MODEL_FAST",
    "ELIZA_OPENCODE_MODEL_POWERFUL",
  ]) {
    delete env[key];
  }
  Object.assign(env, {
    ELIZA_CODE_PROVIDER: "cerebras",
    ELIZA_PROVIDER: "cerebras",
    CEREBRAS_API_KEY: config.apiKey,
    CEREBRAS_BASE_URL: "https://api.cerebras.ai/v1",
    CEREBRAS_MODEL: config.model,
    CEREBRAS_SMALL_MODEL: config.model,
    CEREBRAS_LARGE_MODEL: config.model,
    // Cerebras text mode supplies the plugin's deterministic local embedding
    // fallback. Do not start/probe the unrelated desktop GGUF provider in a
    // headless coding-agent QA process.
    EMBEDDING_PROVIDER: "openai",
    ELIZA_DISABLE_LOCAL_EMBEDDINGS: "1",
  });
}
