import { describe, expect, it } from "vitest";
import { chunkTokens } from "./phrase-chunker";
import type { TextToken } from "./types";

function tokens(parts: string[]): TextToken[] {
  return parts.map((text, index) => ({ index, text }));
}

describe("PhraseChunker punctuation boundaries", () => {
  it("flushes on semicolon and colon boundaries for faster first audio", () => {
    const phrases = chunkTokens(tokens(["First:", " second;", " third"]), {});

    expect(phrases.map((phrase) => phrase.text)).toEqual([
      "First:",
      " second;",
      " third",
    ]);
    expect(phrases.map((phrase) => phrase.terminator)).toEqual([
      "punctuation",
      "punctuation",
      "max-cap",
    ]);
  });
});
