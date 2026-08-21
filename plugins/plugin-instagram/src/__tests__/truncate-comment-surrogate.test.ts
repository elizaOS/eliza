/**
 * Regression tests for truncateInstagramComment ensuring capping to MAX_COMMENT_LENGTH
 * never splits an astral UTF-16 surrogate pair and sanitizes lone surrogates.
 */
import { describe, expect, it } from "vitest";
import { MAX_COMMENT_LENGTH } from "../constants.js";
import { truncateInstagramComment } from "../service.js";

describe("truncateInstagramComment", () => {
  it("leaves text under MAX_COMMENT_LENGTH intact", () => {
    const text = "A normal short comment with an emoji 😊";
    expect(truncateInstagramComment(text)).toBe(text);
  });

  it("truncates long text at MAX_COMMENT_LENGTH with ellipsis", () => {
    const text = "a".repeat(MAX_COMMENT_LENGTH + 50);
    const truncated = truncateInstagramComment(text);

    expect(truncated.length).toBe(MAX_COMMENT_LENGTH);
    expect(truncated).toBe(`${"a".repeat(MAX_COMMENT_LENGTH - 3)}...`);
    expect(truncated.isWellFormed()).toBe(true);
  });

  it("keeps UTF-16 surrogate pairs intact across the truncation boundary", () => {
    // 2196 single-unit chars + 2-unit emoji (🦊 \uD83E\uDD8A) + trailing chars
    // Budget is 2200 - 3 = 2197. Slicing at 2197 would split 🦊 between \uD83E and \uDD8A.
    // truncateWellFormed backs off to 2196 so the emoji is not split.
    const text = `${"a".repeat(MAX_COMMENT_LENGTH - 4)}🦊${"b".repeat(100)}`;
    const truncated = truncateInstagramComment(text);

    expect(truncated.length).toBeLessThanOrEqual(MAX_COMMENT_LENGTH);
    expect(truncated).toBe(`${"a".repeat(MAX_COMMENT_LENGTH - 4)}...`);
    expect(truncated.isWellFormed()).toBe(true);
  });

  it("sanitizes pre-existing lone surrogates before truncation", () => {
    const text = "a\ud800bc";
    const truncated = truncateInstagramComment(text);

    expect(truncated).toBe("a\ufffdbc");
    expect(truncated.isWellFormed()).toBe(true);
  });

  it("preserves an emoji that fits entirely under the cap", () => {
    const text = `${"a".repeat(10)}🦊`;
    const truncated = truncateInstagramComment(text);

    expect(truncated).toBe(text);
    expect(truncated.isWellFormed()).toBe(true);
  });
});
