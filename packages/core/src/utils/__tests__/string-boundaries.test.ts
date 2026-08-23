import { describe, expect, it } from "vitest";
import { trimEndCharacters, trimEndWhitespace } from "./string-boundaries.ts";

describe("trimEndCharacters", () => {
  it("trims matching trailing characters", () => {
    expect(trimEndCharacters("hello!!!", "!")).toBe("hello");
    expect(trimEndCharacters("abc---", "-")).toBe("abc");
  });

  it("preserves surrogates pairs when trimming", () => {
    // The heart emoji is a surrogate pair; trimming "!" must not cut into it.
    expect(trimEndCharacters("hi💖!!", "!")).toBe("hi💖");
  });

  it("returns the original string when nothing matches", () => {
    expect(trimEndCharacters("hello", "!")).toBe("hello");
    expect(trimEndCharacters("", "!")).toBe("");
  });

  it("trims multiple distinct characters from the set", () => {
    expect(trimEndCharacters("xab", "ab")).toBe("x");
  });
});

describe("trimEndWhitespace", () => {
  it("trims trailing whitespace", () => {
    expect(trimEndWhitespace("hi   ")).toBe("hi");
    expect(trimEndWhitespace("hi\n\t")).toBe("hi");
  });

  it("handles empty and all-whitespace strings", () => {
    expect(trimEndWhitespace("")).toBe("");
    expect(trimEndWhitespace("   ")).toBe("");
  });

  it("preserves leading whitespace", () => {
    expect(trimEndWhitespace("  hi  ")).toBe("  hi");
  });
});
