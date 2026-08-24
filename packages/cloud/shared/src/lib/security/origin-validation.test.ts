import { describe, expect, test } from "vitest";

import { isAllowedOrigin, normalizeOrigin } from "./origin-validation";

describe("normalizeOrigin", () => {
  test("returns null for empty and whitespace", () => {
    expect(normalizeOrigin("")).toBeNull();
    expect(normalizeOrigin("   ")).toBeNull();
    expect(normalizeOrigin("\t\n")).toBeNull();
  });

  test("trims surrounding whitespace", () => {
    expect(normalizeOrigin("  https://example.com  ")).toBe("https://example.com");
    expect(normalizeOrigin("\nhttps://example.com/path\n")).toBe("https://example.com");
  });

  test("rejects non-http protocols", () => {
    expect(normalizeOrigin("ftp://example.com")).toBeNull();
    expect(normalizeOrigin("javascript:alert(1)")).toBeNull();
    expect(normalizeOrigin("data:text/plain,hello")).toBeNull();
    expect(normalizeOrigin("ws://example.com")).toBeNull();
  });

  test("rejects malformed urls", () => {
    expect(normalizeOrigin("not a url")).toBeNull();
    expect(normalizeOrigin("https://")).toBeNull();
    expect(normalizeOrigin("://example.com")).toBeNull();
  });

  test("strips path query and hash to origin", () => {
    expect(normalizeOrigin("https://example.com/some/path?q=1#hash")).toBe("https://example.com");
    expect(normalizeOrigin("https://example.com/a/b/c?x=1&y=2#frag")).toBe("https://example.com");
    expect(normalizeOrigin("http://localhost:3000/api?x=1")).toBe("http://localhost:3000");
  });

  test("preserves explicit port in origin", () => {
    expect(normalizeOrigin("https://example.com:8080/path")).toBe("https://example.com:8080");
    expect(normalizeOrigin("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(normalizeOrigin("https://example.com:8443")).toBe("https://example.com:8443");
  });

  test("normalizes default ports away via URL origin", () => {
    expect(normalizeOrigin("http://example.com:80/")).toBe("http://example.com");
    expect(normalizeOrigin("https://example.com:443/path")).toBe("https://example.com");
  });

  test("lowercases hostname via URL", () => {
    expect(normalizeOrigin("https://EXAMPLE.COM/path")).toBe("https://example.com");
    expect(normalizeOrigin("https://ExAmPlE.CoM:8080/")).toBe("https://example.com:8080");
  });

  test("handles trailing slash consistently", () => {
    expect(normalizeOrigin("https://example.com/")).toBe("https://example.com");
    expect(normalizeOrigin("https://example.com")).toBe("https://example.com");
  });
});

describe("isAllowedOrigin", () => {
  test("returns false for invalid candidate", () => {
    expect(isAllowedOrigin(["https://example.com"], "")).toBe(false);
    expect(isAllowedOrigin(["https://example.com"], "not a url")).toBe(false);
    expect(isAllowedOrigin(["https://example.com"], "ftp://example.com")).toBe(false);
    expect(isAllowedOrigin(["https://example.com"], "   ")).toBe(false);
  });

  test("returns false for empty allowlist", () => {
    expect(isAllowedOrigin([], "https://example.com")).toBe(false);
    expect(isAllowedOrigin(["   ", ""], "https://example.com")).toBe(false);
  });

  test("star wildcard allows any valid origin", () => {
    expect(isAllowedOrigin(["*"], "https://example.com")).toBe(true);
    expect(isAllowedOrigin(["*"], "http://localhost:3000")).toBe(true);
    expect(isAllowedOrigin(["   *   "], "https://a.com/path?q=1")).toBe(true);
    expect(isAllowedOrigin(["*"], "not a url")).toBe(false);
  });

  test("exact origin match after normalization", () => {
    expect(isAllowedOrigin(["https://example.com"], "https://example.com")).toBe(true);
    expect(isAllowedOrigin(["https://example.com/"], "https://example.com")).toBe(true);
    expect(isAllowedOrigin(["https://example.com/path"], "https://example.com")).toBe(true);
    expect(isAllowedOrigin(["https://example.com"], "https://example.com/")).toBe(true);
    expect(isAllowedOrigin(["https://example.com"], "https://other.com")).toBe(false);
  });

  test("trims allowlist entries and skips empties", () => {
    expect(isAllowedOrigin(["  https://example.com  ", ""], "https://example.com")).toBe(true);
    expect(isAllowedOrigin(["", "   ", "https://a.com"], "https://a.com")).toBe(true);
  });

  test("case-insensitive matching", () => {
    expect(isAllowedOrigin(["https://EXAMPLE.com"], "https://example.com")).toBe(true);
    expect(isAllowedOrigin(["https://example.com"], "https://EXAMPLE.COM")).toBe(true);
    expect(isAllowedOrigin(["HTTPS://EXAMPLE.COM"], "https://example.com/path")).toBe(true);
  });

  test("wildcard subdomain matches subdomains but not apex or evil", () => {
    expect(isAllowedOrigin(["https://*.example.com"], "https://foo.example.com")).toBe(true);
    expect(isAllowedOrigin(["https://*.example.com"], "https://a.b.example.com")).toBe(true);
    expect(isAllowedOrigin(["https://*.example.com"], "https://example.com")).toBe(false);
    expect(isAllowedOrigin(["https://*.example.com"], "https://evil.com")).toBe(false);
    expect(isAllowedOrigin(["https://*.example.com"], "https://evil-example.com")).toBe(false);
    expect(isAllowedOrigin(["https://*.example.com"], "https://foo.evil.com")).toBe(false);
  });

  test("wildcard with path strips path before matching", () => {
    expect(isAllowedOrigin(["https://*.example.com/ignored/path"], "https://sub.example.com")).toBe(
      true,
    );
    expect(isAllowedOrigin(["https://*.example.com/path?q=1"], "https://x.example.com/any")).toBe(
      true,
    );
  });

  test("wildcard is case-insensitive", () => {
    expect(isAllowedOrigin(["https://*.EXAMPLE.COM"], "https://Foo.Example.com")).toBe(true);
    expect(isAllowedOrigin(["https://*.example.com"], "https://FOO.EXAMPLE.COM/path")).toBe(true);
  });

  test("multiple allowlist entries any match wins", () => {
    const allow = ["https://a.com", "https://*.b.com", "https://c.com/path"];
    expect(isAllowedOrigin(allow, "https://a.com")).toBe(true);
    expect(isAllowedOrigin(allow, "https://x.b.com")).toBe(true);
    expect(isAllowedOrigin(allow, "https://c.com")).toBe(true);
    expect(isAllowedOrigin(allow, "https://d.com")).toBe(false);
  });

  test("port handling in candidate and allowlist", () => {
    expect(isAllowedOrigin(["https://example.com:8080"], "https://example.com:8080")).toBe(true);
    expect(isAllowedOrigin(["https://example.com:8080"], "https://example.com")).toBe(false);
    expect(isAllowedOrigin(["https://example.com"], "https://example.com:8080")).toBe(false);
  });

  test("candidate path is ignored via normalization", () => {
    expect(
      isAllowedOrigin(["https://example.com"], "https://example.com/some/path?query=1#hash"),
    ).toBe(true);
    expect(isAllowedOrigin(["https://example.com/path"], "https://example.com/other?x=1")).toBe(
      true,
    );
  });

  test("handles http vs https distinction", () => {
    expect(isAllowedOrigin(["https://example.com"], "http://example.com")).toBe(false);
    expect(isAllowedOrigin(["http://example.com"], "https://example.com")).toBe(false);
    expect(
      isAllowedOrigin(["https://example.com", "http://example.com"], "http://example.com"),
    ).toBe(true);
  });
});
