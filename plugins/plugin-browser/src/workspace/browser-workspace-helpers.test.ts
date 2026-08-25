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
  it("accepts about:blank without modification", () => {
    expect(assertBrowserWorkspaceUrl("about:blank")).toBe("about:blank");
    expect(assertBrowserWorkspaceUrl("  about:blank  ")).toBe("about:blank");
  });

  it("accepts valid http and https URLs and normalizes them", () => {
    expect(assertBrowserWorkspaceUrl("https://example.com")).toBe(
      "https://example.com/",
    );
    expect(assertBrowserWorkspaceUrl("http://localhost:3000/app")).toBe(
      "http://localhost:3000/app",
    );
  });

  it("rejects non-http/https protocols", () => {
    expect(() => assertBrowserWorkspaceUrl("javascript:alert(1)")).toThrow(
      /only supports http\/https URLs/,
    );
    expect(() => assertBrowserWorkspaceUrl("file:///etc/passwd")).toThrow(
      /only supports http\/https URLs/,
    );
    expect(() =>
      assertBrowserWorkspaceUrl("data:text/html,<h1>hi</h1>"),
    ).toThrow(/only supports http\/https URLs/);
  });

  it("rejects malformed URLs", () => {
    expect(() => assertBrowserWorkspaceUrl("not a url")).toThrow(
      /rejected invalid URL/,
    );
    expect(() => assertBrowserWorkspaceUrl("://missing-scheme")).toThrow(
      /rejected invalid URL/,
    );
  });
});

describe("inferBrowserWorkspaceTitle", () => {
  it("infers New Tab for about:blank", () => {
    expect(inferBrowserWorkspaceTitle("about:blank")).toBe("New Tab");
  });

  it("infers hostname stripped of leading www for web URLs", () => {
    expect(inferBrowserWorkspaceTitle("https://www.google.com/search")).toBe(
      "google.com",
    );
    expect(inferBrowserWorkspaceTitle("https://github.com/elizaOS/eliza")).toBe(
      "github.com",
    );
  });

  it("falls back to default title on invalid URLs", () => {
    expect(inferBrowserWorkspaceTitle("invalid url")).toBe("Eliza Browser");
  });
});
