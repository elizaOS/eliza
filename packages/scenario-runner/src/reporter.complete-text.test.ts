/** Tests complete scenario viewer text rendering without lossy normalization or truncation. */

import { describe, expect, it } from "vitest";
import { renderCompleteText } from "./reporter";

describe("renderCompleteText", () => {
  it("preserves long strings including distinguishing suffixes", () => {
    const input = `${"a".repeat(10_000)}complete-tail`;
    expect(renderCompleteText(input)).toBe(input);
  });

  it("preserves string code units instead of silently normalizing content", () => {
    const input = "before \ud800 after";
    expect(renderCompleteText(input)).toBe(input);
  });

  it("serializes complete non-string values", () => {
    const value = { text: `${"x".repeat(1_000)}object-tail` };
    expect(renderCompleteText(value)).toBe(JSON.stringify(value));
  });

  it("renders nullish values as empty text", () => {
    expect(renderCompleteText(null)).toBe("");
    expect(renderCompleteText(undefined)).toBe("");
  });
});
