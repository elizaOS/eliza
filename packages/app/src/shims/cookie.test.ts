/**
 * Unit tests for the browser `cookie` shim. The suite drives the real module
 * (not a mock) and records parse first-key-wins, quoted-value stripping,
 * tolerant decode, serialize attribute ordering, SameSite true→Strict, and
 * parseSetCookie's structured attribute map including missing-pair rejection.
 */
import { describe, expect, it } from "vitest";

import cookieDefault, {
  parse,
  parseCookie,
  parseSetCookie,
  serialize,
  stringifyCookie,
  stringifySetCookie,
} from "./cookie.js";

describe("cookie parse", () => {
  it("returns an empty map for an empty header, parts without '=', and empty keys", () => {
    expect(parse("")).toEqual({});
    expect(parse(";")).toEqual({});
    expect(parse("nopath")).toEqual({});
    expect(parse("=value")).toEqual({});
    expect(parse(" =value")).toEqual({});
  });

  it("parses a single cookie and a multi-cookie header", () => {
    expect(parse("sid=abc")).toEqual({ sid: "abc" });
    expect(parse("sid=abc; theme=dark")).toEqual({
      sid: "abc",
      theme: "dark",
    });
  });

  it("trims keys and values and keeps an empty value", () => {
    expect(parse(" sid = abc ")).toEqual({ sid: "abc" });
    expect(parse("sid=")).toEqual({ sid: "" });
    expect(parse("sid=; theme=dark")).toEqual({ sid: "", theme: "dark" });
  });

  it("keeps the first occurrence when the same key appears twice", () => {
    expect(parse("sid=first; sid=second")).toEqual({ sid: "first" });
    expect(parse("sid=first;sid=second")).toEqual({ sid: "first" });
  });

  it("strips wrapping quotes only when the value both starts and ends with them", () => {
    expect(parse('sid="abc"')).toEqual({ sid: "abc" });
    expect(parse('sid=""')).toEqual({ sid: "" });
    expect(parse('sid="abc')).toEqual({ sid: '"abc' });
    expect(parse('sid=abc"')).toEqual({ sid: 'abc"' });
  });

  it("splits each pair on the first '=' and skips parts that have none", () => {
    expect(parse("sid=a=b=c; flag")).toEqual({ sid: "a=b=c" });
    expect(parse("sid=abc; ; theme=dark")).toEqual({
      sid: "abc",
      theme: "dark",
    });
  });

  it("decodes percent-escapes and keeps a malformed escape as the raw value", () => {
    expect(parse("sid=hello%20world")).toEqual({ sid: "hello world" });
    expect(parse("sid=%")).toEqual({ sid: "%" });
    expect(parse("sid=%ZZ")).toEqual({ sid: "%ZZ" });
  });

  it("uses a caller decode function when one is provided", () => {
    expect(
      parse("sid=abc", {
        decode: (value: string) => value.toUpperCase(),
      }),
    ).toEqual({ sid: "ABC" });
  });
});

describe("cookie serialize", () => {
  it("encodes the value and omits attributes when options are empty", () => {
    expect(serialize("sid", "abc")).toBe("sid=abc");
    expect(serialize("sid", "a b")).toBe("sid=a%20b");
    expect(serialize("sid", "a=b")).toBe("sid=a%3Db");
  });

  it("uses a caller encode function when one is provided", () => {
    expect(
      serialize("sid", "a b", {
        encode: (value: string) => value,
      }),
    ).toBe("sid=a b");
  });

  it("emits Max-Age when the field is present, including zero", () => {
    expect(serialize("sid", "abc", { maxAge: 3600 })).toBe(
      "sid=abc; Max-Age=3600",
    );
    expect(serialize("sid", "abc", { maxAge: 0 })).toBe("sid=abc; Max-Age=0");
  });

  it("omits falsy Domain, Path, and Priority strings", () => {
    expect(
      serialize("sid", "abc", { domain: "", path: "", priority: undefined }),
    ).toBe("sid=abc");
  });

  it("appends Domain, Path, Expires, flags, Priority, and SameSite in source order", () => {
    const expires = new Date(Date.UTC(2015, 9, 21, 7, 28, 0));
    expect(
      serialize("sid", "abc", {
        maxAge: 60,
        domain: "example.com",
        path: "/",
        expires,
        httpOnly: true,
        secure: true,
        partitioned: true,
        priority: "high",
        sameSite: "lax",
      }),
    ).toBe(
      "sid=abc; Max-Age=60; Domain=example.com; Path=/; Expires=Wed, 21 Oct 2015 07:28:00 GMT; HttpOnly; Secure; Partitioned; Priority=high; SameSite=lax",
    );
  });

  it("maps sameSite true to Strict and omits sameSite when it is false", () => {
    expect(serialize("sid", "abc", { sameSite: true })).toBe(
      "sid=abc; SameSite=Strict",
    );
    expect(serialize("sid", "abc", { sameSite: false })).toBe("sid=abc");
    expect(serialize("sid", "abc", { sameSite: "strict" })).toBe(
      "sid=abc; SameSite=strict",
    );
    expect(serialize("sid", "abc", { sameSite: "none" })).toBe(
      "sid=abc; SameSite=none",
    );
  });

  it("omits HttpOnly, Secure, and Partitioned when they are not true", () => {
    expect(
      serialize("sid", "abc", {
        httpOnly: false,
        secure: false,
        partitioned: false,
      }),
    ).toBe("sid=abc");
  });
});

