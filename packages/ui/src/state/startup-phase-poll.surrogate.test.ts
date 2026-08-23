/**
 * Surrogate-safe truncation for startup-phase-poll boot traces.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

describe("startup-phase-poll surrogate-safe", () => {
  it("replaces lone surrogate", () => {
    expect(toWellFormedUnicode("a\uD800b")).toBe("a\uFFFDb");
  });
  it("does not split astral at 300 boundary", () => {
    const astral = "🧠";
    const atBoundary = "x".repeat(299) + astral;
    expect(truncateWellFormed(toWellFormedUnicode(atBoundary), 300)).toBe(
      "x".repeat(299),
    );
    expect(
      truncateWellFormed(toWellFormedUnicode("x".repeat(298) + astral), 300),
    ).toBe("x".repeat(298) + astral);
  });
  it("caps at 300", () => {
    expect(
      truncateWellFormed(toWellFormedUnicode("a".repeat(500)), 300).length,
    ).toBe(300);
  });
});
