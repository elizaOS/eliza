/**
 * Deterministic coverage for chat example provider priority and missing-key
 * behavior before any live model plugin is imported.
 */
import { afterEach, expect, test } from "bun:test";
import { detectLLMPlugin, hasValidApiKey, LLM_PROVIDERS } from "./chat";

const providerEnvKeys = LLM_PROVIDERS.map((provider) => provider.envKey);
const originalEnv = Object.fromEntries(
  providerEnvKeys.map((envKey) => [envKey, process.env[envKey]]),
);

afterEach(() => {
  for (const envKey of providerEnvKeys) {
    const originalValue = originalEnv[envKey];
    if (originalValue === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = originalValue;
    }
  }
});

test("provider list keeps the documented priority order", () => {
  expect(LLM_PROVIDERS.map((provider) => provider.name)).toEqual([
    "OpenAI",
    "Anthropic (Claude)",
    "xAI (Grok)",
    "Google GenAI (Gemini)",
    "Groq",
  ]);
});

test("empty provider keys are treated as missing", () => {
  process.env.OPENAI_API_KEY = "   ";
  expect(hasValidApiKey("OPENAI_API_KEY")).toBe(false);

  process.env.OPENAI_API_KEY = "test-key";
  expect(hasValidApiKey("OPENAI_API_KEY")).toBe(true);
});

test("detectLLMPlugin returns null before importing providers when no key is set", async () => {
  for (const envKey of providerEnvKeys) {
    delete process.env[envKey];
  }

  await expect(detectLLMPlugin()).resolves.toBeNull();
});
