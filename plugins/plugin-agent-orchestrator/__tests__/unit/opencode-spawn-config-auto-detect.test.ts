import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/services/config-env.ts", () => ({
  readConfigEnvKey: vi.fn((_key: string) => undefined),
  readConfigCloudKey: vi.fn((_key: string) => undefined),
  readConfigCodexSubscriptionRestrictedToCodexFramework: vi.fn(() => false),
}));

import { buildOpencodeSpawnConfig } from "../../src/services/agent-credentials.ts";
import { readConfigEnvKey } from "../../src/services/config-env.ts";

/**
 * Auto-detect mode: when no PARALLAX_OPENCODE_* / PARALLAX_LLM_PROVIDER /
 * PARALLAX_OPENCODE_LOCAL is set, the spawn config should be derived from
 * the user's standard provider env var (CEREBRAS_API_KEY, OPENROUTER_API_KEY,
 * GROQ_API_KEY, TOGETHER_API_KEY, DEEPSEEK_API_KEY, OPENAI_API_KEY).
 *
 * The point is "BYO API key on any device with zero PARALLAX_* setup".
 * The user sets their normal provider key (the same one they'd use for
 * direct API access) and opencode just works.
 */
describe("buildOpencodeSpawnConfig auto-detect from provider env", () => {
  function buildRuntime(
    settings: Record<string, string | undefined>,
  ): IAgentRuntime {
    return {
      getSetting: vi.fn((key: string) =>
        key in settings ? (settings[key] ?? null) : null,
      ),
    } as unknown as IAgentRuntime;
  }

  beforeEach(() => {
    (readConfigEnvKey as ReturnType<typeof vi.fn>).mockImplementation(
      () => undefined,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when no provider env var is set", () => {
    const runtime = buildRuntime({});
    expect(buildOpencodeSpawnConfig(runtime)).toBeNull();
  });

  it("detects CEREBRAS_API_KEY and routes to api.cerebras.ai/v1", () => {
    const runtime = buildRuntime({ CEREBRAS_API_KEY: "csk-test-cerebras" });
    const result = buildOpencodeSpawnConfig(runtime);
    expect(result).not.toBeNull();
    expect(result?.providerLabel).toContain("Cerebras");
    expect(result?.providerLabel).toContain("CEREBRAS_API_KEY");
    const config = JSON.parse(result?.configContent ?? "{}");
    expect(config.provider.cerebras.options.baseURL).toBe(
      "https://api.cerebras.ai/v1",
    );
    expect(config.provider.cerebras.options.apiKey).toBe("csk-test-cerebras");
    expect(result?.model).toBe("cerebras/llama-3.3-70b");
  });

  it("detects OPENROUTER_API_KEY and routes to openrouter.ai", () => {
    const runtime = buildRuntime({ OPENROUTER_API_KEY: "sk-or-test" });
    const result = buildOpencodeSpawnConfig(runtime);
    expect(result?.providerLabel).toContain("OpenRouter");
    const config = JSON.parse(result?.configContent ?? "{}");
    expect(config.provider.openrouter.options.baseURL).toBe(
      "https://openrouter.ai/api/v1",
    );
    expect(result?.model).toBe("openrouter/meta-llama/llama-3.3-70b-instruct");
  });

  it("detects GROQ_API_KEY and routes to api.groq.com", () => {
    const runtime = buildRuntime({ GROQ_API_KEY: "gsk-test" });
    const result = buildOpencodeSpawnConfig(runtime);
    expect(result?.providerLabel).toContain("Groq");
    const config = JSON.parse(result?.configContent ?? "{}");
    expect(config.provider.groq.options.baseURL).toBe(
      "https://api.groq.com/openai/v1",
    );
  });

  it("detects TOGETHER_API_KEY and routes to api.together.xyz", () => {
    const runtime = buildRuntime({ TOGETHER_API_KEY: "tg-test" });
    const result = buildOpencodeSpawnConfig(runtime);
    const config = JSON.parse(result?.configContent ?? "{}");
    expect(config.provider.together.options.baseURL).toBe(
      "https://api.together.xyz/v1",
    );
  });

  it("detects DEEPSEEK_API_KEY and routes to api.deepseek.com", () => {
    const runtime = buildRuntime({ DEEPSEEK_API_KEY: "ds-test" });
    const result = buildOpencodeSpawnConfig(runtime);
    const config = JSON.parse(result?.configContent ?? "{}");
    expect(config.provider.deepseek.options.baseURL).toBe(
      "https://api.deepseek.com/v1",
    );
  });

  it("falls back to openai.com direct when only OPENAI_API_KEY is set", () => {
    const runtime = buildRuntime({ OPENAI_API_KEY: "sk-openai-test" });
    const result = buildOpencodeSpawnConfig(runtime);
    expect(result?.providerLabel).toContain("OpenAI");
    const config = JSON.parse(result?.configContent ?? "{}");
    expect(config.provider.openai.options.baseURL).toBe(
      "https://api.openai.com/v1",
    );
    expect(result?.model).toBe("openai/gpt-4o-mini");
  });

  it("treats OPENAI_API_KEY+custom OPENAI_BASE_URL as third-party OpenAI-compatible", () => {
    const runtime = buildRuntime({
      OPENAI_API_KEY: "csk-actually-cerebras",
      OPENAI_BASE_URL: "https://api.cerebras.ai/v1",
    });
    const result = buildOpencodeSpawnConfig(runtime);
    // Third-party gets a synthesized providerId
    expect(result?.providerId).toBe("openai-compatible");
    expect(result?.providerLabel).toContain("api.cerebras.ai");
    const config = JSON.parse(result?.configContent ?? "{}");
    expect(config.provider["openai-compatible"].options.baseURL).toBe(
      "https://api.cerebras.ai/v1",
    );
  });

  it("uses OPENAI_LARGE_MODEL as the default model when OPENAI_API_KEY auto-detects", () => {
    const runtime = buildRuntime({
      OPENAI_API_KEY: "sk-test",
      OPENAI_LARGE_MODEL: "gpt-oss-120b",
      OPENAI_BASE_URL: "https://api.cerebras.ai/v1",
    });
    const result = buildOpencodeSpawnConfig(runtime);
    expect(result?.model).toBe("openai-compatible/gpt-oss-120b");
  });

  it("prefers OPENROUTER over CEREBRAS when both are set (priority ordering)", () => {
    const runtime = buildRuntime({
      OPENROUTER_API_KEY: "sk-or-test",
      CEREBRAS_API_KEY: "csk-test",
    });
    const result = buildOpencodeSpawnConfig(runtime);
    expect(result?.providerId).toBe("openrouter");
  });

  it("auto-detect is skipped when PARALLAX_OPENCODE_BASE_URL is set (Mode 2 wins)", () => {
    (readConfigEnvKey as ReturnType<typeof vi.fn>).mockImplementation(
      (key: string) =>
        key === "PARALLAX_OPENCODE_BASE_URL"
          ? "http://localhost:1234/v1"
          : undefined,
    );
    const runtime = buildRuntime({ CEREBRAS_API_KEY: "csk-should-not-win" });
    const result = buildOpencodeSpawnConfig(runtime);
    // Mode 2 (local/custom) wins — providerId is the local sentinel.
    expect(result?.providerId).toBe("eliza-local");
    const config = JSON.parse(result?.configContent ?? "{}");
    expect(config.provider["eliza-local"].options.baseURL).toBe(
      "http://localhost:1234/v1",
    );
  });

  it("PARALLAX_OPENCODE_MODEL_POWERFUL overrides the provider's default model", () => {
    const runtime = buildRuntime({
      CEREBRAS_API_KEY: "csk-test",
      PARALLAX_OPENCODE_MODEL_POWERFUL: "gpt-oss-120b",
    });
    const result = buildOpencodeSpawnConfig(runtime);
    // Mode 3 (user-config alone) wins because PARALLAX_OPENCODE_MODEL_POWERFUL is set.
    // But the auto-detect path still applies when only the key is set with no powerful model override.
    // This test pins: explicit model wins over auto-default.
    expect(result?.model).toBe("gpt-oss-120b");
  });
});
