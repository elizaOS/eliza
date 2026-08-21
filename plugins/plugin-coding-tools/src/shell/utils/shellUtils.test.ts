/**
 * Regression tests for shellUtils.chunkString: an 8 KiB raw-limit cut must
 * never split a UTF-16 surrogate pair (emoji), which would leave a lone
 * surrogate in the background-shell output ring, and a limit that cannot make
 * UTF-16 progress must reject instead of spinning. Pure-function assertions on
 * the real exported chunkString.
 */
import { describe, expect, it } from "vitest";
import { chunkString, deriveSessionName } from "./shellUtils";

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
});
