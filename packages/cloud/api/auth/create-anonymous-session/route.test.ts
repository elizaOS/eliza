import { describe, expect, test } from "bun:test";
import { isValidReturnUrl } from "./route";

const requestUrl = "https://cloud.eliza.app/api/auth/create-anonymous-session";

function redirectTarget(returnUrl: string): URL {
  const chosen = isValidReturnUrl(returnUrl) ? returnUrl : "/";
  return new URL(chosen, requestUrl);
}

describe("anonymous session returnUrl", () => {
  test("keeps an app path on the cloud origin", () => {
    const target = redirectTarget("/dashboard");
    expect(target.origin).toBe("https://cloud.eliza.app");
    expect(target.pathname).toBe("/dashboard");
  });

  test("rejects a backslash or control character that browsers treat as //", () => {
    for (const value of [
      "/\\evil.example/phish",
      "/\t/evil.example/p",
      "/\n/evil.example/p",
      "/\r/evil.example/p",
    ]) {
      const target = redirectTarget(value);
      expect(target.origin).toBe("https://cloud.eliza.app");
      expect(target.pathname).toBe("/");
    }
  });
});
