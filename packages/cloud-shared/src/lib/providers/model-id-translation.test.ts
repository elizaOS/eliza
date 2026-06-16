import { describe, expect, test } from "bun:test";
import { stripOpenRouterRoutingSuffix } from "./model-id-translation";

describe("stripOpenRouterRoutingSuffix", () => {
  test("strips :nitro from a provider-prefixed model id", () => {
    expect(stripOpenRouterRoutingSuffix("openai/gpt-oss-120b:nitro")).toBe("openai/gpt-oss-120b");
  });

  test("strips :floor from a provider-prefixed model id", () => {
    expect(stripOpenRouterRoutingSuffix("x-ai/grok-4:floor")).toBe("x-ai/grok-4");
  });

  test("strips :nitro from a dashed bare model id", () => {
    expect(stripOpenRouterRoutingSuffix("gpt-oss-120b:nitro")).toBe("gpt-oss-120b");
  });

  test("does not strip :free (distinct free-tier variant)", () => {
    expect(stripOpenRouterRoutingSuffix("openai/gpt-oss-120b:free")).toBeNull();
  });

  test("does not strip :online (changes behavior)", () => {
    expect(stripOpenRouterRoutingSuffix("openai/gpt-oss-120b:online")).toBeNull();
  });

  test("returns null when there is no routing suffix", () => {
    expect(stripOpenRouterRoutingSuffix("openai/gpt-oss-120b")).toBeNull();
  });

  test("does not mistake a forced-provider prefix for a suffix", () => {
    expect(stripOpenRouterRoutingSuffix("cerebras:gpt-oss-120b")).toBeNull();
  });

  test("strips only the trailing routing suffix, keeping a forced-provider prefix", () => {
    expect(stripOpenRouterRoutingSuffix("cerebras:gpt-oss-120b:nitro")).toBe(
      "cerebras:gpt-oss-120b",
    );
  });

  test("returns null for an opaque provider:nitro with no model id shape", () => {
    expect(stripOpenRouterRoutingSuffix("foo:nitro")).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(stripOpenRouterRoutingSuffix("")).toBeNull();
  });
});
