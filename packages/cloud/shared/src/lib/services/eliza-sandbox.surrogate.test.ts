/**
 * Surrogate-safe truncation for agent sandbox restore error.
 */
import { describe, expect, it } from "vitest";
import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";

describe("eliza-sandbox surrogate-safe", () => {
  it("replaces lone surrogate", () => {
    expect(toWellFormedUnicode("a\uD800b")).toBe("a\uFFFDb");
  });
  it("does not split astral at 200", () => {
    expect(truncateWellFormed(toWellFormedUnicode("x".repeat(199) + "🦊"), 200)).toBe("x".repeat(199));
  });
  it("caps at 200", () => {
    expect(truncateWellFormed(toWellFormedUnicode("a".repeat(300)), 200).length).toBe(200);
  });
});
