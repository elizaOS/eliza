/** Unit tests for the embeddings auto-enable predicate: on only when EMBEDDING_BASE_URL or EMBEDDING_API_KEY is set. */
import type { PluginAutoEnableContext } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import { shouldEnable } from "../auto-enable";

function ctx(env: Record<string, string | undefined>): PluginAutoEnableContext {
  return { env } as unknown as PluginAutoEnableContext;
}

describe("plugin-embeddings auto-enable", () => {
  it("is false when neither EMBEDDING_BASE_URL nor EMBEDDING_API_KEY is set", () => {
    expect(shouldEnable(ctx({}))).toBe(false);
    expect(shouldEnable(ctx({ OPENAI_API_KEY: "k" }))).toBe(false);
  });

  it("is false when the opt-in vars are empty/whitespace", () => {
    expect(shouldEnable(ctx({ EMBEDDING_BASE_URL: "" }))).toBe(false);
    expect(shouldEnable(ctx({ EMBEDDING_API_KEY: "   " }))).toBe(false);
  });

  it("is true when EMBEDDING_BASE_URL is a non-empty string", () => {
    expect(shouldEnable(ctx({ EMBEDDING_BASE_URL: "https://x/v1" }))).toBe(true);
  });

  it("is true when EMBEDDING_API_KEY is a non-empty string", () => {
    expect(shouldEnable(ctx({ EMBEDDING_API_KEY: "sk-test" }))).toBe(true);
  });
});
