/**
 * Regression for surrogate-safe truncate in orchestrator posting preview.
 */
import { describe, expect, it } from "vitest";

function truncateWellFormed(text: string, maxLength: number): string {
  if (!Number.isFinite(maxLength) || maxLength <= 0) return "";
  if (text.length <= maxLength) return text;
  const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
  const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
  const end = isHigh(text.charCodeAt(maxLength - 1)) && isLow(text.charCodeAt(maxLength)) ? maxLength - 1 : maxLength;
  return text.slice(0, end);
}

describe("orchestrator posting truncate surrogate-safe", () => {
  it("does not split surrogate pair at boundary", () => {
    const text = `${"a".repeat(79)}🦊${"b".repeat(10)}`;
    const sliced = text.slice(0, 80);
    expect(sliced.length).toBe(80);
    expect(sliced.charCodeAt(79).toString(16)).toBe("d83e");
    const truncated = truncateWellFormed(text, 80);
    expect(truncated.length).toBe(79);
    expect(() => encodeURIComponent(truncated)).not.toThrow();
    expect(truncated).toBe("a".repeat(79));
  });
  it("truncateWellFormed keeps well-formed for astral at boundary", () => {
    const text = `${"x".repeat(79)}🦊`;
    expect(text.length).toBe(81);
    expect(truncateWellFormed(text, 80).length).toBe(79);
    expect(truncateWellFormed(`${"x".repeat(80)}`, 80).length).toBe(80);
  });
});
