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
});
