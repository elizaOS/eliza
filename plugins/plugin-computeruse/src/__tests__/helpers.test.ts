/**
 * Unit coverage for the pure platform helpers (#9170 / #9105).
 *
 * These functions are the input-sanitization + key-normalization layer that
 * sits between agent-supplied params and the per-OS shell drivers
 * (AppleScript / xdotool / PowerShell SendKeys). Several are security
 * boundaries — `validateInt`, `validateWindowId`, `escapeAppleScript`,
 * `safeXdotoolKey`, and `validateKeypress` exist specifically to stop shell /
 * AppleScript injection — and shipped with no regression lock. Pure +
 * deterministic, so they run in the default vitest lane on every OS.
 */

import { platform } from "node:os";
import { describe, expect, it } from "vitest";
import {
  canonicalKeyName,
  currentPlatform,
  escapeAppleScript,
  safeXdotoolKey,
  toCliclickKeyName,
  toWindowsSendKey,
  toXdotoolKeyName,
  validateCoordinate,
  validateInt,
  validateKeypress,
  validateText,
  validateWindowId,
} from "../platform/helpers.js";

describe("validateInt", () => {
  it("rounds finite numbers and numeric strings", () => {
    expect(validateInt(42)).toBe(42);
    expect(validateInt(42.7)).toBe(43);
    expect(validateInt(-3.2)).toBe(-3);
    expect(validateInt("100")).toBe(100);
    expect(validateInt("1e3")).toBe(1000);
  });

  it("rejects non-numeric / non-finite / empty input (injection guard)", () => {
    expect(() => validateInt("12; rm -rf /")).toThrow(/Invalid numeric/);
    expect(() => validateInt("$(whoami)")).toThrow(/Invalid numeric/);
    expect(() => validateInt("12abc")).toThrow(/Invalid numeric/);
    expect(() => validateInt("")).toThrow(/Invalid numeric/);
    expect(() => validateInt("   ")).toThrow(/Invalid numeric/);
    expect(() => validateInt(Number.NaN)).toThrow(/Invalid numeric/);
    expect(() => validateInt(Number.POSITIVE_INFINITY)).toThrow(
      /Invalid numeric/,
    );
    expect(() => validateInt(null)).toThrow(/Invalid numeric/);
    expect(() => validateInt(undefined)).toThrow(/Invalid numeric/);
  });
});

describe("validateCoordinate", () => {
  it("clamps into [0, max] on each axis", () => {
    expect(validateCoordinate(50, 60, 100, 100)).toEqual([50, 60]);
    expect(validateCoordinate(-10, 5, 100, 100)).toEqual([0, 5]);
    expect(validateCoordinate(5, 999, 100, 100)).toEqual([5, 100]);
    expect(validateCoordinate(150, 150, 100, 80)).toEqual([100, 80]);
  });

  it("rounds through validateInt and rejects junk", () => {
    expect(validateCoordinate(10.6, 20.4, 100, 100)).toEqual([11, 20]);
    expect(() => validateCoordinate(Number.NaN, 0, 100, 100)).toThrow();
  });
});

describe("validateWindowId (shell-literal injection guard)", () => {
  it("accepts decimal and 0x-hex ids, trimming whitespace", () => {
    expect(validateWindowId("12345")).toBe("12345");
    expect(validateWindowId("  42 ")).toBe("42");
    expect(validateWindowId("0xAF09")).toBe("0xAF09");
    expect(validateWindowId("0xff")).toBe("0xff");
  });

  it("rejects anything that could escape the surrounding script literal", () => {
    for (const bad of [
      "12; ls",
      "$(whoami)",
      "`id`",
      '1" or "1',
      "0x",
      "12 34",
      "abc",
      "",
      "-1",
      "1.5",
    ]) {
      expect(() => validateWindowId(bad), bad).toThrow(/Invalid windowId/);
    }
  });
});

describe("validateText", () => {
  it("passes strings within the length budget", () => {
    expect(validateText("hello")).toBe("hello");
    expect(validateText("x".repeat(4096))).toHaveLength(4096);
    expect(validateText("ab", 2)).toBe("ab");
  });

  it("rejects over-long input and non-strings", () => {
    expect(() => validateText("x".repeat(4097))).toThrow(/too long/);
    expect(() => validateText("abc", 2)).toThrow(/too long/);
    // @ts-expect-error — runtime guard for non-string callers
    expect(() => validateText(123)).toThrow(/must be a string/);
  });
});

