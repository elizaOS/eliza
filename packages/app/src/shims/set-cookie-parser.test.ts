/**
 * Unit tests for the browser `set-cookie-parser` shim. The suite drives the
 * real module (not a mock) and records parseString attribute mapping, tolerant
 * percent-decoding, splitCookiesString comma-vs-Expires splitting, and parse's
 * Headers / header-record / map-vs-array surfaces as implemented. There is no
 * comparator, queue, capacity, or removal API — only parse of Set-Cookie text.
 */
import { describe, expect, it } from "vitest";

import parseDefault, {
  parse,
  parseString,
  splitCookiesString,
} from "./set-cookie-parser.js";

describe("set-cookie-parser exports", () => {
  it("uses the same function for the default and named parse exports", () => {
    expect(parseDefault).toBe(parse);
  });
});

describe("parseString", () => {
  it("returns null for an empty queue: empty, whitespace-only, and semicolon-only input", () => {
    expect(parseString("")).toBeNull();
    expect(parseString("   ")).toBeNull();
    expect(parseString(";;;")).toBeNull();
  });

  it("returns null when the name/value pair has no name (no '=', or empty key)", () => {
    expect(parseString("nopath")).toBeNull();
    expect(parseString("=value")).toBeNull();
  });

  it("parses a single cookie and keeps an empty value", () => {
    expect(parseString("sid=abc")).toEqual({ name: "sid", value: "abc" });
    expect(parseString("sid=")).toEqual({ name: "sid", value: "" });
  });

  it("splits the name/value pair on the first '=' and rejoins the rest", () => {
    expect(parseString("sid=a=b=c")).toEqual({ name: "sid", value: "a=b=c" });
  });

  it("keeps a leading space on the cookie name (the name token is not trimmed)", () => {
    expect(parseString(" sid=abc")).toEqual({ name: " sid", value: "abc" });
  });

  it("accepts prototype-looking cookie names because Object.hasOwn({}, name) never matches them", () => {
    expect(parseString("constructor=x")).toEqual({
      name: "constructor",
      value: "x",
    });
    expect(parseString("toString=x")).toEqual({ name: "toString", value: "x" });
    expect(parseString("__proto__=x")).toEqual({
      name: "__proto__",
      value: "x",
    });
  });

  it("decodes percent-escapes by default and when decodeValues is true", () => {
    expect(parseString("sid=hello%20world")).toEqual({
      name: "sid",
      value: "hello world",
    });
    expect(parseString("sid=hello%20world", { decodeValues: true })).toEqual({
      name: "sid",
      value: "hello world",
    });
  });

  it("keeps the raw value when decodeValues is false", () => {
    expect(parseString("sid=hello%20world", { decodeValues: false })).toEqual({
      name: "sid",
      value: "hello%20world",
    });
  });

  it("keeps a malformed percent-escape as the raw value", () => {
    expect(parseString("sid=%")).toEqual({ name: "sid", value: "%" });
    expect(parseString("sid=%ZZ")).toEqual({ name: "sid", value: "%ZZ" });
    expect(parseString("sid=%E0%")).toEqual({ name: "sid", value: "%E0%" });
  });

  it("does not treat '+' as a space during decode", () => {
    expect(parseString("sid=a+b")).toEqual({ name: "sid", value: "a+b" });
  });

  it("maps known attributes onto camelCase fields and lowercases unknown keys", () => {
    const cookie = parseString(
      "sid=abc; Path=/; Domain=ex.com; Expires=Wed, 21 Oct 2015 07:28:00 GMT; HttpOnly; Secure; SameSite=Lax; Max-Age=3600; Partitioned; Custom=x",
    );
    if (cookie === null) {
      throw new Error("expected parsed cookie");
    }
    expect(cookie.name).toBe("sid");
    expect(cookie.value).toBe("abc");
    expect(cookie.path).toBe("/");
    expect(cookie.domain).toBe("ex.com");
    expect(cookie.expires).toBeInstanceOf(Date);
    expect((cookie.expires as Date).getTime()).toBe(
      Date.parse("Wed, 21 Oct 2015 07:28:00 GMT"),
    );
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.secure).toBe(true);
    expect(cookie.sameSite).toBe("Lax");
    expect(cookie.maxAge).toBe(3600);
    expect(cookie.partitioned).toBe(true);
    expect(cookie.custom).toBe("x");
  });

  it("sets boolean attributes to true even when they carry a value", () => {
    expect(parseString("sid=a; HttpOnly=false")).toEqual({
      name: "sid",
      value: "a",
      httpOnly: true,
    });
    expect(parseString("sid=a; Secure=0")).toEqual({
      name: "sid",
      value: "a",
      secure: true,
    });
    expect(parseString("sid=a; Partitioned=no")).toEqual({
      name: "sid",
      value: "a",
      partitioned: true,
    });
  });

  it("omits maxAge when parseInt yields NaN, keeps 0 and negatives, and truncates a float prefix", () => {
    expect(parseString("sid=a; Max-Age=abc")).toEqual({
      name: "sid",
      value: "a",
    });
    expect(parseString("sid=a; Max-Age=")).toEqual({ name: "sid", value: "a" });
    expect(parseString("sid=a; Max-Age=0")).toEqual({
      name: "sid",
      value: "a",
      maxAge: 0,
    });
    expect(parseString("sid=a; Max-Age=-1")).toEqual({
      name: "sid",
      value: "a",
      maxAge: -1,
    });
    expect(parseString("sid=a; Max-Age=12.9")).toEqual({
      name: "sid",
      value: "a",
      maxAge: 12,
    });
    expect(parseString("sid=a; Max-Age=3600abc")).toEqual({
      name: "sid",
      value: "a",
      maxAge: 3600,
    });
  });

  it("stores an Invalid Date when Expires is empty or not parseable", () => {
    const empty = parseString("sid=a; Expires=");
    const garbage = parseString("sid=a; Expires=not-a-date");
    if (empty === null || garbage === null) {
      throw new Error("expected parsed cookies");
    }
    expect(empty.expires).toBeInstanceOf(Date);
    expect(garbage.expires).toBeInstanceOf(Date);
    expect(Number.isNaN((empty.expires as Date).getTime())).toBe(true);
    expect(Number.isNaN((garbage.expires as Date).getTime())).toBe(true);
  });

  it("keeps an empty SameSite value and an unknown flag without '=' as an empty string", () => {
    expect(parseString("sid=a; SameSite=")).toEqual({
      name: "sid",
      value: "a",
      sameSite: "",
    });
    expect(parseString("sid=a; Foo")).toEqual({
      name: "sid",
      value: "a",
      foo: "",
    });
  });

  it("trimStarts attribute keys but does not trim trailing spaces, so 'Path ' is a distinct key", () => {
    expect(parseString("sid=a;\tPath=/")).toEqual({
      name: "sid",
      value: "a",
      path: "/",
    });
    expect(parseString("sid=a; Path =/app")).toEqual({
      name: "sid",
      value: "a",
      "path ": "/app",
    });
  });

  it("skips an empty attribute key and does not own-assign a __proto__ attribute", () => {
    expect(parseString("sid=a; =x; ; Path=/app")).toEqual({
      name: "sid",
      value: "a",
      path: "/app",
    });
    const cookie = parseString("sid=a; __proto__=polluted");
    if (cookie === null) {
      throw new Error("expected parsed cookie");
    }
    expect(cookie).toEqual({ name: "sid", value: "a" });
    expect(Object.hasOwn(cookie, "__proto__")).toBe(false);
    expect(Object.getPrototypeOf(cookie)).toBe(Object.prototype);
  });

  it("ignores the unused silent option", () => {
    expect(parseString("sid=abc", { silent: true })).toEqual({
      name: "sid",
      value: "abc",
    });
  });
});

