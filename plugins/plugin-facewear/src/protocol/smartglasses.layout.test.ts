/**
 * G1 display layout tests pin glyph measurement, line wrapping, and pagination
 * for text shown on the lenses.
 */
import { describe, expect, it } from "vitest";
import {
  formatDisplayLines,
  measureG1DisplayText,
  paginateDisplayText,
} from "./smartglasses.js";

describe("measureG1DisplayText", () => {
  it("measures by script: empty=0, CJK=18, Korean=24, monotonic in length", () => {
    expect(measureG1DisplayText("")).toBe(0);
    expect(measureG1DisplayText("中")).toBe(18); // CJK
    expect(measureG1DisplayText("가")).toBe(24); // Korean (Hangul syllable)
    expect(measureG1DisplayText("ab")).toBeGreaterThan(
      measureG1DisplayText("a"),
    );
  });
});

describe("formatDisplayLines (by character count)", () => {
  it("word-wraps at the last space within the limit", () => {
    expect(formatDisplayLines("hello world foo", 11)).toEqual([
      "hello world",
      "foo",
    ]);
  });

  it("splits paragraphs on newlines and returns [''] for empty input", () => {
    expect(formatDisplayLines("line1\nline2", 20)).toEqual(["line1", "line2"]);
    expect(formatDisplayLines("", 10)).toEqual([""]);
  });

  it("hard-breaks a token longer than the line", () => {
    const lines = formatDisplayLines("abcdefghij", 4);
    expect(lines.every((l) => l.length <= 4)).toBe(true);
    expect(lines.join("")).toBe("abcdefghij");
  });
});

describe("paginateDisplayText", () => {
  it("splits into padded fixed-height pages with correct numbering", () => {
    const pages = paginateDisplayText("a\nb\nc", {
      charsPerLine: 10,
      linesPerPage: 2,
    });
    expect(pages).toHaveLength(2);
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 2]);
    expect(pages.every((p) => p.maxPages === 2)).toBe(true);
    // every page is padded to exactly linesPerPage lines.
    expect(pages.every((p) => p.text.split("\n").length === 2)).toBe(true);
    // last page carries a distinct (display-complete) screen status.
    expect(pages[1].screenStatus).not.toBe(pages[0].screenStatus);
  });

  it("always yields at least one page", () => {
    expect(paginateDisplayText("", { linesPerPage: 3 })).toHaveLength(1);
  });
});
