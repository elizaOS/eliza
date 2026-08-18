/**
 * Exercises truncateForPreview suffix reservation: payload must not exceed advertised max.
 */
import { describe, expect, it } from "vitest";
import { truncateForPreview } from "./format";

describe("truncateForPreview", () => {
  it("never exceeds max inclusive of suffix", () => {
    const text = "a".repeat(100);
    const out = truncateForPreview(text, 10);
    expect(out.length).toBe(10);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns original when under cap", () => {
    expect(truncateForPreview("hello", 10)).toBe("hello");
    expect(truncateForPreview("hello", 5)).toBe("hello");
  });

  it("handles small max correctly", () => {
    expect(truncateForPreview("hello world", 5).length).toBe(5);
    expect(truncateForPreview("hello world", 5).endsWith("…")).toBe(true);
    expect(truncateForPreview("hi", 5)).toBe("hi");
  });

  it("handles max=1 edge", () => {
    const out = truncateForPreview("abc", 1);
    expect(out.length).toBe(1);
    expect(out).toBe("…");
  });
});
