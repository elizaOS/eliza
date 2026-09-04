/**
 * Keyword matching backs i18n action routing. Normalization (NFKC + lowercase +
 * whitespace collapse), ASCII word-boundary matching (so "cat" doesn't match
 * "category"), and longest-term-first selection must all hold — a loose match
 * here fires the wrong action.
 */
import { describe, expect, it } from "vitest";
import {
  collectKeywordTermMatches,
  findKeywordTermMatch,
  normalizeKeywordMatchText,
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
  // The header invariant above ("cat" must not match "category") held only
  // while the text was pure ASCII. The boundary pattern was tested against the
  // RAW text, so an NFKC-only spelling could not match it, and the substring
  // fallback that compensated abandoned word boundaries for any text
  // containing a non-ASCII character — one emoji was enough.
  it.each([
    ["restart the server \u{1F642}", "art"],
    ["please reschedule \u{1F642}", "schedule"],
    ["I am scanning caf\u00e9", "scan"],
    ["classified \u2705", "class"],
  ])("keeps word boundaries in %s", (text, term) => {
    expect(textIncludesKeywordTerm(text, term)).toBe(false);
  });

  // The same words without the trailing non-ASCII character already behaved,
  // which is what made the regression invisible.
  it.each([
    ["restart the server", "art"],
    ["please reschedule", "schedule"],
    ["I am scanning", "scan"],
    ["classified", "class"],
  ])("kept word boundaries in pure-ASCII %s all along", (text, term) => {
    expect(textIncludesKeywordTerm(text, term)).toBe(false);
  });

  it.each([
    ["run a scan now", "scan"],
    ["run a scan now \u{1F642}", "scan"],
    ["\u5f00\u59cbscan\u4efb\u52a1", "scan"],
    ["\uff53\uff43\uff41\uff4e now", "scan"],
    ["SCAN THIS", "scan"],
  ])("still matches %s", (text, term) => {
    expect(textIncludesKeywordTerm(text, term)).toBe(true);
  });

  // `escapePattern` never escapes a space, so the old `/\\ /` replace was
  // inert and a multi-word term could not span a double space or a newline.
  it.each([
    ["scan  the   disk", "scan the disk"],
    ["scan\nthe disk", "scan the disk"],
  ])("matches a multi-word term across %j", (text, term) => {
    expect(textIncludesKeywordTerm(text, term)).toBe(true);
  });
});
