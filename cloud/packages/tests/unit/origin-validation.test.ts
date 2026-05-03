import { describe, expect, test } from "bun:test";
import { isAllowedOrigin, normalizeOrigin } from "@/lib/security/origin-validation";

describe("origin validation", () => {
  test("normalizes full URLs to their origin", () => {
    expect(normalizeOrigin("https://app.example.com/callback?foo=bar")).toBe(
      "https://app.example.com",
    );
  });

  test("matches allowlist entries stored as full callback URLs", () => {
    expect(
      isAllowedOrigin(
        ["https://app.example.com/oauth/callback"],
        "https://app.example.com/redirect",
      ),
    ).toBe(true);
  });

  test("matches wildcard subdomain origins", () => {
    expect(isAllowedOrigin(["https://*.example.com"], "https://tenant.example.com/callback")).toBe(
      true,
    );
  });

  test("rejects unregistered redirect URIs", () => {
    expect(isAllowedOrigin(["https://app.example.com"], "https://evil.example.net/callback")).toBe(
      false,
    );
  });

  test("rejects invalid protocols", () => {
    expect(isAllowedOrigin(["https://app.example.com"], "javascript:alert(1)")).toBe(false);
  });
});
