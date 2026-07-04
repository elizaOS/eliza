// Exercises redirect validation behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "vitest";
import {
  assertAllowedAbsoluteRedirectUrl,
  isAllowedAbsoluteRedirectUrl,
  isSafeRelativeRedirectPath,
  sanitizeRelativeRedirectPath,
} from "./redirect-validation";

/**
 * Open-redirect prevention. Relative paths must start with a single "/" (reject
 * "//host" protocol-relative redirects); absolute URLs must be http(s), carry
 * no embedded credentials, and match the origin allowlist. A miss here lets an
 * attacker bounce an authenticated user to a hostile site.
 */

const ALLOW = ["https://eliza.ai"];

describe("relative redirect paths", () => {
  test("isSafeRelativeRedirectPath rejects protocol-relative + absolute", () => {
    expect(isSafeRelativeRedirectPath("/dashboard")).toBe(true);
    expect(isSafeRelativeRedirectPath("//evil.com")).toBe(false); // protocol-relative
    expect(isSafeRelativeRedirectPath("https://evil.com")).toBe(false);
    expect(isSafeRelativeRedirectPath("relative")).toBe(false);
  });

  test("sanitizeRelativeRedirectPath falls back on unsafe/empty", () => {
    expect(sanitizeRelativeRedirectPath("/ok", "/home")).toBe("/ok");
    expect(sanitizeRelativeRedirectPath("//evil", "/home")).toBe("/home");
    expect(sanitizeRelativeRedirectPath(null, "/home")).toBe("/home");
    expect(sanitizeRelativeRedirectPath("https://evil", "/home")).toBe("/home");
  });
});

describe("absolute redirect URLs", () => {
  test("only allows http(s), credential-free, allowlisted origins", () => {
    expect(isAllowedAbsoluteRedirectUrl("https://eliza.ai/dash", ALLOW)).toBe(true);
    expect(isAllowedAbsoluteRedirectUrl("https://evil.com/", ALLOW)).toBe(false);
    // embedded credentials are rejected even on an allowed host.
    expect(isAllowedAbsoluteRedirectUrl("https://user:pass@eliza.ai/", ALLOW)).toBe(false);
    expect(isAllowedAbsoluteRedirectUrl("javascript:alert(1)", ALLOW)).toBe(false);
    expect(isAllowedAbsoluteRedirectUrl("not a url", ALLOW)).toBe(false);
  });

  test("assertAllowedAbsoluteRedirectUrl returns URL or throws", () => {
    expect(assertAllowedAbsoluteRedirectUrl("https://eliza.ai/x", ALLOW).hostname).toBe("eliza.ai");
    expect(() => assertAllowedAbsoluteRedirectUrl("https://evil.com/", ALLOW)).toThrow(/Invalid/);
  });
});
