/**
 * Control-pattern compile/test must fail closed. Origin validateText did
 * `new RegExp(control.pattern)` with no try/catch, so "(" throws SyntaxError
 * and `^(a+)+$` against a short non-match hangs the event loop.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_CONTROL_PATTERN_INPUT_LENGTH,
  MAX_CONTROL_PATTERN_LENGTH,
  testControlPattern,
  validateField,
} from "./validation";
import type { FormControl } from "./types";

function textControl(pattern: string): FormControl {
  return {
    key: "code",
    label: "Code",
    type: "text",
    pattern,
  };
}

describe("testControlPattern", () => {
  it("matches and rejects valid patterns normally", () => {
    expect(testControlPattern("^\\d+$", "123")).toEqual({ ok: true });
    expect(testControlPattern("^\\d+$", "abc")).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("returns invalid instead of throwing on a broken pattern", () => {
    expect(testControlPattern("(", "x")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("refuses nested quantifiers without running them", () => {
    const start = Date.now();
    const result = testControlPattern("^(a+)+$", `${"a".repeat(28)}!`);
    expect(Date.now() - start).toBeLessThan(50);
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses over-long patterns and values before compile", () => {
    expect(
      testControlPattern("a".repeat(MAX_CONTROL_PATTERN_LENGTH + 1), "a"),
    ).toEqual({ ok: false, reason: "too-long" });
    expect(
      testControlPattern(
        "^a+$",
        "a".repeat(MAX_CONTROL_PATTERN_INPUT_LENGTH + 1),
      ),
    ).toEqual({ ok: false, reason: "too-long" });
  });
});

describe("validateField pattern host", () => {
  it("does not throw on an invalid user pattern", () => {
    expect(validateField("x", textControl("("))).toEqual({
      valid: false,
      error: "Code has invalid format",
    });
  });

  it("does not hang on a nested-quantifier user pattern", () => {
    const start = Date.now();
    const result = validateField(`${"a".repeat(28)}!`, textControl("^(a+)+$"));
    expect(Date.now() - start).toBeLessThan(50);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/invalid format/);
  });

  it("still accepts a linear pattern", () => {
    expect(validateField("12345", textControl("^\\d+$")).valid).toBe(true);
    expect(validateField("abc", textControl("^\\d+$")).valid).toBe(false);
  });
});
