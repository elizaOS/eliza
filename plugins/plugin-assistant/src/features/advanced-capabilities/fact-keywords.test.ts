/**
 * Regression tests for fact keyword tokenization: non-Latin fact text must
 * produce keywords, storage keywords, and a query text, so the facts
 * provider can rank a fact written in the same language as the query.
 * Mirrors the documents BM25 tokenizer contract (merged #35488).
 */
import type { Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  buildFactKeywordsForStorage,
  buildFactQueryText,
  factLexicalSimilarity,
  scoreFactKeywordRelevance,
  tokenizeFactText,
} from "./fact-keywords.ts";

describe("tokenizeFactText", () => {
  it("keeps Hangul, Cyrillic, and Greek tokens instead of dropping them", () => {
    expect(tokenizeFactText("사용자는 녹차를 좋아한다")).toEqual([
      "사용자는",
      "녹차를",
      "좋아한다",
    ]);
    expect(tokenizeFactText("Пользователь любит зелёный чай")).toContain(
      "зелёный",
    );
    expect(tokenizeFactText("Ο χρήστης πίνει πράσινο τσάι")).toContain(
      "χρήστης",
    );
  });

  it("keeps an accented word as one token instead of splitting it", () => {
    const tokens = tokenizeFactText("The user lives in Málaga");
    expect(tokens).toContain("málaga");
    expect(tokens).not.toContain("laga");
  });

  it("keeps the existing English floors: stopwords out, short words out", () => {
    expect(tokenizeFactText("The user likes green tea")).toEqual([
      "likes",
      "green",
      "tea",
    ]);
    expect(tokenizeFactText("order 42 and 7 cups")).toEqual([
      "order",
      "42",
      "cups",
    ]);
  });
});

describe("fact keyword retrieval path", () => {
  const memories = [
    { content: { text: "사용자는 녹차를 좋아한다" }, metadata: {} },
    { content: { text: "사용자는 커피를 싫어한다" }, metadata: {} },
  ] as unknown as Memory[];

  it("stores keywords for a non-Latin fact", () => {
    expect(buildFactKeywordsForStorage("사용자는 녹차를 좋아한다")).toEqual([
      "사용자는",
      "녹차를",
      "좋아한다",
    ]);
  });

  it("ranks the matching non-Latin fact above the unrelated one", () => {
    const queryText = buildFactQueryText("녹차 좋아한다");
    // Non-empty (it was "" before the fix). "녹차" itself is two
    // characters, so the pre-existing length floor drops it for every
    // script alike; the surviving query term still ranks the fact.
    expect(queryText).toBe("좋아한다");
    const ranked = scoreFactKeywordRelevance(queryText, memories);
    expect(ranked[0].relevance).toBeGreaterThan(0);
    expect(ranked[1].relevance).toBe(0);
  });

  it("treats two copies of the same non-Latin claim as lexically similar", () => {
    expect(
      factLexicalSimilarity(
        ["사용자는 녹차를 좋아한다"],
        ["사용자는 녹차를 좋아한다"],
      ),
    ).toBe(1);
  });
});

describe("fact keywords across Unicode normalization forms", () => {
  const composedClaim = "prefers café au lait";
  const decomposedClaim = composedClaim.normalize("NFD");
  const composedHangul = "사용자는 녹차를 좋아한다";
  const decomposedHangul = composedHangul.normalize("NFD");

  it("gives the same tokens for composed and decomposed text", () => {
    expect(decomposedClaim).not.toBe(composedClaim);
    expect(tokenizeFactText(decomposedClaim)).toEqual(
      tokenizeFactText(composedClaim),
    );
    expect(tokenizeFactText(decomposedHangul)).toEqual(
      tokenizeFactText(composedHangul),
    );
  });

  it("scores composed and decomposed copies of a claim as identical", () => {
    expect(factLexicalSimilarity([composedHangul], [decomposedHangul])).toBe(1);
    expect(factLexicalSimilarity([composedClaim], [decomposedClaim])).toBe(1);
  });
});
