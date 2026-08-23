/**
 * Surrogate-safe truncation for iOS attachment smoke upload error.
 */
import { describe, expect, it } from "vitest";
import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";

describe("ios-attachment-smoke surrogate-safe", () => {
  it("replaces lone surrogate", () => {
    expect(toWellFormedUnicode("a\uD800b")).toBe("a\uFFFDb");
  });
  it("does not split astral at 500", () => {
    expect(truncateWellFormed(toWellFormedUnicode("x".repeat(499) + "🦊"), 500)).toBe("x".repeat(499));
  });
  it("caps at 500", () => {
    expect(truncateWellFormed(toWellFormedUnicode("a".repeat(800)), 500).length).toBe(500);
  });
});
