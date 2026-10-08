import { describe, expect, test } from "bun:test";
import { resolveOAuthSuccessRedirectUrl } from "./redirect-validation";

const baseUrl = "https://cloud.eliza.app";

function resolve(value: string) {
  return resolveOAuthSuccessRedirectUrl({
    value,
    baseUrl,
    fallbackPath: "/app",
    allowedAbsoluteOrigins: [],
  });
}

describe("resolveOAuthSuccessRedirectUrl relative paths", () => {
  test("keeps an app path on the cloud origin", () => {
    const result = resolve("/app/settings");
    expect(result.rejected).toBe(false);
    expect(result.target.origin).toBe(baseUrl);
    expect(result.target.pathname).toBe("/app/settings");
  });

  test("rejects a backslash or control character that browsers treat as //", () => {
    for (const value of [
      "/\\evil.example/phish",
      "/\t/evil.example/p",
      "/\n/evil.example/p",
      "/\r/evil.example/p",
    ]) {
      const result = resolve(value);
      expect(result.rejected).toBe(true);
      expect(result.target.origin).toBe(baseUrl);
      expect(result.target.pathname).toBe("/app");
    }
  });
});
