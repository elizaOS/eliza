/**
 * Surrogate-safe truncation for auth audit User-Agent.
 */
import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

describe("auth audit userAgent surrogate-safe", () => {
  it("replaces lone surrogate", () => {
    expect(toWellFormedUnicode("a\uD800b")).toBe("a\uFFFDb");
  });
  it("does not split astral at 200", () => {
    const astral = "🦊";
    const atBoundary = "x".repeat(199) + astral;
    expect(truncateWellFormed(toWellFormedUnicode(atBoundary), 200)).toBe(
      "x".repeat(199),
    );
    expect(
      truncateWellFormed(toWellFormedUnicode("x".repeat(198) + astral), 200),
    ).toBe("x".repeat(198) + astral);
  });
  it("caps at 200", () => {
    expect(
      truncateWellFormed(toWellFormedUnicode("a".repeat(300)), 200).length,
    ).toBe(200);
  });
  it("preserves short", () => {
    expect(truncateWellFormed(toWellFormedUnicode("Mozilla/5.0"), 200)).toBe(
      "Mozilla/5.0",
    );
  });
});
