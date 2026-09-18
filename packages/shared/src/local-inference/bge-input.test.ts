/** Exercises source-tail selection with the real pinned BGE tokenizer and adversarial text. */
import { Tokenizer } from "@huggingface/tokenizers";
import { describe, expect, it } from "vitest";
import tokenizerJson from "./bge/tokenizer.json";
import tokenizerConfig from "./bge/tokenizer_config.json";
import { assertBgeTokenAgreement, prepareBgeEmbeddingInput } from "./bge-input";

const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);

describe("BGE input tail", () => {
  it.each([
    "",
    " \n\t",
    "Café\u0000 世界 🦊",
    "[CLS] literal [SEP]",
    "word ".repeat(510),
  ])("preserves fitting source bytes: %s", (text) => {
    expect(prepareBgeEmbeddingInput(text).text).toBe(text);
  });

  it("drops the old beginning while retaining the independently specified final 510 tokens", () => {
    const tail = `${"word ".repeat(508)}last instruction`;
    const input = `obsolete ${tail}`;
    const prepared = prepareBgeEmbeddingInput(input);
    expect(prepared.text).toBe(tail);
    expect(prepared.tokenIds).toEqual(tokenizer.encode(tail).ids);
    expect(prepared.originalTokenCount).toBe(513);
    expect(prepared.tokenIds).toHaveLength(512);
    expect(input.startsWith("obsolete ")).toBe(true);
  });

  it.each([
    "unaffordability electroencephalography final decision",
    "Café\u0301 中文 🦊 final decision",
    "before\u0000after \u0001 final decision",
    "[CLS] [MASK] literal [SEP] final decision",
    `${"z".repeat(200)} final decision`,
    "中".repeat(600),
    ".".repeat(600),
  ])(
    "retains a real source suffix with exact trailing token identity: %s",
    (tail) => {
      const source = `outdated information ${"history ".repeat(700)}${tail}`;
      const prepared = prepareBgeEmbeddingInput(source);
      const original = tokenizer.encode(source).ids;
      const actual = tokenizer.encode(prepared.text).ids;
      expect(source.endsWith(prepared.text)).toBe(true);
      expect(prepared.text.endsWith(tail.slice(-24))).toBe(true);
      expect(actual.length).toBeLessThanOrEqual(512);
      expect(actual.slice(1)).toEqual(original.slice(-(actual.length - 1)));
      expect(prepared.text).not.toContain("outdated information");
      assertBgeTokenAgreement(prepared, actual);
    },
  );

  it("does not lose tail tokens at literal special-token punctuation boundaries", () => {
    const source = "[CLS] ".repeat(600);
    const prepared = prepareBgeEmbeddingInput(source);
    expect(prepared.text).toBe("[CLS] ".repeat(510));
    expect(prepared.tokenIds).toHaveLength(512);
  });

  it("refuses a native vocabulary mismatch before canonical inference", () => {
    const prepared = prepareBgeEmbeddingInput("final decision");
    const native = [...prepared.tokenIds];
    native[1] += 1;
    expect(() => assertBgeTokenAgreement(prepared, native)).toThrow(
      /disagrees/,
    );
  });

  it("reports a tail that cannot fit intact instead of substituting a different token", () => {
    expect(() => prepareBgeEmbeddingInput("unaffordability", 3)).toThrow(
      /unchanged source suffix/,
    );
    expect(() => prepareBgeEmbeddingInput("bad\ud800")).toThrow(/unpaired/);
  });
});
