/**
 * Keyword matching backs i18n action routing. Normalization (NFKC + lowercase +
 * whitespace collapse), ASCII word-boundary matching (so "cat" doesn't match
 * "category"), and longest-term-first selection must all hold — a loose match
 * here fires the wrong action.
 */
import { describe, expect, it } from "vitest";
import {
  collectKeywordTermMatches,
  collectPreparedKeywordTermMatches,
  findKeywordTermMatch,
  normalizeKeywordMatchText,
  prepareKeywordTerms,
  splitKeywordDoc,
  textIncludesKeywordTerm,
} from "./keyword-matching";

describe("normalizeKeywordMatchText", () => {
  it("lowercases, collapses whitespace, trims", () => {
    expect(normalizeKeywordMatchText("  Hello   World  ")).toBe("hello world");
  });
});

describe("splitKeywordDoc", () => {
  it("splits on newlines, trims, de-duplicates (normalized)", () => {
    expect(splitKeywordDoc("Hello\n hello \n\nWorld")).toEqual([
      "Hello",
      "World",
    ]);
    expect(splitKeywordDoc(undefined)).toEqual([]);
  });
});

describe("textIncludesKeywordTerm", () => {
  it("matches whole ASCII words on boundaries, not substrings", () => {
    expect(textIncludesKeywordTerm("I have a cat", "cat")).toBe(true);
    expect(textIncludesKeywordTerm("browse the category", "cat")).toBe(false);
    expect(textIncludesKeywordTerm("please send money now", "send money")).toBe(
      true,
    );
    expect(textIncludesKeywordTerm("", "cat")).toBe(false);
  });
});

describe("collectKeywordTermMatches / findKeywordTermMatch", () => {
  it("collects every matching term across texts", () => {
    const matches = collectKeywordTermMatches(
      ["delete the file", "send a message"],
      ["delete", "send", "archive"],
    );
    expect([...matches].sort()).toEqual(["delete", "send"]);
  });

  it("findKeywordTermMatch prefers the longest matching term", () => {
    expect(
      findKeywordTermMatch("please send money to bob", ["send", "send money"]),
    ).toBe("send money");
    expect(
      findKeywordTermMatch("nothing matches", ["foo", "bar"]),
    ).toBeUndefined();
  });
});

describe("prepared keyword terms", () => {
  it("returns the same matches, in the same order, as the unprepared form", () => {
    const terms = [
      "find contact",
      "contacto",
      "kontakt",
      "find contact",
      "who is",
    ];
    const texts = [
      "Wer ist der Kontakt?",
      "please find contact Alice",
      "unrelated",
    ];
    const prepared = prepareKeywordTerms(terms);
    expect(prepared.map((entry) => entry.term)).toEqual([
      "find contact",
      "contacto",
      "kontakt",
      "who is",
    ]);
    expect([...collectPreparedKeywordTermMatches(texts, prepared)]).toEqual([
      ...collectKeywordTermMatches(texts, terms),
    ]);
    expect([...collectPreparedKeywordTermMatches(texts, prepared)]).toEqual([
      "kontakt",
      "find contact",
    ]);
    expect(collectPreparedKeywordTermMatches(["weather"], prepared).size).toBe(
      0,
    );
    expect(collectPreparedKeywordTermMatches([], prepared).size).toBe(0);
  });
});
