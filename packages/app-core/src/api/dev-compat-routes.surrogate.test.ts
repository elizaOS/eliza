/**
 * Surrogate-safe screenshot upstream error detail truncation.
 */
import { describe, expect, it } from "vitest";
import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";

describe("dev-compat screenshot detail surrogate-safe", () => {
  it("replaces lone surrogate", () => {
    expect(toWellFormedUnicode("a\uD800b")).toBe("a\uFFFDb");
  });
  it("does not split astral at 200 boundary", () => {
    const astral = "🧠";
    const atBoundary = "x".repeat(199) + astral;
    const well = toWellFormedUnicode(atBoundary);
    expect(truncateWellFormed(well, 200)).toBe("x".repeat(199));
    expect(truncateWellFormed(toWellFormedUnicode("x".repeat(198) + astral), 200)).toBe("x".repeat(198) + astral);
  });
  it("caps at 200", () => {
    expect(truncateWellFormed(toWellFormedUnicode("a".repeat(400)), 200).length).toBe(200);
  });
  it("preserves short", () => {
    expect(truncateWellFormed(toWellFormedUnicode("ok"), 200)).toBe("ok");
  });
});
