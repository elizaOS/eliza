/**
 * Browser workspace helper tests for URL, tab, and command utility behavior.
 */

import { describe, expect, it } from "vitest";
import {
  normalizeBrowserWorkspaceText,
  parseBrowserWorkspaceNumberLike,
} from "./browser-workspace-helpers";

/**
 * Tests for the browser-workspace input helpers (#10333 / #8801). These coerce
 * untrusted command arguments (numbers, text) the browser bridge acts on, and
 * were untested.
 */
describe("parseBrowserWorkspaceNumberLike", () => {
  it("passes a finite number through", () => {
    expect(parseBrowserWorkspaceNumberLike(42)).toBe(42);
    expect(parseBrowserWorkspaceNumberLike(0)).toBe(0);
    expect(parseBrowserWorkspaceNumberLike(-3.5)).toBe(-3.5);
  });

  it("parses a numeric string (trimmed) and a leading-number string", () => {
    expect(parseBrowserWorkspaceNumberLike("  12.5 ")).toBe(12.5);
    expect(parseBrowserWorkspaceNumberLike("100")).toBe(100);
    expect(parseBrowserWorkspaceNumberLike("12px")).toBe(12); // parseFloat semantics
  });

  it("returns undefined for non-finite, non-numeric, or non-string/number input", () => {
    expect(parseBrowserWorkspaceNumberLike(Number.NaN)).toBeUndefined();
    expect(
      parseBrowserWorkspaceNumberLike(Number.POSITIVE_INFINITY),
    ).toBeUndefined();
    expect(parseBrowserWorkspaceNumberLike("abc")).toBeUndefined();
    expect(parseBrowserWorkspaceNumberLike("")).toBeUndefined();
    expect(parseBrowserWorkspaceNumberLike(null)).toBeUndefined();
    expect(parseBrowserWorkspaceNumberLike({})).toBeUndefined();
  });
});

describe("normalizeBrowserWorkspaceText", () => {
  it("collapses whitespace runs to single spaces and trims", () => {
    expect(normalizeBrowserWorkspaceText("  hello   world \n\t ")).toBe(
      "hello world",
    );
  });

  it("stringifies null/undefined to empty and coerces non-strings", () => {
    expect(normalizeBrowserWorkspaceText(null)).toBe("");
    expect(normalizeBrowserWorkspaceText(undefined)).toBe("");
    expect(normalizeBrowserWorkspaceText(42)).toBe("42");
  });
});
