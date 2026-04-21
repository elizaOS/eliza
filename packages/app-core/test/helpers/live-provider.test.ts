import { afterEach, describe, expect, it, vi } from "vitest";

describe("selectLiveProvider", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("rejects groq-shaped keys for openai provider selection", async () => {
    vi.stubEnv("OPENAI_API_KEY", "gsk_test_invalid_for_openai");

    const { selectLiveProvider } = await import("./live-provider.ts");

    expect(selectLiveProvider("openai")).toBeNull();
  });

  it("still selects groq when both env vars exist but openai is misconfigured", async () => {
    vi.stubEnv("OPENAI_API_KEY", "gsk_test_invalid_for_openai");
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
});
