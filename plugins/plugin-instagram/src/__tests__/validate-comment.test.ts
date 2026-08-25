/**
 * Instagram comment validation preserves valid Unicode and rejects an
 * over-limit payload without changing its content.
 */
import { describe, expect, it } from "vitest";
import { MAX_COMMENT_LENGTH } from "../constants.js";
import { validateInstagramComment } from "../service.js";

describe("validateInstagramComment", () => {
  it("returns a complete valid comment", () => {
    const text = "A normal short comment with an emoji 😊";
    expect(validateInstagramComment(text)).toBe(text);
  });

  it("rejects a comment that exceeds the platform boundary", () => {
    const text = "a".repeat(MAX_COMMENT_LENGTH + 1);
    expect(() => validateInstagramComment(text)).toThrow(
      `Instagram comments must not exceed ${MAX_COMMENT_LENGTH} UTF-16 code units`
    );
  });

  it("sanitizes a lone surrogate without discarding text", () => {
    expect(validateInstagramComment("a\ud800bc")).toBe("a\ufffdbc");
  });
});
