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
    const longLine = "x".repeat(500);
    const evidence = truncateEvidence(`field: ${JSON.stringify(longLine)}`, 120);
    expect(evidence.length).toBeLessThanOrEqual(120);
    expect(evidence.endsWith("…")).toBe(true);
  });

  it("max=1 edge returns single ellipsis", () => {
    expect(truncateEvidence("hello world", 1)).toBe("…");
    expect(truncateEvidence("hello world", 1).length).toBe(1);
  });

  it("previous bug would overflow by one", () => {
    const long = "b".repeat(200);
    const beforeFix = `${long.slice(0, 120)}…`;
    expect(beforeFix.length).toBe(121);
    const afterFix = truncateEvidence(long, 120);
    expect(afterFix.length).toBe(120);
    expect(afterFix).not.toBe(beforeFix);
  });

  it("empty and short inputs are unchanged", () => {
    expect(truncateEvidence("", 120)).toBe("");
    expect(truncateEvidence("hi", 10)).toBe("hi");
    expect(truncateEvidence("a".repeat(5), 5)).toBe("a".repeat(5));
  });

  it("max=2 reserves suffix correctly", () => {
    expect(truncateEvidence("hello world", 2)).toBe("h…");
    expect(truncateEvidence("hello world", 2).length).toBe(2);
  });

  it("never splits surrogate pairs at the truncation boundary", () => {
    const text = `${"a".repeat(118)}🦊${"b".repeat(50)}`;
    const truncated = truncateEvidence(text, 120);
    expect(truncated.isWellFormed()).toBe(true);
    expect(truncated).toBe(`${"a".repeat(118)}…`);
    expect(truncated.length).toBe(119);
  });

  it("sanitizes lone surrogates before truncation", () => {
    const text = `bad ${String.fromCharCode(0xd800)} evidence`;
    const truncated = truncateEvidence(text, 120);
    expect(truncated.isWellFormed()).toBe(true);
    expect(truncated).toBe("bad \uFFFD evidence");
  });

  it("preserves fitting emoji without truncation", () => {
    const text = "safe 🦊";
    const truncated = truncateEvidence(text, 120);
    expect(truncated).toBe("safe 🦊");
    expect(truncated.isWellFormed()).toBe(true);
  });
});
