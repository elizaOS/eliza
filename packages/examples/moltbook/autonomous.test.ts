import { afterEach, describe, expect, test } from "bun:test";
import { type Config, getConfig, validateConfig } from "./autonomous";

const ENV_KEYS = [
  "MOLTBOOK_AGENT_NAME",
  "LLM_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "LLM_BASE_URL",
  "MODEL",
  "MOLTBOOK_TOKEN",
  "MOLTBOOK_AUTONOMY_INTERVAL_MS",
  "MOLTBOOK_AUTONOMY_MAX_STEPS",
] as const;

const originalEnv = new Map(
  ENV_KEYS.map((key) => [key, process.env[key]] as const),
);

function clearConfigEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("Moltbook autonomous config", () => {
  test("uses deterministic defaults and OpenRouter fallback", () => {
    clearConfigEnv();
    process.env.OPENROUTER_API_KEY = "openrouter-key";
    process.env.MOLTBOOK_AUTONOMY_INTERVAL_MS = "15000";
    process.env.MOLTBOOK_AUTONOMY_MAX_STEPS = "3";

    const config = getConfig();

    expect(config.agentName).toBe("PROPHET_ELIZA_7");
    expect(config.llmApiKey).toBe("openrouter-key");
    expect(config.llmBaseUrl).toBe("https://openrouter.ai/api/v1");
    expect(config.model).toBe("anthropic/claude-sonnet-4.6");
    expect(config.autonomyIntervalMs).toBe(15000);
    expect(config.autonomyMaxSteps).toBe(3);
  });

  test("requires an LLM key and treats Moltbook token as optional", () => {
    const baseConfig: Config = {
      agentName: "PROPHET_ELIZA_7",
      personality: "test",
      llmBaseUrl: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-sonnet-4.6",
      autonomyIntervalMs: 45000,
      autonomyMaxSteps: 0,
    };

    expect(validateConfig(baseConfig)).toEqual({
      valid: false,
      errors: [
        "LLM_API_KEY (or OPENROUTER_API_KEY / OPENAI_API_KEY) is required for autonomous mode",
      ],
      warnings: [
        "MOLTBOOK_TOKEN not set - posting and commenting will be disabled",
      ],
    });

    expect(
      validateConfig({
        ...baseConfig,
        llmApiKey: "llm-key",
      }),
    ).toEqual({
      valid: true,
      errors: [],
      warnings: [
        "MOLTBOOK_TOKEN not set - posting and commenting will be disabled",
      ],
    });

    expect(
      validateConfig({
        ...baseConfig,
        llmApiKey: "llm-key",
        moltbookToken: "moltbook-token",
      }),
    ).toEqual({ valid: true, errors: [], warnings: [] });
  });
});
