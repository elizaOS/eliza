import { describe, expect, it } from "vitest";
import { truncateMessageForDisplay } from "./browser-wallet-consent-format.ts";

describe("truncateMessageForDisplay", () => {
  it("returns short messages unchanged", () => {
    expect(truncateMessageForDisplay("hello", 240)).toBe("hello");
  });

  it("truncates long messages with a counter", () => {
    const long = "x".repeat(300);
    const result = truncateMessageForDisplay(long, 240);
    expect(result).toContain("…");
    expect(result).toContain("60 more chars");
    expect(result.length).toBeLessThan(long.length);
  });

  it("uses the default max of 240", () => {
    const long = "x".repeat(500);
    const result = truncateMessageForDisplay(long);
    expect(result).toContain("260 more chars");
  });

  it("handles max === 1 without losing the first character", () => {
    const result = truncateMessageForDisplay("abcdef", 1);
    expect(result.startsWith("a…")).toBe(true);
  });

  it("handles max <= 0 without producing an empty display", () => {
    const result = truncateMessageForDisplay("abcdef", 0);
    expect(result.length).toBeGreaterThan(0);
    expect(result.startsWith("…")).toBe(false);
  });

  it("handles max <= 0 for long messages", () => {
    const long = "x".repeat(100);
    const result = truncateMessageForDisplay(long, -5);
    expect(result.length).toBeGreaterThan(0);
  });
});
