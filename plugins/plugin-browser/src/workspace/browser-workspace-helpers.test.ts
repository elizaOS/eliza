/**
 * Browser workspace helper tests for URL, tab, and command utility behavior.
 */

import { describe, expect, it } from "vitest";
import {
  assertBrowserWorkspaceUrl,
  inferBrowserWorkspaceTitle,
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

describe("assertBrowserWorkspaceUrl", () => {
  it("passes about:blank through unchanged", () => {
    expect(assertBrowserWorkspaceUrl("about:blank")).toBe("about:blank");
    expect(assertBrowserWorkspaceUrl("  about:blank  ")).toBe("about:blank");
  });

  it("accepts http and https and normalizes via URL toString", () => {
    expect(assertBrowserWorkspaceUrl("https://example.com")).toBe(
      "https://example.com/",
    );
    expect(assertBrowserWorkspaceUrl("http://example.com/path?q=1")).toBe(
      "http://example.com/path?q=1",
    );
    expect(assertBrowserWorkspaceUrl("  https://example.com  ")).toBe(
      "https://example.com/",
    );
  });

  it("rejects non-http protocols", () => {
    expect(() => assertBrowserWorkspaceUrl("ftp://example.com")).toThrow();
    expect(() => assertBrowserWorkspaceUrl("ws://example.com")).toThrow();
    expect(() => assertBrowserWorkspaceUrl("file:///tmp/x")).toThrow();
    expect(() => assertBrowserWorkspaceUrl("javascript:alert(1)")).toThrow();
  });

  it("rejects malformed URLs", () => {
    expect(() => assertBrowserWorkspaceUrl("not a url")).toThrow();
    expect(() => assertBrowserWorkspaceUrl("http://")).toThrow();
    expect(() => assertBrowserWorkspaceUrl("")).toThrow();
    expect(() => assertBrowserWorkspaceUrl("   ")).toThrow();
  });
});

describe("inferBrowserWorkspaceTitle", () => {
  it("returns New Tab for about:blank", () => {
    expect(inferBrowserWorkspaceTitle("about:blank")).toBe("New Tab");
  });

  it("strips www and returns hostname", () => {
    expect(inferBrowserWorkspaceTitle("https://www.example.com/path")).toBe(
      "example.com",
    );
    expect(inferBrowserWorkspaceTitle("https://example.com/")).toBe(
      "example.com",
    );
    expect(inferBrowserWorkspaceTitle("https://sub.example.com/")).toBe(
      "sub.example.com",
    );
  });

  it("falls back to Eliza Browser for invalid or empty host", () => {
    expect(inferBrowserWorkspaceTitle("not a url")).toBe("Eliza Browser");
    expect(inferBrowserWorkspaceTitle("")).toBe("Eliza Browser");
    expect(inferBrowserWorkspaceTitle("https://")).toBe("Eliza Browser");
  });
});
