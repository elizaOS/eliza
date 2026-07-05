/**
 * Unit tests for the URL normalization helpers, including rejection of unsafe
 * URL forms (credentials, non-http schemes).
 */
import { describe, expect, it } from "vitest";
import {
  normalizeHttpBaseUrl,
  normalizeHttpOrigin,
  normalizeNavigableUrl,
} from "./url";

describe("normalizeHttpBaseUrl", () => {
  it("normalizes http URLs by trimming, stripping query/fragment, and removing trailing slashes", () => {
    expect(
      normalizeHttpBaseUrl(" https://agent.example.com/api///?debug=1#top "),
    ).toBe("https://agent.example.com/api");
  });

  it("uses the provided default for blank input and rejects unsafe URL forms", () => {
    expect(normalizeHttpBaseUrl("   ", "http://127.0.0.1:31337")).toBe(
      "http://127.0.0.1:31337",
    );
    for (const value of [
      "javascript:alert(1)",
      "file:///tmp/socket",
      "https://user:pass@agent.example.com",
      "not a url",
    ]) {
      expect(normalizeHttpBaseUrl(value)).toBeNull();
    }
  });
});

describe("normalizeHttpOrigin", () => {
  it("keeps only the safe origin for http URLs", () => {
    expect(normalizeHttpOrigin("http://localhost:2138/path?debug=1#top")).toBe(
      "http://localhost:2138",
    );
    expect(normalizeHttpOrigin("https://agent.example.com/app")).toBe(
      "https://agent.example.com",
    );
  });

  it("rejects missing, credentialed, non-http, and malformed origins", () => {
    for (const value of [
      null,
      undefined,
      "ftp://agent.example.com",
      "https://user:pass@agent.example.com",
      "not a url",
    ]) {
      expect(normalizeHttpOrigin(value)).toBeNull();
    }
  });
});

describe("normalizeNavigableUrl", () => {
  it("keeps a full http(s) blocked-site URL, preserving path and query", () => {
    expect(normalizeNavigableUrl("https://example.com/read?id=7")).toBe(
      "https://example.com/read?id=7",
    );
    expect(normalizeNavigableUrl("http://intra.example/page")).toBe(
      "http://intra.example/page",
    );
  });

  it("upgrades a scheme-less host to https", () => {
    expect(normalizeNavigableUrl("example.com")).toBe("https://example.com/");
    expect(normalizeNavigableUrl("  news.example.com/top  ")).toBe(
      "https://news.example.com/top",
    );
  });

  it("returns null for a javascript: payload so it never reaches location.href", () => {
    // The block interstitial's `?url=` query param is attacker-controllable;
    // a `javascript:` scheme must not be force-prefixed into a navigable value.
    expect(
      normalizeNavigableUrl("javascript:alert(document.cookie)"),
    ).toBeNull();
    expect(normalizeNavigableUrl("JavaScript:alert(1)")).toBeNull();
    expect(
      normalizeNavigableUrl("data:text/html,<script>alert(1)</script>"),
    ).toBeNull();
    expect(normalizeNavigableUrl("vbscript:msgbox(1)")).toBeNull();
  });

  it("returns null for empty or blank input", () => {
    for (const value of [null, undefined, "", "   "]) {
      expect(normalizeNavigableUrl(value)).toBeNull();
    }
  });

  it("never yields a non-http(s) scheme for any hostile input (the security invariant)", () => {
    // The one property the navigation sink relies on: the result is always
    // either null or an http/https URL. A `file:`/`javascript:`/`data:` scheme
    // can never survive to be assigned to `window.location.href`.
    for (const value of [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "vbscript:msgbox(1)",
      "httpx://not-really-http.example",
      "//evil.example.com",
      "\tjavascript:alert(1)",
    ]) {
      const result = normalizeNavigableUrl(value);
      if (result !== null) {
        expect(result).toMatch(/^https?:\/\//);
      }
    }
  });
});
