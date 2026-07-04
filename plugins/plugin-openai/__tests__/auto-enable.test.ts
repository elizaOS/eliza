/**
 * Unit test for `shouldEnable`: the provider auto-enables only when one of the
 * OpenAI-compatible API keys is present. Pure function, no runtime.
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
});
