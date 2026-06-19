import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("selectLiveProvider", () => {
  beforeEach(() => {
    for (const key of [
      "CEREBRAS_API_KEY",
      "ELIZA_E2E_CEREBRAS_API_KEY",
      "GROQ_API_KEY",
      "ELIZA_E2E_GROQ_API_KEY",
      "OPENAI_API_KEY",
      "ELIZA_E2E_OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "ANTHROPIC_API_KEY",
      "ELIZA_E2E_ANTHROPIC_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "ELIZA_E2E_GOOGLE_GENERATIVE_AI_API_KEY",
      "OPENROUTER_API_KEY",
      "ELIZA_E2E_OPENROUTER_API_KEY",
      "ELIZA_PROVIDER",
    ]) {
      vi.stubEnv(key, "");
    }
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("rejects groq-shaped keys for openai provider selection", async () => {
    vi.stubEnv("OPENAI_API_KEY", "gsk_test_invalid_for_openai");
    vi.stubEnv("ELIZA_E2E_OPENAI_API_KEY", "");

    const { selectLiveProvider } = await import("./live-provider.ts");

    expect(selectLiveProvider("openai")).toBeNull();
  });

  it("does not treat Eliza Cloud keys as direct OpenAI provider credentials", async () => {
    vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "cloud_test_key");
    vi.stubEnv("ELIZA_CLOUD_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ELIZA_E2E_OPENAI_API_KEY", "");

    const { availableProviderNames, selectLiveProvider } = await import(
      "./live-provider.ts"
    );

    expect(selectLiveProvider("openai")).toBeNull();
    expect(availableProviderNames()).not.toContain("openai");
  });

  it("still selects groq when both env vars exist but openai is misconfigured", async () => {
    vi.stubEnv("OPENAI_API_KEY", "gsk_test_invalid_for_openai");
    vi.stubEnv("ELIZA_E2E_OPENAI_API_KEY", "");
    vi.stubEnv("GROQ_API_KEY", "gsk_test_valid_for_groq");

    const { selectLiveProvider } = await import("./live-provider.ts");

    expect(selectLiveProvider()?.name).toBe("groq");
  });

  it("accepts ELIZA_E2E_GROQ_API_KEY alias and propagates it under GROQ_API_KEY", async () => {
    // CI-only scoped alias: scenario-matrix.yml sets ELIZA_E2E_GROQ_API_KEY
    // but the runtime plugin reads GROQ_API_KEY.
    vi.stubEnv("GROQ_API_KEY", "");
    vi.stubEnv("ELIZA_E2E_GROQ_API_KEY", "gsk_test_valid_for_groq");

    const { selectLiveProvider, availableProviderNames } = await import(
      "./live-provider.ts"
    );

    const provider = selectLiveProvider();
    expect(provider?.name).toBe("groq");
    expect(provider?.apiKey).toBe("gsk_test_valid_for_groq");
    expect(provider?.env.GROQ_API_KEY).toBe("gsk_test_valid_for_groq");
    expect(availableProviderNames()).toContain("groq");
  });

  it("prefers canonical GROQ_API_KEY over alias when both are set", async () => {
    vi.stubEnv("GROQ_API_KEY", "gsk_canonical");
    vi.stubEnv("ELIZA_E2E_GROQ_API_KEY", "gsk_alias");

    const { selectLiveProvider } = await import("./live-provider.ts");

    expect(selectLiveProvider()?.apiKey).toBe("gsk_canonical");
  });

  it("selects cerebras when explicitly selected with ELIZA_PROVIDER", async () => {
    vi.stubEnv("CEREBRAS_API_KEY", "csk_test_cerebras_key");
    vi.stubEnv("GROQ_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ELIZA_PROVIDER", "cerebras");

    const { selectLiveProvider } = await import("./live-provider.ts");

    const provider = selectLiveProvider();
    expect(provider?.name).toBe("cerebras");
    expect(provider?.baseUrl).toBe("https://api.cerebras.ai/v1");
    expect(provider?.largeModel).toBe("gpt-oss-120b");
    expect(provider?.smallModel).toBe("gpt-oss-120b");
    expect(provider?.env.ELIZA_PROVIDER).toBe("cerebras");
  });

  it("prefers groq over a bare cerebras eval key unless cerebras is explicitly selected", async () => {
    vi.stubEnv("CEREBRAS_API_KEY", "csk_test_cerebras_key");
    vi.stubEnv("GROQ_API_KEY", "gsk_test_groq_key");

    const { selectLiveProvider } = await import("./live-provider.ts");

    expect(selectLiveProvider()?.name).toBe("groq");
  });

  it("rejects csk-prefixed keys for openai provider selection", async () => {
    vi.stubEnv("OPENAI_API_KEY", "csk_test_cerebras_key_in_wrong_slot");
    vi.stubEnv("ELIZA_E2E_OPENAI_API_KEY", "");
    vi.stubEnv("CEREBRAS_API_KEY", "");

    const { selectLiveProvider } = await import("./live-provider.ts");

    expect(selectLiveProvider("openai")).toBeNull();
  });
});
