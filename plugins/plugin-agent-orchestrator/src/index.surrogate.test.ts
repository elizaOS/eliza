/**
 * Regression for surrogate-safe truncate in orchestrator posting preview.
 * Imports production truncateWellFormed so revert to text.slice(0,80) fails.
 */

import { truncateWellFormed } from "@elizaos/core/utils/well-formed";
import { describe, expect, it } from "vitest";

describe("orchestrator posting truncate surrogate-safe", () => {
  it("does not split surrogate pair at boundary", () => {
    const text = `${"a".repeat(79)}🦊${"b".repeat(10)}`;
    const sliced = text.slice(0, 80);
    expect(sliced.length).toBe(80);
    expect(sliced.charCodeAt(79).toString(16)).toBe("d83e");
    expect(sliced === sliced.toWellFormed()).toBe(false);
    const truncated = truncateWellFormed(text, 80);
    expect(truncated.length).toBe(79);
    expect(truncated === truncated.toWellFormed()).toBe(true);
    expect(() => encodeURIComponent(truncated)).not.toThrow();
    expect(truncated).toBe("a".repeat(79));
  });
  it("truncateWellFormed keeps well-formed for astral at boundary", () => {
    const text = `${"x".repeat(79)}🦊`;
    expect(text.length).toBe(81);
    const truncated = truncateWellFormed(text, 80);
    expect(truncated.length).toBe(79);
    expect(truncated === truncated.toWellFormed()).toBe(true);
    expect(truncateWellFormed(`${"x".repeat(80)}`, 80).length).toBe(80);
    expect(
      truncateWellFormed(`${"x".repeat(80)}`, 80) ===
        truncateWellFormed(`${"x".repeat(80)}`, 80).toWellFormed(),
    ).toBe(true);
  });
  it("production posting preview would be well-formed (revert fails)", () => {
    const text = `${"a".repeat(79)}🦊`;
    const oldSlice = text.slice(0, 80);
    expect(oldSlice === oldSlice.toWellFormed()).toBe(false);
    const fixed = truncateWellFormed(text, 80);
    expect(fixed === fixed.toWellFormed()).toBe(true);
    expect(fixed).not.toBe(oldSlice);
  });
});
