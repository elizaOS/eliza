/**
 * Holds the execution boundary for `FormControl.pattern`.
 *
 * `control.pattern` is agent- or plugin-authored data that reaches
 * `validateField` (via `FormService.startSession` / `setField` / `submit`) and
 * the built-in `text` control type. These tests are responsible for three
 * things on both of those paths: an untrusted pattern is admitted only if it
 * belongs to the shared linear-time dialect, every refusal fails the field
 * closed rather than passing the value, and an adversarial pattern/value pair
 * completes under a hard out-of-process deadline instead of occupying the
 * event loop. They also pin the ordinary format patterns a form author is
 * expected to keep using, so tightening the dialect cannot silently break
 * honest fields.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getBuiltinType } from "./builtins";
import type { FormControl, ValidationResult } from "./types";
import {
  MAX_CONTROL_PATTERN_INPUT_LENGTH,
  MAX_CONTROL_PATTERN_LENGTH,
  testControlPattern,
  validateField,
} from "./validation";

function textControl(pattern: string): FormControl {
  return {
    key: "code",
    label: "Code",
    type: "text",
    pattern,
  };
}

function viaBuiltinText(pattern: string, value: string): ValidationResult {
  const builtin = getBuiltinType("text");
  if (!builtin?.validate) throw new Error("built-in text control is missing");
  return builtin.validate(value, textControl(pattern));
}

/**
 * Exponential-backtracking families that a nested-quantifier string scan does
 * not see. Only the first is a nested quantifier; every other entry is flat,
 * or alternation-based, or bounded, and each is paired with the near-miss
 * value that makes a backtracking engine blow up on a few dozen characters.
 */
const ADVERSARIAL_PATTERNS: Array<{ name: string; pattern: string }> = [
  { name: "nested quantifier", pattern: "^(a+)+$" },
  { name: "nested star", pattern: "^(a*)*$" },
  { name: "extra grouping layer", pattern: "^((a+))+$" },
  { name: "overlapping alternation", pattern: "^(a|aa)+$" },
  { name: "duplicate alternation branch", pattern: "^(a|a)+$" },
  { name: "quantified optional branch", pattern: "^(a?)+$" },
  { name: "two overlapping repetitions", pattern: "^a+a+$" },
  { name: "bounded inner repetition", pattern: "^(a{1,2})+$" },
  { name: "two bounded choices", pattern: "^a{1,40}a{1,40}$" },
  { name: "counted overlapping optionals", pattern: "^(a?){40}a{40}$" },
  { name: "word/space repetition", pattern: "^(\\w+\\s?)*$" },
  { name: "character-class repetition", pattern: "^([a-zA-Z]+)*$" },
  { name: "backreference ambiguity", pattern: "^(a+)\\1$" },
  { name: "lookahead", pattern: "^(?=a+)a+$" },
];

/** The near-miss value: long enough that a hang would be unmistakable. */
const NEAR_MISS = `${"a".repeat(4_000)}!`;

/**
 * Ordinary format patterns a form author writes. Tightening the dialect must
 * not take these away.
 */
const HONEST_PATTERNS: Array<{
  pattern: string;
  accepts: string;
  rejects: string;
}> = [
  { pattern: "^\\d+$", accepts: "12345", rejects: "12a" },
  { pattern: "^[A-Z]{3}-\\d{4}$", accepts: "ABC-1234", rejects: "ABC-123" },
  { pattern: "^[a-z0-9_-]{1,32}$", accepts: "ok_id", rejects: "NO" },
  { pattern: "^[A-Z]{2}[0-9]{4}$", accepts: "AB1234", rejects: "AB123" },
  { pattern: "^a{2,4}$", accepts: "aaa", rejects: "a" },
  { pattern: "\\S", accepts: "x", rejects: "   " },
  { pattern: "^[0-9]{3}\\.[0-9]{2}$", accepts: "123.45", rejects: "123,45" },
  { pattern: "^\\+[0-9]{7,15}$", accepts: "+12345678", rejects: "12345678" },
];

