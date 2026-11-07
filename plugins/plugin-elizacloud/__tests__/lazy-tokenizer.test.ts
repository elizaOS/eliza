/**
 * Cloud tokenizer handlers load one rank table on first use and reuse the
 * built encoder, instead of importing every table up front and rebuilding a
 * Tiktoken on each call; the tokens match the reference js-tiktoken encoder.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { encodingForModel } from "js-tiktoken";
import { afterEach, describe, expect, it } from "vitest";
import {
  handleTokenizerDecode,
  handleTokenizerEncode,
  loadedTokenizerEncodings,
  loadTokenizerEncoding,
  resolveTokenizerEncodingName,
} from "../src/models/tokenization";

const runtime = {} as IAgentRuntime;
const savedLarge = process.env.ELIZAOS_CLOUD_LARGE_MODEL;

afterEach(() => {
  if (savedLarge === undefined) delete process.env.ELIZAOS_CLOUD_LARGE_MODEL;
  else process.env.ELIZAOS_CLOUD_LARGE_MODEL = savedLarge;
});

describe("cloud tokenizer", () => {
  it("loads only the configured model's encoding and matches js-tiktoken", async () => {
    expect(loadedTokenizerEncodings()).toEqual([]);
    process.env.ELIZAOS_CLOUD_LARGE_MODEL = "openai/gpt-4o-mini";
    const text = "Grace keeps the agent heap small.";

    const tokens = await handleTokenizerEncode(runtime, {
      prompt: text,
      modelType: ModelType.TEXT_LARGE,
    });
    expect(tokens).toEqual(encodingForModel("gpt-4o-mini").encode(text));
    expect(loadedTokenizerEncodings()).toEqual(["o200k_base"]);
    await expect(
      handleTokenizerDecode(runtime, { tokens, modelType: ModelType.TEXT_LARGE })
    ).resolves.toBe(text);
  });

  it("builds each encoder once and shares it across calls", async () => {
    const [first, second] = await Promise.all([
      loadTokenizerEncoding("o200k_base"),
      loadTokenizerEncoding("o200k_base"),
    ]);
    expect(first).toBe(second);
    expect(await loadTokenizerEncoding("o200k_base")).toBe(first);
  });

  it("keeps the provider-prefix, variant and gpt-4o fallbacks", () => {
    expect(resolveTokenizerEncodingName("openai/gpt-3.5-turbo")).toBe("cl100k_base");
    expect(resolveTokenizerEncodingName("gpt-4o:latest")).toBe("o200k_base");
    expect(resolveTokenizerEncodingName("some-vendor/unknown-model")).toBe("o200k_base");
  });
});
