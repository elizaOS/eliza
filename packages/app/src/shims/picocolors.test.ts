/**
 * Unit tests for the browser `picocolors` shim. The suite drives the real
 * module (not a mock) and records the passthrough String() contract, the
 * singleton `createColors` return, `isColorSupported === false`, and the
 * absence of ANSI codes. There is no comparator, queue, capacity, or removal
 * API — only identity of the exported palette and ToString coercion.
 */
import { describe, expect, it } from "vitest";

import colors, { createColors } from "./picocolors.js";

const STYLE_KEYS = [
  "reset",
  "bold",
  "dim",
  "italic",
  "underline",
  "inverse",
  "hidden",
  "strikethrough",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "gray",
  "bgBlack",
  "bgRed",
  "bgGreen",
  "bgYellow",
  "bgBlue",
  "bgMagenta",
  "bgCyan",
  "bgWhite",
] as const;

type StyleKey = (typeof STYLE_KEYS)[number];

const style = (key: StyleKey): ((value: unknown) => string) => colors[key];

describe("picocolors exports", () => {
  it("exports the palette as default and createColors as a named function", () => {
    expect(colors).toBeTypeOf("object");
    expect(createColors).toBeTypeOf("function");
    expect(createColors).toBe(colors.createColors);
  });

  it("exposes keys in source insertion order with no bright or extra variants", () => {
    expect(Object.keys(colors)).toEqual([
      "isColorSupported",
      ...STYLE_KEYS,
      "createColors",
    ]);
    const palette = colors as Record<string, unknown>;
    expect(palette.redBright).toBeUndefined();
    expect(palette.bgRedBright).toBeUndefined();
    expect(palette.blackBright).toBeUndefined();
  });
});

describe("isColorSupported", () => {
  it("is the boolean false on the default palette and after createColors", () => {
    expect(colors.isColorSupported).toBe(false);
    expect(createColors().isColorSupported).toBe(false);
  });
});

describe("style passthrough: empty, single, and composed values", () => {
  it("returns an empty string unchanged for every style function", () => {
    for (const key of STYLE_KEYS) {
      expect(style(key)("")).toBe("");
    }
  });

  it("returns a single string unchanged and emits no ANSI escapes", () => {
    for (const key of STYLE_KEYS) {
      const rendered = style(key)("hello");
      expect(rendered).toBe("hello");
      expect(rendered.includes(String.fromCharCode(27))).toBe(false);
    }
  });

  it("collapses nested wrapping because every style is the same String() passthrough", () => {
    expect(colors.red(colors.bold("nested"))).toBe("nested");
    expect(colors.bgBlue(colors.underline(colors.yellow("x")))).toBe("x");
    expect(colors.reset(colors.dim(""))).toBe("");
  });
});

describe("style passthrough: ToString coercion", () => {
  it("stringifies null and undefined rather than throwing or returning them", () => {
    expect(colors.red(null)).toBe("null");
    expect(colors.red(undefined)).toBe("undefined");
    expect(colors.green(undefined)).toBe("undefined");
  });

  it("stringifies numbers, booleans, and arrays via String()", () => {
    expect(colors.yellow(0)).toBe("0");
    expect(colors.yellow(-1.5)).toBe("-1.5");
    expect(colors.cyan(true)).toBe("true");
    expect(colors.cyan(false)).toBe("false");
    expect(colors.magenta([1, 2])).toBe("1,2");
    expect(colors.white([])).toBe("");
  });

  it("stringifies objects through ToString, including a custom toString", () => {
    expect(colors.blue({})).toBe("[object Object]");
    expect(colors.blue({ toString: () => "custom" })).toBe("custom");
  });
});

describe("createColors singleton", () => {
  it("returns the same default palette for an empty call and nested calls", () => {
    expect(createColors()).toBe(colors);
    expect(createColors().createColors()).toBe(colors);
    expect(createColors()).toBe(createColors());
  });

  it("ignores an enabled flag; there is no overflow or alternate palette", () => {
    const createColorsWithFlag = createColors as (
      enabled?: boolean,
    ) => typeof colors;
    expect(createColorsWithFlag(true)).toBe(colors);
    expect(createColorsWithFlag(false)).toBe(colors);
    expect(createColorsWithFlag(true).isColorSupported).toBe(false);
    expect(createColorsWithFlag(true).red("x")).toBe("x");
  });
});
