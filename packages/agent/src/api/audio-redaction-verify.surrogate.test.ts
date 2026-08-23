/**
 * Verifies surrogate-safe truncation for STT verifier error bodies.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

describe("audio-redaction-verify surrogate-safe truncation", () => {
  it("replaces lone high surrogate", () => {
    const lone = String.fromCharCode(0xd800);
    expect(toWellFormedUnicode(lone)).toBe("�");
    expect(truncateWellFormed(toWellFormedUnicode(lone), 300)).toBe("�");
  });

  it("does not split astral pair at 300", () => {
    const text = `${"a".repeat(299)}🦊${"b".repeat(10)}`;
    const truncated = truncateWellFormed(toWellFormedUnicode(text), 300);
    expect(truncated.length).toBe(299);
    expect(truncated).toBe("a".repeat(299));
  });

  it("truncates ASCII verbatim", () => {
    const ascii = "x".repeat(500);
    expect(truncateWellFormed(toWellFormedUnicode(ascii), 300).length).toBe(
      300,
    );
  });

  it("handles lone at boundary", () => {
    const loneAtBoundary =
      "a".repeat(299) + String.fromCharCode(0xd800) + "b".repeat(200);
    const result = truncateWellFormed(toWellFormedUnicode(loneAtBoundary), 300);
    expect(result.length).toBeLessThanOrEqual(300);
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});
