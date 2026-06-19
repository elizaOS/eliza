import { expect, test } from "bun:test";
import { resolveEffectiveMode } from "./modes";
import { DEFAULT_DEMO_CONFIG, type DemoConfig } from "./types";

function withMode(mode: DemoConfig["mode"], key: string): DemoConfig {
  return {
    ...DEFAULT_DEMO_CONFIG,
    mode,
    provider: {
      ...DEFAULT_DEMO_CONFIG.provider,
      [key]: "test-key",
    },
  };
}

test("getEffectiveMode falls back to ELIZA classic when provider keys are missing", () => {
  for (const mode of [
    "openai",
    "anthropic",
    "xai",
    "gemini",
    "groq",
  ] as const) {
    expect(resolveEffectiveMode({ ...DEFAULT_DEMO_CONFIG, mode })).toBe(
      "elizaClassic",
    );
  }
});

test("getEffectiveMode honors configured provider keys", () => {
  expect(resolveEffectiveMode(withMode("openai", "openaiApiKey"))).toBe(
    "openai",
  );
  expect(resolveEffectiveMode(withMode("anthropic", "anthropicApiKey"))).toBe(
    "anthropic",
  );
  expect(resolveEffectiveMode(withMode("xai", "xaiApiKey"))).toBe("xai");
  expect(resolveEffectiveMode(withMode("gemini", "googleGenaiApiKey"))).toBe(
    "gemini",
  );
  expect(resolveEffectiveMode(withMode("groq", "groqApiKey"))).toBe("groq");
});
