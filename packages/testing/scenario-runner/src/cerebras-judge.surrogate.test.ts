/**
 * Verifies surrogate-safe truncation for Cerebras judge error bodies.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

describe("cerebras-judge surrogate-safe truncation", () => {
  it("replaces lone high surrogate with replacement character", () => {
    const lone = String.fromCharCode(0xd800);
    const wellFormed = toWellFormedUnicode(lone);
    expect(wellFormed).toBe("�");
    const truncated = truncateWellFormed(wellFormed, 300);
    expect(truncated).toBe("�");
  });

  it("does not split astral pair at 300 boundary", () => {
    const astral = "🦊";
    const text = "a".repeat(299) + astral + "b".repeat(10);
    const wellFormed = toWellFormedUnicode(text);
    const truncated = truncateWellFormed(wellFormed, 300);
    // High surrogate at 299, low at 300 -> truncate to 299 to avoid lone
    expect(truncated.length).toBe(299);
    expect(truncated).toBe("a".repeat(299));
    expect(() => JSON.stringify(truncated)).not.toThrow();
  });

  it("truncates ASCII verbatim at 300", () => {
    const ascii = "x".repeat(500);
    const truncated = truncateWellFormed(toWellFormedUnicode(ascii), 300);
    expect(truncated.length).toBe(300);
    expect(truncated).toBe("x".repeat(300));
  });

  it("handles lone surrogate at boundary without producing invalid JSON", () => {
    const loneAtBoundary =
      "a".repeat(299) + String.fromCharCode(0xd800) + "b".repeat(200);
    const result = truncateWellFormed(toWellFormedUnicode(loneAtBoundary), 300);
    expect(result.length).toBeLessThanOrEqual(300);
    expect(toWellFormedUnicode(result)).toBe(result);
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});
