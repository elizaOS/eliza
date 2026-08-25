/**
 * Unit tests for the browser `style-to-js` shim. The suite drives the real
 * module (not a mock) and records empty-input rejection, declaration splitting,
 * quote/paren awareness, camelCasing, vendor-prefix `reactCompat`, custom
 * properties, last-write ties, and insertion order as implemented. There is no
 * comparator, queue, capacity, or removal API — invalid declarations are
 * skipped rather than stored.
 */
import { describe, expect, it } from "vitest";

import StyleToJS, { StyleToJS as namedStyleToJS } from "./style-to-js.js";

function parseUnknown(
  style: unknown,
  options?: { reactCompat?: boolean },
): Record<string, string> {
  return StyleToJS(style as string, options);
}

describe("style-to-js exports", () => {
  it("uses the same callable for default, named, and StyleToJS.default", () => {
    expect(StyleToJS).toBe(namedStyleToJS);
    expect(StyleToJS.default).toBe(StyleToJS);
    expect(StyleToJS).toBeTypeOf("function");
  });
});

describe("empty input and non-strings", () => {
  it("returns an empty object for an empty style string", () => {
    expect(StyleToJS("")).toEqual({});
  });

  it("returns an empty object for whitespace-only and semicolon-only strings", () => {
    expect(StyleToJS("   ")).toEqual({});
    expect(StyleToJS(";;;")).toEqual({});
    expect(StyleToJS(" ; ; ")).toEqual({});
  });

  it("returns an empty object when the runtime value is not a string", () => {
    expect(parseUnknown(null)).toEqual({});
    expect(parseUnknown(undefined)).toEqual({});
    expect(parseUnknown(0)).toEqual({});
    expect(parseUnknown(false)).toEqual({});
    expect(parseUnknown(1)).toEqual({});
    expect(parseUnknown({})).toEqual({});
    expect(parseUnknown([])).toEqual({});
  });
});

describe("single declaration", () => {
  it("parses a single property/value pair", () => {
    expect(StyleToJS("color: red")).toEqual({ color: "red" });
  });

  it("accepts a trailing semicolon after a single pair", () => {
    expect(StyleToJS("color: red;")).toEqual({ color: "red" });
  });

  it("trims property and value whitespace", () => {
    expect(StyleToJS("  color  :  red  ;  ")).toEqual({ color: "red" });
  });

  it("keeps an already-camelCased name that has no hyphen", () => {
    expect(StyleToJS("backgroundColor: red")).toEqual({
      backgroundColor: "red",
    });
  });

  it("keeps a value that contains spaces", () => {
    expect(StyleToJS("flex: 1 1 auto")).toEqual({ flex: "1 1 auto" });
  });
});

describe("invalid declarations are skipped (missing pair)", () => {
  it("skips a token with no colon", () => {
    expect(StyleToJS("nocolon")).toEqual({});
    expect(StyleToJS("color: red; nocolon; margin: 0")).toEqual({
      color: "red",
      margin: "0",
    });
  });

  it("skips a property with an empty value and a value with an empty property", () => {
    expect(StyleToJS("color:")).toEqual({});
    expect(StyleToJS(": red")).toEqual({});
    expect(StyleToJS("color: red; ; foo; :empty; background: blue")).toEqual({
      color: "red",
      background: "blue",
    });
  });
});

describe("multiple declarations: order and ties", () => {
  it("emits unique keys in first-seen insertion order", () => {
    expect(Object.keys(StyleToJS("z-index: 1; a: 2; m: 3"))).toEqual([
      "zIndex",
      "a",
      "m",
    ]);
  });

  it("last write wins a tied property; the key stays in its first-seen position", () => {
    const parsed = StyleToJS("z-index: 1; a: 2; z-index: 3; m: 4");
    expect(parsed).toEqual({ zIndex: "3", a: "2", m: "4" });
    expect(Object.keys(parsed)).toEqual(["zIndex", "a", "m"]);
  });

  it("parses adjacent pairs without spaces", () => {
    expect(StyleToJS("color:red;margin:0")).toEqual({
      color: "red",
      margin: "0",
    });
  });
});

describe("camelCase and custom properties", () => {
  it("camelCases hyphenated names and lowercases the source first", () => {
    expect(StyleToJS("background-color: red")).toEqual({
      backgroundColor: "red",
    });
    expect(StyleToJS("Background-Color: RED")).toEqual({
      backgroundColor: "RED",
    });
    expect(StyleToJS("border-top-left-radius: 1px")).toEqual({
      borderTopLeftRadius: "1px",
    });
  });

  it("leaves CSS custom properties (--foo) untouched, including inner hyphens", () => {
    expect(StyleToJS("--foo: bar")).toEqual({ "--foo": "bar" });
    expect(StyleToJS("--foo-bar: 1px")).toEqual({ "--foo-bar": "1px" });
    expect(StyleToJS("--Foo_1: x")).toEqual({ "--Foo_1": "x" });
  });

  it("does not treat a bare '--' as a custom-property skip; hyphen-letter still does not fire", () => {
    expect(StyleToJS("--: x")).toEqual({ "--": "x" });
  });

  it("camelCases an unknown vendor-like prefix to a leading capital", () => {
    expect(StyleToJS("-foo-bar: 1")).toEqual({ FooBar: "1" });
    expect(StyleToJS("-foo-bar: 1", { reactCompat: true })).toEqual({
      FooBar: "1",
    });
  });
});

