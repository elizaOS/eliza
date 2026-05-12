import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LOGIN_RETURN_TO,
  resolveLoginReturnTo,
  sanitizeLoginReturnTo,
} from "@/apps/frontend/src/pages/login/login-return-to";

function searchParams(entries: Record<string, string | null | undefined>) {
  return {
    get(name: string) {
      return entries[name] ?? null;
    },
  };
}

describe("login return targets", () => {
  test("keeps safe relative returnTo values from the URL", () => {
    expect(
      resolveLoginReturnTo(
        searchParams({
          returnTo:
            "/app-auth/authorize?app_id=app_123&redirect_uri=http%3A%2F%2Flocalhost%3A2138%2Fapi%2Fcloud%2Fcallback",
        }),
      ),
    ).toBe(
      "/app-auth/authorize?app_id=app_123&redirect_uri=http%3A%2F%2Flocalhost%3A2138%2Fapi%2Fcloud%2Fcallback",
    );
  });

  test("uses the pending OAuth return target when the callback URL lost returnTo", () => {
    expect(resolveLoginReturnTo(searchParams({}), "/app-auth/authorize?app_id=app_123")).toBe(
      "/app-auth/authorize?app_id=app_123",
    );
  });

  test("rejects unsafe return targets", () => {
    expect(sanitizeLoginReturnTo("https://evil.example/app-auth/authorize")).toBeNull();
    expect(sanitizeLoginReturnTo("//evil.example/app-auth/authorize")).toBeNull();
    expect(resolveLoginReturnTo(searchParams({ returnTo: "//evil.example" }))).toBe(
      DEFAULT_LOGIN_RETURN_TO,
    );
  });
});