describe("escapeAppleScript (AppleScript-literal injection guard)", () => {
  it("wraps in quotes and escapes backslashes then double-quotes", () => {
    expect(escapeAppleScript("hello")).toBe('"hello"');
    expect(escapeAppleScript('say "hi"')).toBe('"say \\"hi\\""');
    expect(escapeAppleScript("C:\\path")).toBe('"C:\\\\path"');
  });

  it("neutralizes an attempt to break out of the literal", () => {
    const escaped = escapeAppleScript('"; do shell script "rm -rf /');
    // The whole payload stays inside one quoted literal: it begins and ends
    // with an unescaped quote, and every interior quote is backslash-escaped.
    expect(escaped.startsWith('"')).toBe(true);
    expect(escaped.endsWith('"')).toBe(true);
    expect(escaped.slice(1, -1)).not.toMatch(/(?<!\\)"/); // no bare interior quote
  });
});

describe("safeXdotoolKey (key whitelist)", () => {
  it("accepts known key names and single printable ASCII chars", () => {
    expect(safeXdotoolKey("Return")).toBe("Return");
    expect(safeXdotoolKey(" F5 ")).toBe("F5");
    expect(safeXdotoolKey("a")).toBe("a");
    expect(safeXdotoolKey("5")).toBe("5");
    expect(safeXdotoolKey("+")).toBe("+");
  });

  it("rejects unknown multi-char names and non-ASCII (injection guard)", () => {
    expect(() => safeXdotoolKey("Return; rm -rf /")).toThrow(/Invalid key/);
    expect(() => safeXdotoolKey("notakey")).toThrow(/Invalid key/);
    expect(() => safeXdotoolKey("")).toThrow(/Invalid key/);
    expect(() => safeXdotoolKey("é")).toThrow(/Invalid key/); // > 126
  });
});

describe("validateKeypress (charset guard)", () => {
  it("accepts combos of alphanumerics + the allowed punctuation", () => {
    expect(validateKeypress("ctrl+a")).toBe("ctrl+a");
    expect(validateKeypress("shift+F5")).toBe("shift+F5");
    expect(validateKeypress("A-Z 0-9 .,:_+-")).toBe("A-Z 0-9 .,:_+-");
  });

  it("rejects shell metacharacters, empty, and over-long input", () => {
    for (const bad of ["a;b", "a|b", "a$b", "a`b", "a/b", "a(b)", "a&b"]) {
      expect(() => validateKeypress(bad), bad).toThrow(/invalid characters/);
    }
    expect(() => validateKeypress("")).toThrow(/non-empty/);
    expect(() => validateKeypress("a".repeat(129))).toThrow(/too long/);
  });
});

describe("canonicalKeyName", () => {
  it("normalizes aliases, casing, arrow-prefix, and separators", () => {
    expect(canonicalKeyName("Esc")).toBe("escape");
    expect(canonicalKeyName("RETURN")).toBe("enter");
    expect(canonicalKeyName("ArrowUp")).toBe("up");
    expect(canonicalKeyName("Page_Up")).toBe("pageup");
    expect(canonicalKeyName("spacebar")).toBe("space");
    expect(canonicalKeyName(" del ")).toBe("delete");
  });

  it("passes function keys through and leaves unknown keys normalized", () => {
    expect(canonicalKeyName("F5")).toBe("f5");
    expect(canonicalKeyName("ctrl")).toBe("ctrl");
    expect(canonicalKeyName("a")).toBe("a");
  });

  it("rejects empty input", () => {
    expect(() => canonicalKeyName("  ")).toThrow(/non-empty/);
  });
});

describe("per-OS key name mappers", () => {
  it("toCliclickKeyName maps canonical names, else passes through", () => {
    expect(toCliclickKeyName("escape")).toBe("esc");
    expect(toCliclickKeyName("Enter")).toBe("return");
    expect(toCliclickKeyName("ArrowDown")).toBe("arrow-down");
    expect(toCliclickKeyName("f7")).toBe("f7");
    expect(toCliclickKeyName("a")).toBe("a");
  });

  it("toXdotoolKeyName maps names and uppercases function keys", () => {
    expect(toXdotoolKeyName("escape")).toBe("Escape");
    expect(toXdotoolKeyName("enter")).toBe("Return");
    expect(toXdotoolKeyName("f9")).toBe("F9");
    expect(toXdotoolKeyName("a")).toBe("a");
  });

  it("toWindowsSendKey wraps special + function keys, passes chars through", () => {
    expect(toWindowsSendKey("escape")).toBe("{ESC}");
    expect(toWindowsSendKey("Enter")).toBe("{ENTER}");
    expect(toWindowsSendKey("pageup")).toBe("{PGUP}");
    expect(toWindowsSendKey("f12")).toBe("{F12}");
    expect(toWindowsSendKey("space")).toBe(" ");
    expect(toWindowsSendKey("a")).toBe("a");
  });
});

describe("currentPlatform", () => {
  it("reports the running OS as a typed union member", () => {
    const os = currentPlatform();
    expect(["darwin", "linux", "win32"]).toContain(os);
    expect(os).toBe(platform());
  });
});
