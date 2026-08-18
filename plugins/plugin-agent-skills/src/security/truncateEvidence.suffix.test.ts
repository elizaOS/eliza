/**
 * Skill truncateEvidence suffix-reserve — inclusive cap via scanner path.
 */
import { describe, expect, it } from "vitest";
import { truncateEvidence } from "./types.ts";

describe("truncateEvidence suffix-reserve", () => {
  it("never exceeds max and handles max<=0", () => {
    const long = "a".repeat(200);
    expect(truncateEvidence(long, 120).length).toBeLessThanOrEqual(120);
    expect(truncateEvidence(long, 120).endsWith("…")).toBe(true);
    expect(truncateEvidence(long, 1)).toBe("…");
    expect(truncateEvidence(long, 0)).toBe("");
    expect(truncateEvidence(long, -5)).toBe("");
    expect(truncateEvidence("short", 120)).toBe("short");
    expect(truncateEvidence("a".repeat(120), 120).length).toBe(120);
    expect(truncateEvidence("a".repeat(121), 120).length).toBe(120);
  });

  it("scanner consumer respects cap", async () => {
    // Simulate scanner's usage: evidence from a long line
    const longLine = "x".repeat(500);
    const evidence = truncateEvidence(`field: ${JSON.stringify(longLine)}`, 120);
    expect(evidence.length).toBeLessThanOrEqual(120);
    expect(evidence.endsWith("…")).toBe(true);
  });

  it("max=1 edge returns single ellipsis", () => {
    expect(truncateEvidence("hello world", 1)).toBe("…");
    expect(truncateEvidence("hello world", 1).length).toBe(1);
  });
});