describe("testControlPattern dialect", () => {
  it("matches and rejects an admitted pattern normally", () => {
    expect(testControlPattern("^\\d+$", "123")).toEqual({ ok: true });
    expect(testControlPattern("^\\d+$", "abc")).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("refuses a pattern that does not compile at all", () => {
    expect(testControlPattern("(", "x")).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(testControlPattern("[a", "x")).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(testControlPattern("", "x")).toEqual({
      ok: false,
      reason: "unsupported",
    });
  });

  it.each(ADVERSARIAL_PATTERNS)(
    "refuses the $name family before it can execute",
    ({ pattern }) => {
      expect(testControlPattern(pattern, NEAR_MISS)).toEqual({
        ok: false,
        reason: "unsupported",
      });
    },
  );

  it("keeps escaped metacharacters as literals", () => {
    expect(testControlPattern("^a\\+b$", "a+b")).toEqual({ ok: true });
    expect(testControlPattern("^a\\+b$", "aab")).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(testControlPattern("^\\$[0-9]{2}$", "$40")).toEqual({ ok: true });
    expect(testControlPattern("^a\\.b$", "axb")).toEqual({
      ok: false,
      reason: "mismatch",
    });
    // An escaped delimiter is a literal, not an opened group or class.
    expect(testControlPattern("^\\(x\\)$", "(x)")).toEqual({ ok: true });
    expect(testControlPattern("^\\[x\\]$", "[x]")).toEqual({ ok: true });
  });

  it("handles character classes, including ones holding metacharacters", () => {
    expect(testControlPattern("^[a-c]{2}$", "ab")).toEqual({ ok: true });
    expect(testControlPattern("^[a-c]{2}$", "ad")).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(testControlPattern("^[^0-9]{3}$", "abc")).toEqual({ ok: true });
    expect(testControlPattern("^[()|]{1}$", "|")).toEqual({ ok: true });
    expect(testControlPattern("^[\\]]$", "]")).toEqual({ ok: true });
  });

  it("holds the exact pattern and input boundaries", () => {
    const atCap = `^${"a".repeat(MAX_CONTROL_PATTERN_LENGTH - 2)}$`;
    expect(atCap.length).toBe(MAX_CONTROL_PATTERN_LENGTH);
    expect(
      testControlPattern(atCap, "a".repeat(MAX_CONTROL_PATTERN_LENGTH - 2)),
    ).toEqual({ ok: true });
    expect(testControlPattern(`a${atCap}`, "a")).toEqual({
      ok: false,
      reason: "too-long",
    });

    const atInputCap = "a".repeat(MAX_CONTROL_PATTERN_INPUT_LENGTH);
    expect(testControlPattern("^a+$", atInputCap)).toEqual({ ok: true });
    expect(testControlPattern("^a+$", `${atInputCap}a`)).toEqual({
      ok: false,
      reason: "too-long",
    });
  });

  it.each(HONEST_PATTERNS)(
    "still runs the ordinary pattern $pattern",
    ({ pattern, accepts, rejects }) => {
      expect(testControlPattern(pattern, accepts)).toEqual({ ok: true });
      expect(testControlPattern(pattern, rejects)).toEqual({
        ok: false,
        reason: "mismatch",
      });
    },
  );
});

describe("validateField pattern host", () => {
  it("does not throw on a pattern that fails to compile", () => {
    expect(validateField("x", textControl("("))).toEqual({
      valid: false,
      error: "Code has invalid format",
    });
  });

  it.each(ADVERSARIAL_PATTERNS)(
    "fails closed on the $name family",
    ({ pattern }) => {
      expect(validateField(NEAR_MISS, textControl(pattern))).toEqual({
        valid: false,
        error: "Code has invalid format",
      });
    },
  );

  it.each(HONEST_PATTERNS)(
    "still validates against the ordinary pattern $pattern",
    ({ pattern, accepts, rejects }) => {
      expect(validateField(accepts, textControl(pattern)).valid).toBe(true);
      expect(validateField(rejects, textControl(pattern)).valid).toBe(false);
    },
  );
});

describe("builtin text control pattern host", () => {
  it("does not throw on a pattern that fails to compile", () => {
    expect(viaBuiltinText("(", "x")).toEqual({
      valid: false,
      error: "Invalid format",
    });
  });

  it.each(ADVERSARIAL_PATTERNS)(
    "fails closed on the $name family",
    ({ pattern }) => {
      expect(viaBuiltinText(pattern, NEAR_MISS)).toEqual({
        valid: false,
        error: "Invalid format",
      });
    },
  );

  it.each(HONEST_PATTERNS)(
    "still validates against the ordinary pattern $pattern",
    ({ pattern, accepts, rejects }) => {
      expect(viaBuiltinText(pattern, accepts).valid).toBe(true);
      expect(viaBuiltinText(pattern, rejects).valid).toBe(false);
    },
  );
});

/**
 * The assertions above prove the *answer*. This one proves the *boundedness*:
 * it runs the same production paths in a separate process under a hard
 * deadline, so a regression that reintroduces catastrophic backtracking is
 * reported as a killed child rather than hanging Vitest.
 */
describe("control-pattern execution deadline (out of process)", () => {
  const PROBE_DEADLINE_MS = 20_000;
  const PER_CASE_BUDGET_MS = 250;

  it("answers every adversarial pattern inside an out-of-process deadline", {
    timeout: PROBE_DEADLINE_MS + 20_000,
  }, () => {
    const probe = fileURLToPath(
      new URL("./__tests__/pattern-deadline-probe.ts", import.meta.url),
    );
    const cases = [
      ...ADVERSARIAL_PATTERNS.map(({ name, pattern }) => ({
        name,
        pattern,
        input: NEAR_MISS,
        expectValid: false,
      })),
      ...HONEST_PATTERNS.map(({ pattern, accepts }) => ({
        name: `honest ${pattern}`,
        pattern,
        input: accepts,
        expectValid: true,
      })),
    ];

    const result = spawnSync("bun", [probe, JSON.stringify(cases)], {
      encoding: "utf8",
      timeout: PROBE_DEADLINE_MS,
      killSignal: "SIGKILL",
    });

    expect(
      result.error,
      `could not run the out-of-process probe: ${result.error?.message}`,
    ).toBeUndefined();
    expect(
      result.signal,
      `the probe was killed after ${PROBE_DEADLINE_MS}ms - a control pattern is no longer bounded on the production path`,
    ).toBeNull();
    expect(result.status, result.stderr).toBe(0);

    const payload = JSON.parse(
      result.stdout.trim().split("\n").at(-1) ?? "{}",
    ) as {
      results: Array<{
        name: string;
        expectValid: boolean;
        validateFieldValid: boolean;
        builtinValid: boolean | null;
        validateFieldMs: number;
        builtinMs: number;
      }>;
    };

    expect(payload.results).toHaveLength(cases.length);
    for (const entry of payload.results) {
      expect(entry.validateFieldValid, entry.name).toBe(entry.expectValid);
      expect(entry.builtinValid, entry.name).toBe(entry.expectValid);
      expect(entry.validateFieldMs, entry.name).toBeLessThan(
        PER_CASE_BUDGET_MS,
      );
      expect(entry.builtinMs, entry.name).toBeLessThan(PER_CASE_BUDGET_MS);
    }
  });
});
