/**
 * Cloud tokenizer handlers load one rank table on first use and reuse the
 * built encoder while calls keep coming, instead of importing every table up
 * front and rebuilding a Tiktoken on each call. The encoder (about 69 MB for
 * o200k_base) is dropped after an idle window, so it is not held for the life
 * of the process. The tokens match the reference js-tiktoken encoder.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { encodingForModel } from "js-tiktoken";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ENCODER_IDLE_MS,
  handleTokenizerDecode,
  handleTokenizerEncode,
  loadedTokenizerEncodings,
  loadTokenizerEncoding,
  resolveTokenizerEncodingName,
} from "../src/models/tokenization";

const runtime = {} as IAgentRuntime;
const savedLarge = process.env.ELIZAOS_CLOUD_LARGE_MODEL;

afterEach(() => {
  vi.useRealTimers();
  if (savedLarge === undefined) delete process.env.ELIZAOS_CLOUD_LARGE_MODEL;
  else process.env.ELIZAOS_CLOUD_LARGE_MODEL = savedLarge;
});

// Building an encoder parses a whole rank table, which takes seconds under the test transform.
describe("cloud tokenizer", { timeout: 30_000 }, () => {
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

  it("releases the encoder after the idle window and keeps at most one", async () => {
    // Load the rank modules with real timers; the module loader uses them.
    await import("js-tiktoken/ranks/cl100k_base");
    await import("js-tiktoken/ranks/o200k_base");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = await loadTokenizerEncoding("o200k_base");
    expect(loadedTokenizerEncodings()).toEqual(["o200k_base"]);

    // A call inside the window keeps the same encoder and restarts the window.
    vi.advanceTimersByTime(ENCODER_IDLE_MS - 1);
    expect(await loadTokenizerEncoding("o200k_base")).toBe(first);
    vi.advanceTimersByTime(ENCODER_IDLE_MS - 1);
    expect(loadedTokenizerEncodings()).toEqual(["o200k_base"]);

    // Another encoding replaces the held one rather than adding to it.
    await loadTokenizerEncoding("cl100k_base");
    expect(loadedTokenizerEncodings()).toEqual(["cl100k_base"]);

    // A full idle window with no call drops it.
    vi.advanceTimersByTime(ENCODER_IDLE_MS - 1);
    expect(loadedTokenizerEncodings()).toEqual(["cl100k_base"]);
    vi.advanceTimersByTime(1);
    expect(loadedTokenizerEncodings()).toEqual([]);
  });

  it("keeps the provider-prefix, variant and gpt-4o fallbacks", () => {
    expect(resolveTokenizerEncodingName("openai/gpt-3.5-turbo")).toBe("cl100k_base");
    expect(resolveTokenizerEncodingName("gpt-4o:latest")).toBe("o200k_base");
    expect(resolveTokenizerEncodingName("some-vendor/unknown-model")).toBe("o200k_base");
  });
});