describe("splitCookiesString", () => {
  it("returns a non-string, non-array input as an empty list", () => {
    expect(splitCookiesString(null)).toEqual([]);
    expect(splitCookiesString(undefined)).toEqual([]);
    expect(splitCookiesString(42)).toEqual([]);
    expect(splitCookiesString({ a: 1 })).toEqual([]);
  });

  it("returns an array input as-is, including non-strings (passthrough, not a copy)", () => {
    const input = [1, null, "a=1"];
    expect(splitCookiesString(input)).toBe(input);
    expect(splitCookiesString(input)).toEqual([1, null, "a=1"]);
  });

  it("returns an empty list for an empty string", () => {
    expect(splitCookiesString("")).toEqual([]);
  });

  it("returns a whitespace-only string as a single element, not an empty queue", () => {
    expect(splitCookiesString("   ")).toEqual(["   "]);
  });

  it("returns a single cookie string unchanged", () => {
    expect(splitCookiesString("sid=abc")).toEqual(["sid=abc"]);
  });

  it("splits comma-joined cookies with or without spaces", () => {
    expect(splitCookiesString("a=1, b=2")).toEqual(["a=1", "b=2"]);
    expect(splitCookiesString("a=1,b=2")).toEqual(["a=1", "b=2"]);
    expect(splitCookiesString("a=1, b=2, c=3")).toEqual(["a=1", "b=2", "c=3"]);
  });

  it("does not split on the comma inside an Expires GMT date", () => {
    expect(
      splitCookiesString("x=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT"),
    ).toEqual(["x=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT"]);
    expect(
      splitCookiesString(
        "a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT, b=2; Path=/",
      ),
    ).toEqual(["a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT", "b=2; Path=/"]);
  });

  it("keeps a trailing or lone comma because nothing after it looks like name=", () => {
    expect(splitCookiesString("a=1,")).toEqual(["a=1,"]);
    expect(splitCookiesString(",")).toEqual([","]);
  });

  it("absorbs a comma-separated token that has no '=' into the previous cookie", () => {
    expect(splitCookiesString("a=1, nopath, b=2")).toEqual([
      "a=1, nopath",
      "b=2",
    ]);
  });
});

