// Exercises app url behavior with deterministic cloud-shared lib fixtures.

import { ElizaError } from "@elizaos/core";
import { describe, expect, test } from "vitest";
import { getAppHost, getAppUrl } from "./app-url";

/**
 * Coverage for the canonical app-origin resolver (#9145). getAppUrl is the
 * SIWE/redirect origin: it reads NEXT_PUBLIC_APP_URL, defaults to localhost,
 * prepends https:// when no scheme is present, and strips the trailing slash.
 * Pure over an explicit env. Was untested.
 */

describe("getAppUrl", () => {
  test("defaults to localhost when unset / empty / non-string", () => {
    expect(getAppUrl({})).toBe("http://localhost:3000");
    expect(getAppUrl({ NEXT_PUBLIC_APP_URL: "" })).toBe("http://localhost:3000");
    expect(getAppUrl({ NEXT_PUBLIC_APP_URL: 123 })).toBe("http://localhost:3000");
  });

  test("uses a configured absolute URL and strips the trailing slash", () => {
    expect(getAppUrl({ NEXT_PUBLIC_APP_URL: "https://app.eliza.how/" })).toBe(
      "https://app.eliza.how",
    );
    expect(getAppUrl({ NEXT_PUBLIC_APP_URL: "http://localhost:8787" })).toBe(
      "http://localhost:8787",
    );
  });

  test("prepends https:// when the configured value has no scheme", () => {
    expect(getAppUrl({ NEXT_PUBLIC_APP_URL: "app.eliza.how" })).toBe("https://app.eliza.how");
    expect(getAppUrl({ NEXT_PUBLIC_APP_URL: "app.eliza.how/auth" })).toBe(
      "https://app.eliza.how/auth",
    );
  });

  test("trims configuration and canonicalizes case-insensitive HTTP schemes", () => {
    expect(getAppUrl({ NEXT_PUBLIC_APP_URL: " HTTPS://APP.ELIZA.HOW/ " })).toBe(
      "https://app.eliza.how",
    );
    expect(getAppUrl({ NEXT_PUBLIC_APP_URL: "HTTP://LOCALHOST:8787/" })).toBe(
      "http://localhost:8787",
    );
    expect(getAppUrl({ NEXT_PUBLIC_APP_URL: "   " })).toBe("http://localhost:3000");
  });

  test.each([
    ["httpx://example.invalid", "unsupported-or-ambiguous-scheme"],
    ["ftp://example.invalid", "unsupported-or-ambiguous-scheme"],
    ["//example.invalid", "unsupported-or-ambiguous-scheme"],
    ["not a url", "malformed-url"],
    ["https://", "malformed-url"],
    ["https://user:secret@example.invalid", "embedded-credentials"],
  ])("rejects invalid configured application URL %s", (configured, reason) => {
    let thrown: unknown;
    try {
      getAppUrl({ NEXT_PUBLIC_APP_URL: configured });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ElizaError);
    expect(thrown).toMatchObject({
      code: "INVALID_APP_URL",
      context: { reason },
      severity: "fatal",
    });
    expect(JSON.stringify(thrown)).not.toContain("secret");
  });
});

describe("getAppHost", () => {
  test("returns the host (with port) of the resolved app URL", () => {
    expect(getAppHost({})).toBe("localhost:3000");
    expect(getAppHost({ NEXT_PUBLIC_APP_URL: "https://app.eliza.how:8080/path" })).toBe(
      "app.eliza.how:8080",
    );
    expect(getAppHost({ NEXT_PUBLIC_APP_URL: " HTTPS://APP.ELIZA.HOW/ " })).toBe("app.eliza.how");
  });
});
