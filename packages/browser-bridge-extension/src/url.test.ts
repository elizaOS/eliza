/**
 * Unit tests for the URL normalization helpers, including rejection of unsafe
 * URL forms (credentials, non-http schemes).
 */
import { describe, expect, it } from "vitest";
import {
  normalizeHostForComparison,
  normalizeHttpBaseUrl,
  normalizeHttpOrigin,
  normalizeNavigableUrl,
  normalizeNavigableUrlForHost,
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
    expect(normalizeNavigableUrl("example.com:443/path")).toBe(
      "https://example.com/path",
    );
    expect(normalizeNavigableUrl("localhost:3000/path")).toBe(
      "https://localhost:3000/path",
    );
  });

  it("returns null for explicit non-http schemes so they never reach location.href", () => {
    // The block interstitial's `?url=` query param is attacker-controllable;
    // explicit schemes must not be force-prefixed into navigable https URLs.
    for (const value of [
      "javascript:alert(document.cookie)",
      "JavaScript:alert(1)",
      "javascript:foo@evil.example",
      "data:text/html,<script>alert(1)</script>",
      "mailto:foo@example.com",
      "file://evil.example/path",
      "vbscript:msgbox(1)",
      "httpx://not-really-http.example",
      "//evil.example.com",
    ]) {
      expect(normalizeNavigableUrl(value)).toBeNull();
    }
  });

  it("returns null for credentialed URLs", () => {
    for (const value of [
      "https://user:pass@example.com/path",
      "http://user@example.com/path",
      "user:pass@example.com/path",
    ]) {
      expect(normalizeNavigableUrl(value)).toBeNull();
    }
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
      expect(normalizeNavigableUrl(value)).toBeNull();
    }
  });
});

describe("normalizeNavigableUrlForHost", () => {
  it("allows redirects only when the normalized URL host matches the polled host", () => {
    expect(
      normalizeNavigableUrlForHost(
        "https://blocked.example/read",
        "blocked.example",
      ),
    ).toBe("https://blocked.example/read");
    expect(
      normalizeNavigableUrlForHost(
        "blocked.example:443/read",
        "https://blocked.example",
      ),
    ).toBe("https://blocked.example/read");
  });

  it("rejects host/url mismatches from attacker-controlled blocked-page query params", () => {
    expect(
      normalizeNavigableUrlForHost("https://evil.example", "blocked.example"),
    ).toBeNull();
    expect(
      normalizeNavigableUrlForHost(
        "https://blocked.example.evil.example",
        "blocked.example",
      ),
    ).toBeNull();
  });

  it("normalizes hosts to lowercase hostnames for comparison", () => {
    expect(normalizeHostForComparison("HTTPS://Example.COM:443/path")).toBe(
      "example.com",
    );
  });
});
