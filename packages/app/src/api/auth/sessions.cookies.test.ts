import type { IncomingMessage } from "node:http";
import * as uiSessions from "@elizaos/auth";
import { expect, it } from "vitest";
import { readCookie as authReadCookie, getSessionCookieName } from "../auth";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  parseCookieHeader,
  parseSessionCookie,
  readAllCookieValues,
  readCookie,
  SESSION_COOKIE_NAME,
  serializeCsrfExpiryCookie,
  serializeSessionExpiryCookie,
} from "./sessions";

// Node types the cookie header as a string, but raw header arrays reach the
// parser through `extractHeaderValue`, so both shapes are exercised.
const req = (cookie: string | string[] | undefined) =>
  ({ headers: { cookie } }) as unknown as Pick<IncomingMessage, "headers">;

it("shares one set of cookie constants with the browser client", () => {
  expect(SESSION_COOKIE_NAME).toBe(uiSessions.SESSION_COOKIE_NAME);
  expect(CSRF_COOKIE_NAME).toBe(uiSessions.CSRF_COOKIE_NAME);
  expect(CSRF_HEADER_NAME).toBe(uiSessions.CSRF_HEADER_NAME);
  expect(getSessionCookieName()).toBe(SESSION_COOKIE_NAME);
  expect(authReadCookie).toBe(readCookie);
});

it("reads a single session cookie and decodes it", () => {
  expect(parseSessionCookie(req("a=1; eliza_session=abc%3D; b=2"))).toBe(
    "abc=",
  );
});

it("rejects duplicated session cookies instead of picking one", () => {
  const header = "eliza_session=first; other=x; eliza_session=second";
  expect(parseSessionCookie(req(header))).toBeNull();
  expect(readCookie(req(header), SESSION_COOKIE_NAME)).toBeNull();
  expect(readCookie(req(header), "other")).toBe("x");
  // A third occurrence must not resurrect the name.
  expect(
    parseCookieHeader(`${header}; eliza_session=third`).has("eliza_session"),
  ).toBe(false);
});

it("accepts identical host-only and domain copies of one session", () => {
  expect(
    parseSessionCookie(req("eliza_session=same; eliza_session=same")),
  ).toBe("same");
  expect(
    parseSessionCookie(
      req("eliza_session=same; eliza_session=same; eliza_session=other"),
    ),
  ).toBeNull();
});

it("can expire the domain variant installed by the desktop bridge", () => {
  const env = {};
  expect(serializeSessionExpiryCookie({ env, domain: "localhost" })).toContain(
    "Domain=localhost",
  );
  expect(serializeCsrfExpiryCookie({ env, domain: "localhost" })).toContain(
    "Domain=localhost",
  );
  expect(serializeSessionExpiryCookie({ env })).not.toContain("Domain=");
});

it("treats malformed, empty and absent session cookies as no session", () => {
  expect(parseSessionCookie(req("eliza_session=%E0%A4%A"))).toBeNull();
  expect(parseSessionCookie(req("eliza_session="))).toBeNull();
  expect(parseSessionCookie(req("eliza_session=; eliza_session=x"))).toBeNull();
  expect(parseSessionCookie(req(undefined))).toBeNull();
  expect(parseSessionCookie(req(["eliza_session=array"]))).toBe("array");
});

it("lists every distinct session credential for logout without choosing one", () => {
  const header =
    "eliza_session=first; other=x; eliza_session=second; eliza_session=first; eliza_session=%E0%A4%A";
  expect(parseSessionCookie(req(header))).toBeNull();
  expect(readAllCookieValues(req(header), SESSION_COOKIE_NAME)).toEqual([
    "first",
    "second",
  ]);
  expect(readAllCookieValues(req(undefined), SESSION_COOKIE_NAME)).toEqual([]);
});
