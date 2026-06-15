import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  consumePendingOAuthReturnTo,
  resolveLoginReturnTo,
  storePendingOAuthReturnTo,
} from "./login-return-to";

function params(query: string) {
  return new URLSearchParams(query);
}

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

describe("resolveLoginReturnTo", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createStorage(),
    });
    window.sessionStorage.clear();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

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

  test("stores and consumes a sanitized OAuth return target outside redirect_uri", () => {
    storePendingOAuthReturnTo(
      params("returnTo=/auth/cli-login%3Fsession%3Dabc"),
    );

    expect(consumePendingOAuthReturnTo()).toBe("/auth/cli-login?session=abc");
    expect(consumePendingOAuthReturnTo()).toBeNull();
  });

  test("keeps pending OAuth return target if sessionStorage is lost during mobile OAuth", () => {
    storePendingOAuthReturnTo(
      params("returnTo=/auth/cli-login%3Fsession%3Dmobile"),
    );
    window.sessionStorage.clear();

    expect(consumePendingOAuthReturnTo()).toBe(
      "/auth/cli-login?session=mobile",
    );
    expect(consumePendingOAuthReturnTo()).toBeNull();
  });

  test.each([
    "https://evil.test/dashboard",
    "//evil.test/dashboard",
    "",
  ])("does not persist hostile OAuth return target %j", (returnTo) => {
    storePendingOAuthReturnTo(
      params(`returnTo=${encodeURIComponent(returnTo)}`),
    );

    expect(consumePendingOAuthReturnTo()).toBeNull();
  });

  test("keeps pending OAuth return target across retry without returnTo in the URL", () => {
    storePendingOAuthReturnTo(
      params("returnTo=/payment/success%3Fsession%3D123"),
    );
    storePendingOAuthReturnTo(params(""));

    expect(consumePendingOAuthReturnTo()).toBe("/payment/success?session=123");
  });
});
