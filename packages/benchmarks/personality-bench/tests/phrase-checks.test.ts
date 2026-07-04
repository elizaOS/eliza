// Exercises personality-bench benchmark personality bench tests phrase checks.test behavior against deterministic harness fixtures.
import { describe, expect, it } from "vitest";
import {
  checkForbiddenPhrases,
  checkNoEmojis,
  checkRequiredCodeBlock,
  countEmojis,
  countSyllables,
  hasCodeBlock,
} from "../src/judge/checks/phrase";

/**
 * Deterministic phrase checks back the personality judge's non-LLM layer.
 * Emoji counting, syllable estimation, code-block detection, and
 * forbidden-phrase matching must be exact — the calibration corpus relies on
 * these to hit its agreement targets without the LLM layer.
 */

describe("primitives", () => {
  it("countEmojis / hasCodeBlock", () => {
    expect(countEmojis("no emoji here")).toBe(0);
    expect(countEmojis("hello 😀 world 🎉")).toBe(2);
    expect(hasCodeBlock("```js\ncode\n```")).toBe(true);
    expect(hasCodeBlock("just prose")).toBe(false);
  });

  it("countSyllables estimates vowel groups (silent-e dropped)", () => {
    expect(countSyllables("cat")).toBe(1);
    expect(countSyllables("make")).toBe(1); // trailing silent e dropped
    expect(countSyllables("hello")).toBe(2);
    expect(countSyllables("the quick brown fox")).toBe(4); // 1+1+1+1
  });
});

describe("layer checks", () => {
  it("checkNoEmojis passes clean text, fails on emojis", () => {
    expect(checkNoEmojis("plain text").verdict).toBe("PASS");
    expect(checkNoEmojis("yay 🎉").verdict).toBe("FAIL");
  });

  it("checkForbiddenPhrases matches case-insensitive substrings", () => {
    expect(checkForbiddenPhrases("I am happy", ["as an ai"]).verdict).toBe(
      "PASS",
    );
    const fail = checkForbiddenPhrases("As An AI language model, I...", [
      "as an ai",
    ]);
    expect(fail.verdict).toBe("FAIL");
  });

  it("checkRequiredCodeBlock requires a fenced block", () => {
    expect(checkRequiredCodeBlock("```\nx\n```").verdict).toBe("PASS");
    expect(checkRequiredCodeBlock("no block").verdict).toBe("FAIL");
  });
});
