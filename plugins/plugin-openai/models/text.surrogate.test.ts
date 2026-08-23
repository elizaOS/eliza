/**
 * Surrogate-safe truncation for provider error body excerpt.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

describe("openai provider error surrogate-safe", () => {
  it("replaces lone surrogate", () => {
    expect(toWellFormedUnicode("a\uD800b")).toBe("a\uFFFDb");
  });
  it("does not split astral at 300", () => {
    const atBoundary = `${"x".repeat(299)}🦊`;
    expect(truncateWellFormed(toWellFormedUnicode(atBoundary), 300)).toBe("x".repeat(299));
  });
  it("caps at 300", () => {
    expect(truncateWellFormed(toWellFormedUnicode("a".repeat(500)), 300).length).toBe(300);
  });
});
