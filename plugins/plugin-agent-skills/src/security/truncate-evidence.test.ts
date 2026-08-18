import { describe, expect, it } from "vitest";
import { truncateEvidence } from "./types";

describe("truncateEvidence", () => {
  it("returns evidence unchanged when under limit", () => {
    expect(truncateEvidence("hello", 10)).toBe("hello");
  });

  it("returns evidence unchanged when exactly at limit", () => {
    expect(truncateEvidence("hello", 5)).toBe("hello");
  });

  it("truncates with ellipsis reserving 1 char", () => {
    const out = truncateEvidence("hello world", 5);
    expect(out).toBe("hell…");
    expect(out.length).toBe(5);
  });

  it("does not exceed maxLen after truncation", () => {
    const big = "a".repeat(200);
    const out = truncateEvidence(big, 120);
    expect(out.length).toBe(120);
    expect(out.endsWith("…")).toBe(true);
  });

  it("handles limit 0 → empty", () => {
    expect(truncateEvidence("hello", 0)).toBe("");
  });

  it("handles limit 1 → single ellipsis", () => {
    expect(truncateEvidence("hello", 1)).toBe("…");
  });

  it("trims trailing whitespace before ellipsis", () => {
    expect(truncateEvidence("hello   world", 6)).toBe("hello…");
  });

  it("handles non-finite and negative limits as 0", () => {
    expect(truncateEvidence("hello", NaN as unknown as number)).toBe("");
    expect(truncateEvidence("hello", -5)).toBe("");
    expect(truncateEvidence("hello", Infinity as unknown as number)).toBe("");
  });

  it("preserves short evidence with spaces", () => {
    expect(truncateEvidence("a b c", 10)).toBe("a b c");
  });
});
