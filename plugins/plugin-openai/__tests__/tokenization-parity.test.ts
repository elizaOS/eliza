/** Checks exact token parity and complete long-input round trips. */
import type { IAgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { encodingForModel } from "js-tiktoken";
import { describe, expect, it } from "vitest";
import { countTokensForModel, detokenizeText, tokenizeText } from "../utils/tokenization";

const runtime = (model: string) =>
  ({
    getSetting: (key: string) => (key === "OPENAI_SMALL_MODEL" ? model : undefined),
  }) as unknown as IAgentRuntime;

describe("provider tokenizer", () => {
  it.each(["gpt-4o", "gpt-4"] as const)("retains exact %s tokens", (model) => {
    const text = 'Exact context 🧭 漢字\nquoted \\"value\\"\r\n'.repeat(30);
    const expected = encodingForModel(model).encode(text);
    expect(tokenizeText(runtime(model), ModelType.TEXT_SMALL, text)).toEqual(expected);
    expect(countTokensForModel(model, text)).toBe(expected.length);
  });

  it("round trips the complete long unbroken source", () => {
    const text = `${"A".repeat(140_000)}-FINAL-SOURCE-🧭`;
    const owner = runtime("gpt-4o");
    const tokens = tokenizeText(owner, ModelType.TEXT_SMALL, text);
    expect(detokenizeText(owner, ModelType.TEXT_SMALL, tokens)).toBe(text);
    expect(countTokensForModel("gpt-4o", text)).toBe(tokens.length);
  }, 30_000);
});
