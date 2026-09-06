// Exercises redirect validation behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "vitest";
import {
  assertAllowedAbsoluteRedirectUrl,
  isAllowedAbsoluteRedirectUrl,
  isSafeRelativeRedirectPath,
  LOOPBACK_REDIRECT_ORIGINS,
  resolveOAuthSuccessRedirectUrl,
  resolveSafeRedirectTarget,
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

/**
 * The two resolvers below carry five production call sites between them and had
 * no test at all: every case in this file exercised the relative helpers or
 * `isAllowedAbsoluteRedirectUrl`. Dropping `parsed.origin === base.origin` from
 * `resolveSafeRedirectTarget` — the entire open-redirect guard for that
 * function — left the suite green.
 */

const BASE = "https://app.eliza.ai";
const FALLBACK = "/home";

describe("resolveSafeRedirectTarget", () => {
  test("returns an absolute URL only when it is same-origin", () => {
    expect(resolveSafeRedirectTarget(`${BASE}/settings`, BASE, FALLBACK).toString()).toBe(
      `${BASE}/settings`,
    );
    // The guard. Without it this returns the attacker's URL.
    expect(resolveSafeRedirectTarget("https://evil.example/steal", BASE, FALLBACK).toString()).toBe(
      `${BASE}${FALLBACK}`,
    );
  });

  test.each([
    ["a sibling host that merely shares a suffix", "https://evil-app.eliza.ai/x"],
    ["the same host on a different scheme", "http://app.eliza.ai/x"],
    ["the same host on a different port", "https://app.eliza.ai:8443/x"],
    ["embedded credentials on the allowed origin", "https://user:pw@app.eliza.ai/x"],
    ["a non-http scheme", "javascript:alert(1)"],
    ["a protocol-relative target", "//evil.example/x"],
    ["an unparseable value", "http://[::1"],
  ])("falls back for %s", (_label, value) => {
    expect(resolveSafeRedirectTarget(value, BASE, FALLBACK).toString()).toBe(`${BASE}${FALLBACK}`);
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
  ])("falls back for %s without treating it as a path", (_label, value) => {
    expect(resolveSafeRedirectTarget(value, BASE, FALLBACK).toString()).toBe(`${BASE}${FALLBACK}`);
  });

  test("resolves a relative path against the base rather than the caller's string", () => {
    expect(resolveSafeRedirectTarget("/agents/1", BASE, FALLBACK).toString()).toBe(
      `${BASE}/agents/1`,
    );
  });
});

describe("resolveOAuthSuccessRedirectUrl", () => {
  const resolve = (value: string | null | undefined, origins: readonly string[] = []) =>
    resolveOAuthSuccessRedirectUrl({
      value,
      baseUrl: BASE,
      fallbackPath: FALLBACK,
      allowedAbsoluteOrigins: origins,
    });

  test("accepts same-origin and allowlisted absolute targets", () => {
    expect(resolve(`${BASE}/done`)).toEqual({
      target: new URL(`${BASE}/done`),
      rejected: false,
    });
    expect(resolve("https://desktop.eliza.ai/cb", ["https://desktop.eliza.ai"])).toEqual({
      target: new URL("https://desktop.eliza.ai/cb"),
      rejected: false,
    });
  });

  test("an absent value is a fallback but NOT a rejection", () => {
    // `rejected` is what callers log a refusal on, so the two branches that
    // both return the fallback have to stay distinguishable.
    expect(resolve(null)).toEqual({ target: new URL(BASE + FALLBACK), rejected: false });
    expect(resolve("/done")).toEqual({ target: new URL(`${BASE}/done`), rejected: false });
    expect(resolve("https://evil.example/x").rejected).toBe(true);
  });

  test.each([
    ["an origin absent from the allowlist", "https://evil.example/x", []],
    [
      "an allowlisted host on another scheme",
      "http://desktop.eliza.ai/cb",
      ["https://desktop.eliza.ai"],
    ],
    [
      "credentials smuggled onto an allowlisted origin",
      "https://u:p@desktop.eliza.ai/cb",
      ["https://desktop.eliza.ai"],
    ],
    ["a non-http scheme", "javascript:alert(1)", ["https://desktop.eliza.ai"]],
  ])("rejects %s", (_label, value, origins) => {
    expect(resolve(value, origins as string[])).toEqual({
      target: new URL(BASE + FALLBACK),
      rejected: true,
    });
  });

  test("the loopback entries match any port, and only loopback hosts", () => {
    const origins = [...LOOPBACK_REDIRECT_ORIGINS];
    for (const accepted of [
      "http://localhost:3000/cb",
      "http://127.0.0.1:54321/cb",
      "https://localhost:8443/cb",
      "https://127.0.0.1:9443/cb",
    ]) {
      expect(resolve(accepted, origins).rejected).toBe(false);
    }
    // The wildcard is expanded into a regex, so a host that merely starts with
    // the loopback name must not match it.
    expect(resolve("http://localhost.evil.example:3000/cb", origins).rejected).toBe(true);
    expect(resolve("http://127.0.0.1.evil.example:3000/cb", origins).rejected).toBe(true);
  });
});