describe("vendor prefixes and reactCompat", () => {
  it("strips known vendor hyphens without reactCompat (webkit/moz/ms/o/khtml)", () => {
    expect(StyleToJS("-webkit-transform: rotate(1deg)")).toEqual({
      webkitTransform: "rotate(1deg)",
    });
    expect(StyleToJS("-moz-appearance: none")).toEqual({
      mozAppearance: "none",
    });
    expect(StyleToJS("-ms-flex: 1")).toEqual({ msFlex: "1" });
    expect(StyleToJS("-o-transform: none")).toEqual({ oTransform: "none" });
    expect(StyleToJS("-khtml-user-select: none")).toEqual({
      khtmlUserSelect: "none",
    });
  });

  it("with reactCompat, only -ms- stays leading-lowercase; others capitalize", () => {
    expect(
      StyleToJS("-webkit-transform: rotate(1deg)", { reactCompat: true }),
    ).toEqual({ WebkitTransform: "rotate(1deg)" });
    expect(StyleToJS("-moz-appearance: none", { reactCompat: true })).toEqual({
      MozAppearance: "none",
    });
    expect(StyleToJS("-ms-flex: 1", { reactCompat: true })).toEqual({
      msFlex: "1",
    });
    expect(StyleToJS("-o-transform: none", { reactCompat: true })).toEqual({
      OTransform: "none",
    });
    expect(
      StyleToJS("-khtml-user-select: none", { reactCompat: true }),
    ).toEqual({ KhtmlUserSelect: "none" });
  });

  it("treats omitted options and reactCompat false like the default vendor path", () => {
    expect(StyleToJS("-webkit-transform: x", {})).toEqual({
      webkitTransform: "x",
    });
    expect(StyleToJS("-webkit-transform: x", { reactCompat: false })).toEqual({
      webkitTransform: "x",
    });
  });

  it("lowercases before matching -ms- so -MS-FLEX is still msFlex", () => {
    expect(StyleToJS("-MS-FLEX: 1")).toEqual({ msFlex: "1" });
    expect(StyleToJS("-MS-FLEX: 1", { reactCompat: true })).toEqual({
      msFlex: "1",
    });
  });
});

describe("quote- and paren-aware splitting", () => {
  it("does not split on ';' or ':' inside double or single quotes", () => {
    expect(StyleToJS('content: "a;b"; color: red')).toEqual({
      content: '"a;b"',
      color: "red",
    });
    expect(StyleToJS('content: "a:b"')).toEqual({ content: '"a:b"' });
    expect(StyleToJS("content: 'a;b'; color: red")).toEqual({
      content: "'a;b'",
      color: "red",
    });
  });

  it("does not close a quote that is preceded by a backslash", () => {
    expect(StyleToJS('content: "a\\"b;c"; color: red')).toEqual({
      content: '"a\\"b;c"',
      color: "red",
    });
  });

  it("does not split on ';' or ':' inside url(), calc(), or nested parens", () => {
    expect(
      StyleToJS("background: url(http://x.com/a;b.png); color: red"),
    ).toEqual({
      background: "url(http://x.com/a;b.png)",
      color: "red",
    });
    expect(StyleToJS("width: calc(1px + 2px); color: red")).toEqual({
      width: "calc(1px + 2px)",
      color: "red",
    });
    expect(
      StyleToJS("transform: translate(calc(1px + 2px)); color: blue"),
    ).toEqual({
      transform: "translate(calc(1px + 2px))",
      color: "blue",
    });
    expect(
      StyleToJS('background: url("http://x.com/a;b.png"); color: red'),
    ).toEqual({
      background: 'url("http://x.com/a;b.png")',
      color: "red",
    });
    expect(
      StyleToJS("background: url(http://example.com); color: red"),
    ).toEqual({
      background: "url(http://example.com)",
      color: "red",
    });
  });

  it("treats an unclosed quote as consuming the rest of the string", () => {
    expect(StyleToJS('content: "a;b; color: red')).toEqual({
      content: '"a;b; color: red',
    });
  });

  it("ignores a closing paren at depth 0 and still splits the next declaration", () => {
    expect(StyleToJS("color: red); background: blue")).toEqual({
      color: "red)",
      background: "blue",
    });
  });

  it("keeps later ';' inside an unclosed paren as part of the value", () => {
    expect(StyleToJS("color: url(foo; background: blue")).toEqual({
      color: "url(foo; background: blue",
    });
  });
});
