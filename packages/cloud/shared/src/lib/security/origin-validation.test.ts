/**
 * Behavioral coverage for shared origin validation helpers.
 *
 * `normalizeOrigin` reduces URL-like values to their http(s) origin so
 * callers can compare browser Origin headers, Referer URLs, redirect URIs,
 * and stored allowlist entries on equal footing. `isAllowedOrigin` applies
 * the allowlist, supporting exact origins, path-bearing entries, wildcard
 * subdomains (`https://*.example.com`), and a bare `*` entry.
 */
import { describe, expect, test } from "bun:test";
import { isAllowedOrigin, normalizeOrigin } from "./origin-validation";

describe("normalizeOrigin", () => {
  test("reduces a full URL to its origin", () => {
    expect(normalizeOrigin("https://example.com/path?q=1#frag")).toBe(
      "https://example.com",
    );
    expect(normalizeOrigin("https://sub.example.com:8443/x")).toBe(
      "https://sub.example.com:8443",
    );
  });

  test("trims surrounding whitespace", () => {
    expect(normalizeOrigin("  https://example.com  ")).toBe("https://example.com");
  });

  test("rejects non-http(s) protocols", () => {
    expect(normalizeOrigin("ftp://example.com")).toBeNull();
    expect(normalizeOrigin("javascript:alert(1)")).toBeNull();
    expect(normalizeOrigin("data:text/plain,hi")).toBeNull();
  });

  test("rejects empty and unparsable values", () => {
    expect(normalizeOrigin("")).toBeNull();
    expect(normalizeOrigin("   ")).toBeNull();
    expect(normalizeOrigin("not a url")).toBeNull();
    expect(normalizeOrigin("example.com")).toBeNull();
  });
});

describe("isAllowedOrigin", () => {
  test("matches an exact origin against a path-bearing candidate", () => {
    expect(
      isAllowedOrigin(["https://app.eliza.example"], "https://app.eliza.example/some/path"),
    ).toBe(true);
  });

  test("matches a wildcard subdomain origin", () => {
    expect(isAllowedOrigin(["https://*.example.com"], "https://tenant.example.com")).toBe(true);
    expect(isAllowedOrigin(["https://*.example.com"], "https://a.b.example.com")).toBe(true);
  });

  test("wildcard subdomain origins do not match the bare apex", () => {
    expect(isAllowedOrigin(["https://*.example.com"], "https://example.com")).toBe(false);
  });

  test("a bare * allowlist entry accepts any http(s) origin", () => {
    expect(isAllowedOrigin(["*"], "https://anything.example")).toBe(true);
    expect(isAllowedOrigin(["*"], "http://localhost:3000")).toBe(true);
  });

  test("allowlist entries that include paths are normalized to origins", () => {
    expect(isAllowedOrigin(["https://example.com/callback"], "https://example.com/other")).toBe(
      true,
    );
  });

  test("rejects candidates that are not valid http(s) origins", () => {
    expect(isAllowedOrigin(["https://example.com"], "not-a-url")).toBe(false);
    expect(isAllowedOrigin(["https://example.com"], "")).toBe(false);
    expect(isAllowedOrigin(["https://example.com"], "ftp://example.com")).toBe(false);
  });

  test("rejects non-matching origins", () => {
    expect(isAllowedOrigin(["https://example.com"], "https://evil.example")).toBe(false);
    expect(isAllowedOrigin(["https://example.com"], "https://example.com:8080")).toBe(false);
  });

  test("skips blank allowlist entries", () => {
    expect(isAllowedOrigin(["", "   ", "https://example.com"], "https://example.com")).toBe(true);
  });
});
