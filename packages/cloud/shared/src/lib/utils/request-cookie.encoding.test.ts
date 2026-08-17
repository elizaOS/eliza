/**
 * Untrusted cookie-value encoding contract for `getRequestCookie`.
 *
 * Fetch `Request` cookie reads used raw `decodeURIComponent`. A malformed
 * percent-escape (`%`, `%ZZ`, truncated UTF-8) therefore threw URIError
 * out of the helper and became a worker 500 instead of "cookie absent".
 * These tests drive the exported helper so garbage is null.
 */

import { describe, expect, test } from "bun:test";
import { getRequestCookie } from "./request-cookie";

function requestWithCookie(cookie: string): Request {
  return new Request("http://localhost/", { headers: { cookie } });
}

describe("getRequestCookie encoding", () => {
  test("returns null for a lone % cookie before decode throws", () => {
    expect(getRequestCookie(requestWithCookie("sid=%"), "sid")).toBeNull();
  });

  test("returns null for %ZZ", () => {
    expect(getRequestCookie(requestWithCookie("sid=%ZZ"), "sid")).toBeNull();
  });

  test("returns null for truncated UTF-8 %E0%A4%A", () => {
    expect(
      getRequestCookie(requestWithCookie("sid=%E0%A4%A"), "sid"),
    ).toBeNull();
  });

  test("still decodes a valid %20 value", () => {
    expect(
      getRequestCookie(requestWithCookie("sid=launch%20pad"), "sid"),
    ).toBe("launch pad");
  });

  test("returns null when the named cookie is absent", () => {
    expect(getRequestCookie(requestWithCookie("other=1"), "sid")).toBeNull();
  });
});
