/**
 * Coverage for origin-validation.
 */
import { describe, expect, it } from "vitest";
import { isAllowedOrigin, normalizeOrigin } from "./origin-validation.js";

describe("origin-validation", () => {
  it("normalizes valid origins", () => {
    expect(normalizeOrigin("https://example.com/path?x=1")).toBe("https://example.com");
    expect(normalizeOrigin("http://a.b:3000/")).toBe("http://a.b:3000");
  });
  it("rejects non-http", () => {
    expect(normalizeOrigin("ftp://example.com")).toBe(null);
    expect(normalizeOrigin("   ")).toBe(null);
    expect(normalizeOrigin("not-a-url")).toBe(null);
  });
  it("allows exact match", () => {
    expect(isAllowedOrigin(["https://example.com"], "https://example.com")).toBe(true);
    expect(isAllowedOrigin(["https://example.com"], "https://evil.com")).toBe(false);
  });
  it("handles wildcard", () => {
    expect(isAllowedOrigin(["*"], "https://any.com")).toBe(true);
    expect(isAllowedOrigin(["https://*.example.com"], "https://sub.example.com")).toBe(true);
    expect(isAllowedOrigin(["https://*.example.com"], "https://example.com")).toBe(false);
  });
  it("handles path in allowlist", () => {
    expect(isAllowedOrigin(["https://example.com/some/path"], "https://example.com/other")).toBe(
      true,
    );
  });
});