describe("parse", () => {
  it("returns an empty array for undefined, empty string, empty array, and headers with no Set-Cookie", () => {
    expect(parse(undefined)).toEqual([]);
    expect(parse("")).toEqual([]);
    expect(parse([])).toEqual([]);
    expect(parse({ headers: {} })).toEqual([]);
    expect(parse({ headers: { other: "x" } })).toEqual([]);
  });

  it("parses a single Set-Cookie string and an array of strings", () => {
    expect(parse("sid=abc; Path=/")).toEqual([
      { name: "sid", value: "abc", path: "/" },
    ]);
    expect(parse(["a=1", "b=2"])).toEqual([
      { name: "a", value: "1" },
      { name: "b", value: "2" },
    ]);
  });

  it("splits a comma-joined string and drops parts that parseString rejects", () => {
    expect(parse("a=1, b=2")).toEqual([
      { name: "a", value: "1" },
      { name: "b", value: "2" },
    ]);
    expect(parse(["a=1", "nopath", "b=2", "", "  "])).toEqual([
      { name: "a", value: "1" },
      { name: "b", value: "2" },
    ]);
  });

  it("reads Set-Cookie from a Headers object via getSetCookie", () => {
    const headers = new Headers();
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2; HttpOnly");
    expect(parse({ headers })).toEqual([
      { name: "a", value: "1", path: "/" },
      { name: "b", value: "2", httpOnly: true },
    ]);
  });

  it("reads Set-Cookie from a Headers-like object that only exposes getSetCookie", () => {
    expect(
      parse({
        headers: { getSetCookie: () => ["x=1", "y=2"] },
      }),
    ).toEqual([
      { name: "x", value: "1" },
      { name: "y", value: "2" },
    ]);
  });

  it("reads a header-record Set-Cookie key case-insensitively, including an array value", () => {
    expect(parse({ headers: { "Set-Cookie": "a=1; Path=/" } })).toEqual([
      { name: "a", value: "1", path: "/" },
    ]);
    expect(parse({ headers: { "set-cookie": ["a=1", "b=2"] } })).toEqual([
      { name: "a", value: "1" },
      { name: "b", value: "2" },
    ]);
    expect(parse({ headers: { "SET-COOKIE": "z=9" } })).toEqual([
      { name: "z", value: "9" },
    ]);
    expect(parse({ headers: { Cookie: "no", "Set-Cookie": "ok=1" } })).toEqual([
      { name: "ok", value: "1" },
    ]);
  });

  it("does not treat an array headers field as a header record, so it yields no cookies", () => {
    expect(parse({ headers: ["a=1"] })).toEqual([]);
  });

  it("returns a name-keyed map when options.map is true, last duplicate name wins", () => {
    expect(parse("a=1, b=2", { map: true })).toEqual({
      a: { name: "a", value: "1" },
      b: { name: "b", value: "2" },
    });
    expect(parse("a=first, a=second", { map: true })).toEqual({
      a: { name: "a", value: "second" },
    });
    expect(parse("a=1; Path=/one, a=2; Path=/two", { map: true })).toEqual({
      a: { name: "a", value: "2", path: "/two" },
    });
    expect(parse(["a=1; Path=/", "nopath", "b=2"], { map: true })).toEqual({
      a: { name: "a", value: "1", path: "/" },
      b: { name: "b", value: "2" },
    });
  });

  it("returns an array when options.map is omitted or false", () => {
    expect(parse("a=1", { map: false })).toEqual([{ name: "a", value: "1" }]);
  });
});
