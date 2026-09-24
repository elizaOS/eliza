// Coverage for `sanitizeAuthResult`: the field whitelist and URL-scheme check
// applied to an adapter `triggerAuth()` response before it reaches the browser.
import { describe, expect, it } from "vitest";
import { sanitizeAuthResult } from "./coding-agents-auth-sanitize.js";

describe("sanitizeAuthResult", () => {
  it("keeps only browser-rendered fields from adapter auth results", () => {
    expect(
      sanitizeAuthResult({
        launched: true,
        url: "https://example.com/login",
        deviceCode: "ABCD-EFGH",
        instructions: "Open the URL and enter the code.",
        accessToken: "secret-token",
        refreshToken: "secret-refresh",
        nested: { token: "secret" },
      }),
    ).toEqual({
      launched: true,
      url: "https://example.com/login",
      deviceCode: "ABCD-EFGH",
      instructions: "Open the URL and enter the code.",
    });
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "mailto:owner@example.com",
    "not a url",
  ])("drops unsafe or malformed auth URLs: %s", (url) => {
    expect(
      sanitizeAuthResult({
        launched: true,
        url,
        instructions: "Use fallback instructions.",
      }),
    ).toEqual({
      launched: true,
      instructions: "Use fallback instructions.",
    });
  });

  it("allows http and https auth URLs", () => {
    expect(
      sanitizeAuthResult({ url: "http://localhost:1455/callback" }),
    ).toEqual({
      url: "http://localhost:1455/callback",
    });
    expect(sanitizeAuthResult({ url: "https://example.com/callback" })).toEqual(
      {
        url: "https://example.com/callback",
      },
    );
  });

  it("returns an empty object for non-object adapter results", () => {
    expect(sanitizeAuthResult(null)).toEqual({});
    expect(sanitizeAuthResult("https://example.com")).toEqual({});
  });
});
