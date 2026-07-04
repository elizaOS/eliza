// Exercises runtime agent secrets behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import { mergeRuntimeAgentSecretsFromEnv } from "./runtime-agent-secrets";

describe("runtime agent secret merge", () => {
  test("legacy mode copies OPENAI_API_KEY from env into settings secrets", () => {
    const secrets = mergeRuntimeAgentSecretsFromEnv({
      rawSecrets: {},
      environmentVars: {
        OPENAI_API_KEY: "sk-real-test",
        OPENAI_BASE_URL: "https://api.openai.com/v1",
      },
      controlEnv: {},
    });

    expect(secrets.OPENAI_API_KEY).toBe("sk-real-test");
    expect(secrets.OPENAI_BASE_URL).toBe("https://api.openai.com/v1");
  });

  test("keyless OpenAI fallback disabled removes raw key while keeping base URL config", () => {
    const secrets = mergeRuntimeAgentSecretsFromEnv({
      rawSecrets: {
        OPENAI_API_KEY: "sk-real-test-from-character",
        ANTHROPIC_API_KEY: "anthropic-secret",
      },
      environmentVars: {
        OPENAI_API_KEY: "sk-real-test",
        OPENAI_BASE_URL: "https://steward.example/capabilities/openai.chat.completions/openai/v1",
      },
      controlEnv: {
        STEWARD_KEYLESS_HOSTED_AGENTS: "true",
        STEWARD_KEYLESS_OPENAI: "true",
      },
    });

    expect(secrets.OPENAI_API_KEY).toBeUndefined();
    expect(JSON.stringify(secrets)).not.toContain("sk-real-test");
    expect(secrets.OPENAI_BASE_URL).toBe(
      "https://steward.example/capabilities/openai.chat.completions/openai/v1",
    );
    expect(secrets.ANTHROPIC_API_KEY).toBe("anthropic-secret");
  });

  test("keyless OpenAI fallback true preserves legacy raw key", () => {
    const secrets = mergeRuntimeAgentSecretsFromEnv({
      rawSecrets: {},
      environmentVars: { OPENAI_API_KEY: "sk-real-test" },
      controlEnv: {
        STEWARD_KEYLESS_HOSTED_AGENTS: "true",
        STEWARD_KEYLESS_OPENAI: "true",
        STEWARD_KEYLESS_FALLBACK_RAW_ENV: "true",
      },
    });

    expect(secrets.OPENAI_API_KEY).toBe("sk-real-test");
  });
});
