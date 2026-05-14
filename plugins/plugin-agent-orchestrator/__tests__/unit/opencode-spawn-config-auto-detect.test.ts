import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { buildOpencodeSpawnConfig } from "../../src/services/opencode-config.js";

function runtime(settings: Record<string, string | undefined> = {}) {
  return {
    getSetting: vi.fn((key: string) => settings[key]),
  } as unknown as IAgentRuntime;
}

describe("buildOpencodeSpawnConfig", () => {
  it("returns null when no provider or opencode model is configured", () => {
    expect(buildOpencodeSpawnConfig(runtime(), {})).toBeNull();
  });

  it("detects CEREBRAS_API_KEY and uses the Cerebras provider defaults", () => {
    const result = buildOpencodeSpawnConfig(runtime(), {
      CEREBRAS_API_KEY: "csk-test",
    });
    expect(result?.providerId).toBe("cerebras");
    expect(result?.providerLabel).toBe("Cerebras");
    expect(result?.model).toBe("cerebras/gpt-oss-120b");
    const config = JSON.parse(result?.configContent ?? "{}");
    expect(config.provider.cerebras.options.baseURL).toBe(
      "https://api.cerebras.ai/v1",
    );
    expect(config.provider.cerebras.options.apiKey).toBe("csk-test");
  });

  it("uses ELIZA_OPENCODE_MODEL_POWERFUL with a Cerebras base URL", () => {
    const result = buildOpencodeSpawnConfig(runtime(), {
      ELIZA_OPENCODE_BASE_URL: "https://api.cerebras.ai/v1",
      ELIZA_OPENCODE_API_KEY: "csk-test",
      ELIZA_OPENCODE_MODEL_POWERFUL: "gpt-oss-120b",
    });
    expect(result?.providerId).toBe("cerebras");
    expect(result?.model).toBe("cerebras/gpt-oss-120b");
  });

  it("does not pass unresolved vault pointers as provider API keys", () => {
    const result = buildOpencodeSpawnConfig(runtime(), {
      ELIZA_OPENCODE_BASE_URL: "https://api.cerebras.ai/v1",
      ELIZA_OPENCODE_API_KEY: "vault://PARALLAX_OPENCODE_API_KEY",
      CEREBRAS_API_KEY: "csk-resolved",
      ELIZA_OPENCODE_MODEL_POWERFUL: "gpt-oss-120b",
    });
    expect(result?.providerId).toBe("cerebras");
    const config = JSON.parse(result?.configContent ?? "{}");
    expect(config.provider.cerebras.options.apiKey).toBe("csk-resolved");
  });

  it("supports explicit local OpenAI-compatible opencode mode", () => {
    const result = buildOpencodeSpawnConfig(runtime(), {
      ELIZA_OPENCODE_LOCAL: "1",
      ELIZA_OPENCODE_BASE_URL: "http://localhost:11434/v1",
      ELIZA_OPENCODE_MODEL_POWERFUL: "qwen2.5-coder",
    });
    expect(result?.providerId).toBe("eliza-local");
    expect(result?.model).toBe("eliza-local/qwen2.5-coder");
    const config = JSON.parse(result?.configContent ?? "{}");
    expect(config.provider["eliza-local"].options.baseURL).toBe(
      "http://localhost:11434/v1",
    );
  });

  it("falls back to user opencode.json model names when only a model is configured", () => {
    const result = buildOpencodeSpawnConfig(runtime(), {
      ELIZA_OPENCODE_MODEL_POWERFUL: "anthropic/claude-sonnet-4-5",
      ELIZA_OPENCODE_MODEL_FAST: "openai/gpt-4.1-mini",
    });
    expect(result?.providerId).toBe("user");
    expect(result?.model).toBe("anthropic/claude-sonnet-4-5");
    expect(result?.smallModel).toBe("openai/gpt-4.1-mini");
  });
});
