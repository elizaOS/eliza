import { describe, expect, test } from "vitest";
import {
  consumePendingOAuthReturnTo,
  resolveLoginReturnTo,
  storePendingOAuthReturnTo,
} from "./login-return-to";

function params(query: string) {
  return new URLSearchParams(query);
}

describe("resolveLoginReturnTo", () => {
  test("prefers an internal returnTo query over a pending OAuth return target", () => {
    expect(
      resolveLoginReturnTo(
        params("returnTo=/dashboard/settings%3Ftab%3Dbilling"),
        "/dashboard/agents",
      ),
    ).toBe("/dashboard/settings?tab=billing");
  });

  test.each([
    ["https://evil.test/dashboard"],
    ["//evil.test/dashboard"],
    ["javascript:alert(1)"],
    ["data:text/html,<script>alert(1)</script>"],
    [""],
  ])("rejects hostile returnTo query value %j", (returnTo) => {
    expect(
      resolveLoginReturnTo(params(`returnTo=${encodeURIComponent(returnTo)}`)),
    ).toBe("/dashboard/agents");
  });

  test("falls back to a sanitized pending OAuth return target", () => {
    expect(resolveLoginReturnTo(params(""), "/dashboard/apps?tab=keys")).toBe(
      "/dashboard/apps?tab=keys",
    );
    expect(resolveLoginReturnTo(params(""), "//evil.test/callback")).toBe(
      "/dashboard/agents",
    );
  });

  test("stores pending OAuth return targets as single-use internal paths", () => {
    window.sessionStorage.clear();

    expect(storePendingOAuthReturnTo("/auth/cli-login?session=abc")).toBe(true);
    expect(consumePendingOAuthReturnTo()).toBe("/auth/cli-login?session=abc");
    expect(consumePendingOAuthReturnTo()).toBeNull();

    expect(storePendingOAuthReturnTo("//evil.test/callback")).toBe(false);
    expect(consumePendingOAuthReturnTo()).toBeNull();
  });
});
