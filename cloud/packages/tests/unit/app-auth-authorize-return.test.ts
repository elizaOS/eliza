import { describe, expect, test } from "bun:test";
import {
  buildAppAuthorizeCancelRedirect,
  buildAppAuthorizeCompletionRedirect,
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

  test("builds completion redirects with code, state, and no stale auth response parameters", () => {
    const redirect = buildAppAuthorizeCompletionRedirect({
      code: "eac_code",
      redirectUri:
        "http://localhost:2138/api/cloud/callback?token=old&code=old&error=old&error_description=old&mode=cloud",
      state: "abc",
    });
    const url = new URL(redirect);

    expect(url.searchParams.get("code")).toBe("eac_code");
    expect(url.searchParams.get("state")).toBe("abc");
    expect(url.searchParams.get("mode")).toBe("cloud");
    expect(url.searchParams.has("token")).toBe(false);
    expect(url.searchParams.get("error")).toBeNull();
    expect(url.searchParams.get("error_description")).toBeNull();
  });

  test("builds cancel redirects with no stale code or token parameters", () => {
    const redirect = buildAppAuthorizeCancelRedirect({
      redirectUri: "http://localhost:2138/api/cloud/callback?token=old&code=old&mode=cloud",
      state: "abc",
    });
    const url = new URL(redirect);

    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("error_description")).toBe("User denied authorization");
    expect(url.searchParams.get("state")).toBe("abc");
    expect(url.searchParams.get("mode")).toBe("cloud");
    expect(url.searchParams.has("token")).toBe(false);
    expect(url.searchParams.has("code")).toBe(false);
  });
});
