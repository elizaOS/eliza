const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

function isTruthyEnv(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value !== undefined && TRUTHY_ENV_VALUES.has(value);
}

export type LiveLlmTestConfig = {
  requested: boolean;
  enabled: boolean;
  skipReason: string | null;
};

export function resolveLiveLlmTestConfig(): LiveLlmTestConfig {
  const requested = isTruthyEnv("RUN_LIVE_LLM_TESTS");
  const hasCredential =
    (process.env.GROQ_API_KEY?.trim() ?? "") !== "" ||
    (process.env.ANTHROPIC_API_KEY?.trim() ?? "") !== "" ||
    (process.env.OPENAI_API_KEY?.trim() ?? "") !== "";

  if (!requested) {
    return {
      requested,
      enabled: false,
      skipReason: "RUN_LIVE_LLM_TESTS is not enabled",
    };
  }

  if (!hasCredential) {
    return {
      requested,
      enabled: false,
      skipReason:
        "RUN_LIVE_LLM_TESTS is enabled but no GROQ_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY is configured",
    };
  }

  return {
    requested,
    enabled: true,
    skipReason: null,
  };
}
