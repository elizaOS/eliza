/**
 * Exercises truncateEvidence suffix reservation: payload must not exceed advertised max.
 */
import { describe, expect, it } from "vitest";
import { truncateEvidence } from "./types";

describe("truncateEvidence", () => {
  it("never exceeds max inclusive of suffix", () => {
    const out = truncateEvidence("a".repeat(200), 120);
    expect(out.length).toBe(120);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns original when under cap", () => {
    expect(truncateEvidence("hello", 120)).toBe("hello");
    expect(truncateEvidence("hello", 5)).toBe("hello");
  });

  it("handles small max correctly", () => {
    expect(truncateEvidence("hello world", 5).length).toBe(5);
    expect(truncateEvidence("hello world", 5).endsWith("…")).toBe(true);
    expect(truncateEvidence("hi", 5)).toBe("hi");
  });

  it("handles max=1 edge", () => {
    const out = truncateEvidence("hello", 1);
    expect(out.length).toBe(1);
    expect(out).toBe("…");
  });
});
