/**
 * Cookie-header value encoding is leftover tax after vault saved-login
 * listing decode (#21378). Stock develop called decodeURIComponent on
 * every Cookie value, so `session=%` / `%2` / `%ZZ` threw URIError on
 * auth and anonymous-admission paths. Neighbor cookies stay readable.
 */
import { describe, expect, test } from "bun:test";
import {
  getCookieValueFromHeader,
  getCookieValueFromRequest,
} from "./cookie-header.ts";

describe("cookie header value encoding", () => {
  test("canonical cookie still decodes", () => {
    expect(getCookieValueFromHeader("session=abc", "session")).toBe("abc");
  });

  test("canonical percent-encoded hyphen still decodes", () => {
    expect(getCookieValueFromHeader("session=user%2D1", "session")).toBe(
      "user-1",
    );
  });

  test.each(["%", "%2", "%ZZ", "%E0%A4"])(
    "treats malformed cookie encoding %s as absent",
    (token) => {
      expect(
        getCookieValueFromHeader(`session=${token}`, "session"),
      ).toBeUndefined();
    },
  );

  test("neighbor cookies remain readable when one value is malformed", () => {
    expect(
      getCookieValueFromHeader("session=%ZZ; other=ok", "other"),
    ).toBe("ok");
  });

  test("request helper still reads a canonical cookie", () => {
    const request = new Request("https://example.test/", {
      headers: { cookie: "session=abc" },
    });
    expect(getCookieValueFromRequest(request, "session")).toBe("abc");
  });
});
