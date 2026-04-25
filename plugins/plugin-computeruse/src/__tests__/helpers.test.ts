/**
 * Unit tests for platform/helpers.ts — input validation, command utilities.
 */
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

  it("rejects NaN and Infinity", () => {
    expect(() => validateInt(Number.NaN)).toThrow("Invalid numeric value");
    expect(() => validateInt(Number.POSITIVE_INFINITY)).toThrow(
      "Invalid numeric value",
    );
    expect(() => validateInt("hello")).toThrow("Invalid numeric value");
  });

  it("rejects null and blank input", () => {
    expect(() => validateInt(null)).toThrow("Invalid numeric value");
    expect(() => validateInt("")).toThrow("Invalid numeric value");
  });
});

describe("validateCoordinate", () => {
  it("passes valid coordinates through", () => {
    expect(validateCoordinate(100, 200, 1920, 1080)).toEqual([100, 200]);
  });

  it("clamps negative to zero", () => {
    expect(validateCoordinate(-10, -20, 1920, 1080)).toEqual([0, 0]);
  });

  it("clamps above max", () => {
    expect(validateCoordinate(3000, 2000, 1920, 1080)).toEqual([1920, 1080]);
  });

  it("rounds fractional coordinates", () => {
    expect(validateCoordinate(100.7, 200.3, 1920, 1080)).toEqual([101, 200]);
  });
});

describe("validateText", () => {
  it("accepts valid text", () => {
    expect(validateText("hello world")).toBe("hello world");
  });

  it("rejects text exceeding max length", () => {
    expect(() => validateText("x".repeat(5000), 4096)).toThrow("Text too long");
  });

  it("rejects non-string", () => {
    expect(() => validateText(42 as unknown as string)).toThrow(
      "Text must be a string",
    );
  });
});

describe("validateKeypress", () => {
  it("accepts valid key strings", () => {
    expect(validateKeypress("Return")).toBe("Return");
    expect(validateKeypress("ctrl+c")).toBe("ctrl+c");
  });

  it("rejects empty string", () => {
    expect(() => validateKeypress("")).toThrow("non-empty string");
  });

  it("rejects invalid characters", () => {
    expect(() => validateKeypress("key;rm -rf /")).toThrow(
      "invalid characters",
    );
    expect(() => validateKeypress("$(whoami)")).toThrow("invalid characters");
  });
});

describe("escapeAppleScript", () => {
  it("wraps in quotes and escapes", () => {
    expect(escapeAppleScript("hello")).toBe('"hello"');
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
  });

  it("accepts single ASCII characters", () => {
    expect(safeXdotoolKey("a")).toBe("a");
    expect(safeXdotoolKey("5")).toBe("5");
  });

  it("rejects unknown multi-char keys", () => {
    expect(() => safeXdotoolKey("BADKEY")).toThrow("Invalid key for xdotool");
  });
});

describe("key alias normalization", () => {
  it("normalizes common special-key aliases", () => {
    expect(canonicalKeyName("ESCAPE")).toBe("escape");
    expect(canonicalKeyName("Return")).toBe("enter");
    expect(canonicalKeyName("ArrowUp")).toBe("up");
    expect(canonicalKeyName("Page_Down")).toBe("pagedown");
  });

  it("maps keys to platform-specific formats", () => {
    expect(toCliclickKeyName("ESCAPE")).toBe("esc");
    expect(toXdotoolKeyName("ESCAPE")).toBe("Escape");
    expect(toWindowsSendKey("ESCAPE")).toBe("{ESC}");
    expect(toWindowsSendKey("F5")).toBe("{F5}");
  });
});

describe("currentPlatform", () => {
  it("returns a valid platform string", () => {
    const p = currentPlatform();
    expect(["darwin", "linux", "win32"]).toContain(p);
  });
});
