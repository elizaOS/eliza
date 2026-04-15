/**
 * Unit tests for platform/helpers.ts — input validation, command utilities.
 * These are pure logic tests, no system calls needed.
 */
import { describe, expect, it } from "vitest";
import {
  currentPlatform,
  escapeAppleScript,
  safeXdotoolKey,
  validateCoordinate,
  validateInt,
  validateKeypress,
  validateText,
} from "../platform/helpers.js";

describe("validateInt", () => {
  it("coerces valid numbers to integers", () => {
    expect(validateInt(42)).toBe(42);
    expect(validateInt(3.7)).toBe(4);
    expect(validateInt(0)).toBe(0);
    expect(validateInt(-5)).toBe(-5);
  });

  it("coerces string numbers", () => {
    expect(validateInt("100")).toBe(100);
    expect(validateInt("3.14")).toBe(3);
  });

  it("rejects NaN / Infinity / non-numeric strings", () => {
    expect(() => validateInt("hello")).toThrow("Invalid numeric value");
    expect(() => validateInt(Number.NaN)).toThrow("Invalid numeric value");
    expect(() => validateInt(Number.POSITIVE_INFINITY)).toThrow("Invalid numeric value");
    expect(() => validateInt(undefined)).toThrow("Invalid numeric value");
    expect(() => validateInt(null)).toThrow("Invalid numeric value");
  });
});

describe("validateCoordinate", () => {
  it("clamps within bounds", () => {
    expect(validateCoordinate(100, 200, 1920, 1080)).toEqual([100, 200]);
    expect(validateCoordinate(-10, -20, 1920, 1080)).toEqual([0, 0]);
    expect(validateCoordinate(3000, 2000, 1920, 1080)).toEqual([1920, 1080]);
  });

  it("rounds fractional coordinates", () => {
    expect(validateCoordinate(100.7, 200.3, 1920, 1080)).toEqual([101, 200]);
  });
});

describe("validateText", () => {
  it("accepts valid text", () => {
    expect(validateText("hello world")).toBe("hello world");
    expect(validateText("")).toBe("");
  });

  it("rejects text exceeding max length", () => {
    const longText = "x".repeat(5000);
    expect(() => validateText(longText, 4096)).toThrow("Text too long");
  });

  it("uses default max of 4096", () => {
    const justRight = "a".repeat(4096);
    expect(validateText(justRight)).toBe(justRight);
    const tooLong = "a".repeat(4097);
    expect(() => validateText(tooLong)).toThrow("Text too long");
  });

  it("rejects non-string", () => {
    expect(() => validateText(42 as unknown as string)).toThrow("Text must be a string");
  });
});

describe("validateKeypress", () => {
  it("accepts valid key strings", () => {
    expect(validateKeypress("Return")).toBe("Return");
    expect(validateKeypress("ctrl+c")).toBe("ctrl+c");
    expect(validateKeypress("F5")).toBe("F5");
    expect(validateKeypress("a")).toBe("a");
  });

  it("rejects empty string", () => {
    expect(() => validateKeypress("")).toThrow("non-empty string");
  });

  it("rejects key exceeding max length", () => {
    expect(() => validateKeypress("x".repeat(200))).toThrow("too long");
  });

  it("rejects keys with invalid characters", () => {
    expect(() => validateKeypress("key;rm -rf /")).toThrow("invalid characters");
    expect(() => validateKeypress("$(whoami)")).toThrow("invalid characters");
    expect(() => validateKeypress("key\ninjection")).toThrow("invalid characters");
  });
});

describe("escapeAppleScript", () => {
  it("wraps in quotes", () => {
    expect(escapeAppleScript("hello")).toBe('"hello"');
  });

  it("escapes backslashes and quotes", () => {
    expect(escapeAppleScript('say "hi"')).toBe('"say \\"hi\\""');
    expect(escapeAppleScript("path\\to")).toBe('"path\\\\to"');
  });
});

describe("safeXdotoolKey", () => {
  it("accepts known key names", () => {
    expect(safeXdotoolKey("Return")).toBe("Return");
    expect(safeXdotoolKey("Tab")).toBe("Tab");
    expect(safeXdotoolKey("Escape")).toBe("Escape");
    expect(safeXdotoolKey("F1")).toBe("F1");
    expect(safeXdotoolKey("space")).toBe("space");
    expect(safeXdotoolKey("ctrl")).toBe("ctrl");
  });

  it("accepts single printable ASCII characters", () => {
    expect(safeXdotoolKey("a")).toBe("a");
    expect(safeXdotoolKey("Z")).toBe("Z");
    expect(safeXdotoolKey("5")).toBe("5");
    expect(safeXdotoolKey("/")).toBe("/");
  });

  it("trims whitespace", () => {
    expect(safeXdotoolKey(" Return ")).toBe("Return");
  });

  it("rejects unknown multi-char keys", () => {
    expect(() => safeXdotoolKey("BADKEY")).toThrow("Invalid key for xdotool");
    expect(() => safeXdotoolKey("rm -rf")).toThrow("Invalid key for xdotool");
  });

  it("rejects non-ASCII characters", () => {
    expect(() => safeXdotoolKey("\x01")).toThrow("Invalid key for xdotool");
  });
});

describe("currentPlatform", () => {
  it("returns a valid platform string", () => {
    const p = currentPlatform();
    expect(["darwin", "linux", "win32"]).toContain(p);
  });
});
