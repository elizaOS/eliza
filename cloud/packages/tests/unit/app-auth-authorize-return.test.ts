import { describe, expect, test } from "bun:test";
import {
  buildAppAuthorizeLoginHref,
  buildAppAuthorizeReturnTo,
} from "@/packages/ui/src/components/auth/authorize-return";

describe("app auth authorize return URLs", () => {
  test("preserves the full authorize query through login", () => {
    const search =
      "app_id=app_123&redirect_uri=http%3A%2F%2Flocalhost%3A2138%2Fapi%2Fcloud%2Fcallback&state=abc";

    expect(buildAppAuthorizeReturnTo(search)).toBe(`/app-auth/authorize?${search}`);
    expect(buildAppAuthorizeLoginHref(search)).toBe(
      `/login?returnTo=${encodeURIComponent(`/app-auth/authorize?${search}`)}`,
    );
  });

  test("accepts search strings that already include the question mark", () => {
    expect(buildAppAuthorizeReturnTo("?app_id=app_123")).toBe("/app-auth/authorize?app_id=app_123");
  });
});
