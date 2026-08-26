/**
 * Regression tests for shellUtils.chunkString: an 8 KiB raw-limit cut must
 * never split a UTF-16 surrogate pair (emoji), which would leave a lone
 * surrogate in the background-shell output ring, and a limit that cannot make
 * UTF-16 progress must reject instead of spinning. Pure-function assertions on
 * the real exported chunkString.
 */
import { describe, expect, it } from "vitest";
import {
  chunkString,
  deriveSessionName,
  sliceUtf16Safe,
  truncateMiddle,
} from "./shellUtils";

const CHUNK_LIMIT = 8 * 1024;

describe("chunkString surrogate-safe chunking", () => {
  it("keeps surrogate pairs intact across the 8 KiB chunk boundary", () => {
    // A leading single-width char shifts the emoji run onto an odd offset,
    // so the raw-limit cut lands between a pair's high and low surrogate.
    const text = `a${"🙂".repeat(5000)}`;

    const chunks = chunkString(text, CHUNK_LIMIT);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.isWellFormed()).toBe(true);
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_LIMIT);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("keeps chunks intact and lossless at the minimum limit", () => {
    const text = "😀😀x";
    const chunks = chunkString(text, 2);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => chunk.isWellFormed())).toBe(true);
    expect(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 2)).toBe(
      true,
    );
  });

  it("rejects a chunk limit that cannot make UTF-16 progress", () => {
    // limit=1 cannot hold the lead half of an emoji without stranding it.
    expect(() => chunkString(`😀${"x".repeat(10)}`, 1)).toThrow(RangeError);
  });

  it("returns the input unchanged when within the limit", () => {
    expect(chunkString("hello world")).toEqual(["hello world"]);
  });
});

describe("deriveSessionName command tokenization", () => {
  it("preserves quoted targets and embedded quoted segments", () => {
    expect(deriveSessionName('node "path with spaces.js" --watch')).toBe(
      "node path with spaces.js",
    );
    expect(deriveSessionName('git refs/heads/"feature branch"')).toBe(
      'git refs/heads/"feature branch"',
    );
  });

  it("handles long unmatched quoted input without regex backtracking", () => {
    const escaped = "\\!".repeat(100_000);
    const name = deriveSessionName(`run "${escaped}`);
    expect(name?.startsWith("run \\!\\!")).toBe(true);
    expect(name?.length).toBeLessThanOrEqual("run ".length + 48);
  });

  it("handles both quote styles in adversarial input", () => {
    const escaped = "\\&".repeat(100_000);
    const name = deriveSessionName(`run '${escaped}`);
    expect(name?.startsWith("run \\&\\&")).toBe(true);
  });

  it("handles many unmatched quote delimiters in linear time", () => {
    // Each quote's escape (\") consumes the next delimiter, so every
    // unmatched-quote fallback used to rescan the remaining suffix and go
    // quadratic; the bounded tokenization prefix caps that work.
    const name = deriveSessionName(`run ${'"\\'.repeat(100_000)}`);
    expect(name).toBe("run \\");
  });
});

describe("sliceUtf16Safe surrogate-safe string slicing", () => {
  it("does not split surrogate pairs when start lands on a low surrogate", () => {
    // "😀" has high surrogate at index 0 and low surrogate at index 1.
    // Slicing at index 1 without protection yields a lone low surrogate.
    const sliced = sliceUtf16Safe("😀", 1);
    expect(sliced.isWellFormed()).toBe(true);
    expect(sliced).toBe("");

    const withPrefix = sliceUtf16Safe("A😀B", 2);
    expect(withPrefix.isWellFormed()).toBe(true);
    expect(withPrefix).toBe("B");
  });

  it("does not split surrogate pairs when end lands between a high and low surrogate", () => {
    const sliced = sliceUtf16Safe("😀", 0, 1);
    expect(sliced.isWellFormed()).toBe(true);
    expect(sliced).toBe("");

    const withPrefix = sliceUtf16Safe("A😀B", 0, 2);
    expect(withPrefix.isWellFormed()).toBe(true);
    expect(withPrefix).toBe("A");
  });

  it("sanitizes lone surrogates from input text", () => {
    const lone = "bad \uD800 char";
    const sliced = sliceUtf16Safe(lone, 0, 10);
    expect(sliced.isWellFormed()).toBe(true);
    expect(sliced).toContain("\uFFFD");
  });
});

describe("truncateMiddle surrogate-safe string truncation", () => {
  it("does not split surrogate pairs when middle ellipsis falls on astral characters", () => {
    const text = `A${"😀".repeat(10)}`;
    const result = truncateMiddle(text, 9);
    expect(result.isWellFormed()).toBe(true);
    expect(result.length).toBeLessThanOrEqual(9);
    expect(result).toBe("A😀...😀");
  });

  it("handles small and non-positive max bounds without budget overflow", () => {
    expect(truncateMiddle("hello", 2)).toBe("..");
    expect(truncateMiddle("hello", 0)).toBe("");
    expect(truncateMiddle("hello", -1)).toBe("");
    expect(truncateMiddle("hello", 3)).toBe("...");
  });

  it("returns the input unchanged when within max limit", () => {
    expect(truncateMiddle("hello", 10)).toBe("hello");
  });
});
