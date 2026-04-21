import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const NO_CLOUD_CONFIG_PATH = path.join(
  os.tmpdir(),
  "eliza-live-provider-test-no-cloud.json",
);

describe("selectLiveProvider", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("rejects groq-shaped keys for openai provider selection", async () => {
    vi.stubEnv("ELIZA_CONFIG_PATH", NO_CLOUD_CONFIG_PATH);
    vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "");
    vi.stubEnv("ELIZA_CLOUD_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "gsk_test_invalid_for_openai");

    const { selectLiveProvider } = await import("./live-provider.ts");

    expect(selectLiveProvider("openai")).toBeNull();
  });

  it("uses Eliza Cloud OpenAI pass-through when openai is requested without a direct key", async () => {
    vi.stubEnv("ELIZA_CONFIG_PATH", NO_CLOUD_CONFIG_PATH);
    vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "cloud_test_key");
    vi.stubEnv("ELIZA_CLOUD_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ELIZA_E2E_OPENAI_API_KEY", "");

    const { selectLiveProvider } = await import("./live-provider.ts");

    const provider = selectLiveProvider("openai");
    expect(provider?.name).toBe("openai");
    expect(provider?.apiKey).toBe("cloud_test_key");
    expect(provider?.baseUrl).toBe("https://elizacloud.ai/api/v1");
    expect(provider?.env.OPENAI_API_KEY).toBe("cloud_test_key");
    expect(provider?.env.OPENAI_BASE_URL).toBe(
      "https://elizacloud.ai/api/v1",
    );
  });

  it("still selects groq when both env vars exist but openai is misconfigured", async () => {
    vi.stubEnv("ELIZA_CONFIG_PATH", NO_CLOUD_CONFIG_PATH);
    vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "");
    vi.stubEnv("ELIZA_CLOUD_API_KEY", "");
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