describe("cookie parseSetCookie", () => {
  it("returns undefined when the first pair is missing or has no '='", () => {
    expect(parseSetCookie("")).toBeUndefined();
    expect(parseSetCookie("   ")).toBeUndefined();
    expect(parseSetCookie(";")).toBeUndefined();
    expect(parseSetCookie("HttpOnly")).toBeUndefined();
  });

  it("reads the name/value pair and leaves wrapping quotes in the value", () => {
    expect(parseSetCookie("sid=abc")).toEqual({ name: "sid", value: "abc" });
    expect(parseSetCookie('sid="abc"')).toEqual({
      name: "sid",
      value: '"abc"',
    });
    expect(parseSetCookie("=")).toEqual({ name: "", value: "" });
  });

  it("decodes the value and keeps a malformed escape as the raw value", () => {
    expect(parseSetCookie("sid=hello%20world")).toEqual({
      name: "sid",
      value: "hello world",
    });
    expect(parseSetCookie("sid=%ZZ")).toEqual({ name: "sid", value: "%ZZ" });
  });

  it("maps known attributes case-insensitively and ignores unknown ones", () => {
    const parsed = parseSetCookie(
      "sid=abc; Domain=example.com; Path=/app; Max-Age=3600; HttpOnly; Secure; Partitioned; Priority=high; SameSite=Lax; Foo=Bar",
    );
    expect(parsed).toEqual({
      name: "sid",
      value: "abc",
      domain: "example.com",
      path: "/app",
      maxAge: 3600,
      httpOnly: true,
      secure: true,
      partitioned: true,
      priority: "high",
      sameSite: "Lax",
    });
  });

  it("parses Expires as a Date and Max-Age as a number, including NaN and zero", () => {
    const withExpires = parseSetCookie(
      "sid=abc; Expires=Wed, 21 Oct 2015 07:28:00 GMT",
    );
    expect(withExpires?.expires?.toUTCString()).toBe(
      "Wed, 21 Oct 2015 07:28:00 GMT",
    );
    expect(parseSetCookie("sid=abc; Max-Age=0")?.maxAge).toBe(0);
    expect(Number.isNaN(parseSetCookie("sid=abc; Max-Age=nope")?.maxAge)).toBe(
      true,
    );
    expect(
      Number.isNaN(
        parseSetCookie("sid=abc; Expires=not-a-date")?.expires?.getTime(),
      ),
    ).toBe(true);
  });

  it("rejoins attribute values that contain extra '='", () => {
    expect(parseSetCookie("sid=abc; Path=/foo=bar")?.path).toBe("/foo=bar");
  });

  it("last assignment wins when the same attribute appears twice", () => {
    expect(
      parseSetCookie("sid=abc; Domain=first.example; Domain=second.example")
        ?.domain,
    ).toBe("second.example");
  });
});

describe("cookie export aliases", () => {
  it("exposes parse and serialize under the cookie-package consumer names", () => {
    expect(parseCookie).toBe(parse);
    expect(stringifyCookie).toBe(serialize);
    expect(stringifySetCookie).toBe(serialize);
    expect(cookieDefault.parse).toBe(parse);
    expect(cookieDefault.parseCookie).toBe(parseCookie);
    expect(cookieDefault.parseSetCookie).toBe(parseSetCookie);
    expect(cookieDefault.serialize).toBe(serialize);
    expect(cookieDefault.stringifyCookie).toBe(stringifyCookie);
    expect(cookieDefault.stringifySetCookie).toBe(stringifySetCookie);
  });
});
