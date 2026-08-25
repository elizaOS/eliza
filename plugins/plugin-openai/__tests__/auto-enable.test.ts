/**
 * Unit test for `shouldEnable`: the provider auto-enables only when one of the
 * OpenAI-compatible API keys is present and concrete. Pure function, no runtime.
 */
import type { PluginAutoEnableContext } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import { shouldEnable } from "../auto-enable";

function ctx(env: Record<string, string | undefined>): PluginAutoEnableContext {
  return { env } as PluginAutoEnableContext;
}

describe("plugin-openai auto-enable", () => {
  it("enables when EVOLINK_API_KEY is present", () => {
    expect(shouldEnable(ctx({ EVOLINK_API_KEY: "evl-test" }))).toBe(true);
  });

  it("ignores blank EvoLink API keys", () => {
    expect(shouldEnable(ctx({ EVOLINK_API_KEY: " " }))).toBe(false);
  });

  it("enables when a concrete OPENAI_API_KEY is present", () => {
    expect(shouldEnable(ctx({ OPENAI_API_KEY: "sk-proj-real-key" }))).toBe(true);
  });

  it("enables when a concrete CEREBRAS_API_KEY is present", () => {
    expect(shouldEnable(ctx({ CEREBRAS_API_KEY: "cerebras-real-key" }))).toBe(true);
  });

  it("stays disabled when no key is set", () => {
    expect(shouldEnable(ctx({}))).toBe(false);
  });

  it("stays disabled for empty or whitespace-only keys", () => {
    expect(shouldEnable(ctx({ OPENAI_API_KEY: "" }))).toBe(false);
    expect(shouldEnable(ctx({ OPENAI_API_KEY: "   " }))).toBe(false);
  });

  it("rejects placeholder keys that previously spoofed the gate", () => {
    for (const placeholder of [
      "REDACTED",
      "[REDACTED]",
      "PLACEHOLDER",
      "TODO",
      "CHANGEME",
      "EMPTY",
      "changeme",
    ]) {
      expect(
        shouldEnable(ctx({ OPENAI_API_KEY: placeholder })),
        `OPENAI_API_KEY=${placeholder}`
      ).toBe(false);
      expect(
        shouldEnable(ctx({ CEREBRAS_API_KEY: placeholder })),
        `CEREBRAS_API_KEY=${placeholder}`
      ).toBe(false);
      expect(
        shouldEnable(ctx({ EVOLINK_API_KEY: placeholder })),
        `EVOLINK_API_KEY=${placeholder}`
      ).toBe(false);
    }
  });

  it("enables when any one of the three keys is concrete", () => {
    expect(
      shouldEnable(
        ctx({
          OPENAI_API_KEY: "REDACTED",
          CEREBRAS_API_KEY: "cerebras-real-key",
        })
      )
    ).toBe(true);
  });
});
