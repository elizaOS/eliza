import { describe, expect, it, vi } from "vitest";
import { handleTokenizerDecode, handleTokenizerEncode } from "./tokenizer";

const tokenizeSpy = vi.hoisted(() => ({
  tokenizeText: vi.fn(),
  detokenizeText: vi.fn(),
}));

vi.mock("../utils/tokenization", () => tokenizeSpy);

const runtime = { modelProvider: "openai" } as never;

describe("handleTokenizerEncode", () => {
  it("throws when the prompt is missing", async () => {
    await expect(handleTokenizerEncode(runtime, { prompt: "" } as never)).rejects.toThrow(
      "Tokenization requires a non-empty prompt"
    );
    expect(tokenizeSpy.tokenizeText).not.toHaveBeenCalled();
  });

  it("delegates to tokenizeText with the runtime and model type", async () => {
    tokenizeSpy.tokenizeText.mockReturnValue([1, 2, 3]);
    const result = await handleTokenizerEncode(runtime, {
      prompt: "hello",
      modelType: "text_embedding",
    } as never);
    expect(result).toEqual([1, 2, 3]);
    expect(tokenizeSpy.tokenizeText).toHaveBeenCalledWith(runtime, "text_embedding", "hello");
  });
});

describe("handleTokenizerDecode", () => {
  it("throws when tokens are missing", async () => {
    await expect(handleTokenizerDecode(runtime, {} as never)).rejects.toThrow(
      "Detokenization requires a valid tokens array"
    );
  });

  it("throws when tokens is not an array", async () => {
    await expect(handleTokenizerDecode(runtime, { tokens: "abc" } as never)).rejects.toThrow(
      "Detokenization requires a valid tokens array"
    );
  });

  it("returns an empty string for an empty token array", async () => {
    const result = await handleTokenizerDecode(runtime, { tokens: [] } as never);
    expect(result).toBe("");
    expect(tokenizeSpy.detokenizeText).not.toHaveBeenCalled();
  });

  it("throws with the offending index for a non-numeric token", async () => {
    await expect(handleTokenizerDecode(runtime, { tokens: [1, "x"] } as never)).rejects.toThrow(
      "Invalid token at index 1: expected number"
    );
  });

  it("throws for NaN and infinite token values", async () => {
    await expect(handleTokenizerDecode(runtime, { tokens: [Number.NaN] } as never)).rejects.toThrow(
      "Invalid token at index 0: expected number"
    );
    await expect(
      handleTokenizerDecode(runtime, { tokens: [Number.POSITIVE_INFINITY] } as never)
    ).rejects.toThrow("Invalid token at index 0: expected number");
  });

  it("delegates to detokenizeText with validated tokens", async () => {
    tokenizeSpy.detokenizeText.mockReturnValue("hi there");
    const result = await handleTokenizerDecode(runtime, {
      tokens: [104, 101],
      modelType: "text_embedding",
    } as never);
    expect(result).toBe("hi there");
    expect(tokenizeSpy.detokenizeText).toHaveBeenCalledWith(runtime, "text_embedding", [104, 101]);
  });
});
