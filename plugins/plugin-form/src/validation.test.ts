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
  clearTypeHandlers,
  formatValue,
  MAX_CONTROL_PATTERN_INPUT_LENGTH,
  MAX_CONTROL_PATTERN_LENGTH,
  parseBoolean,
  parseValue,
  registerTypeHandler,
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

/**
 * A boolean answer crosses three call sites — validation, extraction parsing and
 * display — and each used to carry its own literal list. Validation accepted
 * both directions while the parser held only the true-like literals, so "no",
 * "false", "0" and "off" were coerced to `false` and an unknown string such as
 * "maybe" was coerced to `false` too, while display rendered any non-empty
 * string — including "no" — as a confident "Yes". These assert the shared
 * contract at the exported boundary the form service itself calls.
 */
describe("boolean contract", () => {
  const booleanControl: FormControl = {
    key: "optIn",
    label: "Opt in",
    type: "boolean",
  };

  const trueLiterals = ["true", "yes", "1", "on"];
  const falseLiterals = ["false", "no", "0", "off"];

  it("resolves every accepted literal in both directions", () => {
    for (const literal of trueLiterals) {
      expect(parseBoolean(literal)).toEqual({ known: true, value: true });
      expect(parseBoolean(literal.toUpperCase())).toEqual({
        known: true,
        value: true,
      });
      expect(validateField(literal, booleanControl).valid).toBe(true);
    }
    for (const literal of falseLiterals) {
      expect(parseBoolean(literal)).toEqual({ known: true, value: false });
      expect(validateField(literal, booleanControl).valid).toBe(true);
    }
    expect(parseBoolean(true)).toEqual({ known: true, value: true });
    expect(parseBoolean(false)).toEqual({ known: true, value: false });
  });

  it("reports unknown input instead of guessing a boolean", () => {
    for (const unknown of ["maybe", "2", "yep", "perhaps"]) {
      expect(parseBoolean(unknown)).toEqual({ known: false });
      expect(validateField(unknown, booleanControl).valid).toBe(false);
    }
    expect(parseBoolean(null)).toEqual({ known: false });
    expect(parseBoolean("")).toEqual({ known: false });
    expect(validateField("", booleanControl).valid).toBe(true);
    expect(validateField("", { ...booleanControl, required: true }).valid).toBe(
      false,
    );
  });

  it("accepts a boolean literal with surrounding spaces", () => {
    expect(parseBoolean(" yes ")).toEqual({ known: true, value: true });
    expect(parseBoolean(" no ")).toEqual({ known: true, value: false });
    expect(validateField(" yes ", booleanControl).valid).toBe(true);
    expect(formatValue(" YES ", booleanControl)).toBe("Yes");
    expect(parseBoolean(" ")).toEqual({ known: false });
  });

  it("keeps an unrecognised extraction as its original string", () => {
    expect(parseValue("maybe", booleanControl)).toBe("maybe");
    expect(parseValue("no", booleanControl)).toBe(false);
    expect(parseValue("YES", booleanControl)).toBe(true);
  });

  it("renders false-like and unknown persisted values honestly", () => {
    for (const literal of falseLiterals) {
      expect(formatValue(literal, booleanControl)).toBe("No");
    }
    for (const literal of trueLiterals) {
      expect(formatValue(literal, booleanControl)).toBe("Yes");
    }
    expect(formatValue(true, booleanControl)).toBe("Yes");
    expect(formatValue(false, booleanControl)).toBe("No");
    // Unknown input is shown as-is rather than as a confident answer.
    expect(formatValue("maybe", booleanControl)).toBe("maybe");
  });
});

describe("builtin format contracts", () => {
  it("applies display rules with the registered builtin handlers", () => {
    const booleanControl: FormControl = {
      key: "optIn",
      label: "Opt in",
      type: "boolean",
    };
    const selectControl: FormControl = {
      key: "country",
      label: "Country",
      type: "select",
      options: [{ value: "US", label: "United States" }],
    };

    expect(
      formatValue(" YES ", booleanControl, getBuiltinType("boolean")),
    ).toBe("Yes");
    expect(formatValue("no", booleanControl, getBuiltinType("boolean"))).toBe(
      "No",
    );
    expect(formatValue("US", selectControl, getBuiltinType("select"))).toBe(
      "United States",
    );
  });
});

describe("validateField currency numbers", () => {
  const control = { key: "amount", label: "Amount", type: "number" as const };
  it.each(["1,2", "12,34", "1,,234", "1.2,3"])(
    "rejects malformed comma grouping %s",
    (value) => {
      expect(validateField(value, control).valid).toBe(false);
      expect(parseValue(value, control)).toBe(value);
    },
  );
  it("rejects a dollar sign inside the digits", () => {
    expect(validateField("1$2", control).valid).toBe(false);
    expect(parseValue("1$2", control)).toBe("1$2");
  });

  it("rejects a trailing dollar sign", () => {
    expect(validateField("50$", control).valid).toBe(false);
    expect(parseValue("50$", control)).toBe("50$");
  });

  it("still accepts a leading dollar sign and thousands commas", () => {
    expect(validateField("$50", control).valid).toBe(true);
    expect(parseValue("$50", control)).toBe(50);
    expect(parseValue("$1,234", control)).toBe(1234);
    expect(parseValue("1,234", control)).toBe(1234);
  });

  it("accepts a sign before the dollar sign", () => {
    expect(validateField("-$50", control).valid).toBe(true);
    expect(parseValue("-$50", control)).toBe(-50);
    expect(parseValue("-$1,234.50", control)).toBe(-1234.5);
    expect(parseValue("+$5", control)).toBe(5);
    expect(parseValue("$-50", control)).toBe(-50);
  });
});

/**
 * Legacy type-handler override vs the built-in type switch (`validateField`).
 *
 * Pins the two invariants that matter when a legacy `registerTypeHandler`
 * entry shadows a built-in type name:
 * (a) the legacy handler's grammar owns the decision and the built-in switch
 *     below the custom-handler block is not reached;
 * (b) with no legacy handler registered, the built-in switch stays reachable,
 *     so the early `validateText` return is not a blanket bypass of built-in
 *     validation.
 */
describe("legacy type-handler override (validateField)", () => {
  const emailControl: FormControl = {
    key: "email",
    label: "Email",
    type: "email",
  };

  it("honors the legacy grammar and skips the built-in switch", () => {
    const builtinEmail = getBuiltinType("email");
    if (!builtinEmail?.validate)
      throw new Error("built-in email control is missing");
    clearTypeHandlers();
    registerTypeHandler("email", {
      validate: (value) =>
        String(value).endsWith("@localhost")
          ? { valid: true }
          : { valid: false, error: "legacy email grammar" },
    });
    // "alice@localhost" fails the built-in email grammar but satisfies the
    // legacy one: the built-in switch must not override it back to invalid.
    expect(
      validateField("alice@localhost", emailControl, builtinEmail).valid,
    ).toBe(true);
    // A value the legacy grammar rejects stays rejected.
    expect(
      validateField("alice@example.com", emailControl, builtinEmail).valid,
    ).toBe(false);
    clearTypeHandlers();
  });

  it("still enforces number min/max under a legacy number override", () => {
    const builtinNumber = getBuiltinType("number");
    if (!builtinNumber?.validate)
      throw new Error("built-in number control is missing");
    const control: FormControl = {
      key: "qty",
      label: "Qty",
      type: "number",
      min: 1,
      max: 10,
    };
    clearTypeHandlers();
    registerTypeHandler("number", {
      validate: (value) => ({ valid: !Number.isNaN(Number(value)) }),
    });
    expect(validateField("500", control, builtinNumber)).toEqual({
      valid: false,
      error: "Qty must be at most 10",
    });
    expect(validateField(0, control, builtinNumber).valid).toBe(false);
    expect(validateField("5", control, builtinNumber).valid).toBe(true);
    // No controlType resolved: the legacy handler still cannot lift bounds.
    expect(validateField("500", control).valid).toBe(false);
    clearTypeHandlers();
  });

  it("reads bounds through the legacy handler's parse", () => {
    const builtinNumber = getBuiltinType("number");
    if (!builtinNumber?.validate)
      throw new Error("built-in number control is missing");
    const control: FormControl = {
      key: "amount",
      label: "Amount",
      type: "number",
      max: 100,
    };
    const parseLocalized = (value: string) =>
      Number(value.replace(/\./g, "").replace(",", "."));
    clearTypeHandlers();
    registerTypeHandler("number", {
      validate: (value) => ({
        valid: Number.isFinite(parseLocalized(String(value))),
      }),
      parse: parseLocalized,
    });
    // "1.234,5" is 1234.5 in the legacy grammar, which exceeds max.
    expect(validateField("1.234,5", control, builtinNumber).valid).toBe(false);
    expect(validateField("12,5", control, builtinNumber).valid).toBe(true);
    clearTypeHandlers();
  });

  it("fails closed when a bounded value cannot be read as a number", () => {
    const builtinNumber = getBuiltinType("number");
    if (!builtinNumber?.validate)
      throw new Error("built-in number control is missing");
    const control: FormControl = {
      key: "qty",
      label: "Qty",
      type: "number",
      max: 10,
    };
    clearTypeHandlers();
    registerTypeHandler("number", { validate: () => ({ valid: true }) });
    expect(validateField("lots", control, builtinNumber)).toEqual({
      valid: false,
      error: "Qty must be a number",
    });
    clearTypeHandlers();
  });

  it("still enforces select options and date bounds under legacy overrides", () => {
    const builtinSelect = getBuiltinType("select");
    const builtinDate = getBuiltinType("date");
    if (!builtinSelect?.validate || !builtinDate?.validate)
      throw new Error("built-in select/date control is missing");
    clearTypeHandlers();
    registerTypeHandler("select", { validate: () => ({ valid: true }) });
    registerTypeHandler("date", { validate: () => ({ valid: true }) });
    const select: FormControl = {
      key: "plan",
      label: "Plan",
      type: "select",
      options: [{ value: "basic", label: "Basic" }],
    };
    expect(validateField("enterprise", select, builtinSelect).valid).toBe(
      false,
    );
    expect(validateField("basic", select, builtinSelect).valid).toBe(true);
    const date: FormControl = {
      key: "start",
      label: "Start",
      type: "date",
      max: Date.UTC(2026, 0, 1),
    };
    expect(validateField("2027-03-01", date, builtinDate)).toEqual({
      valid: false,
      error: "Start is too late",
    });
    expect(validateField("2025-03-01", date, builtinDate).valid).toBe(true);
    clearTypeHandlers();
  });

  it("keeps the built-in switch reachable with no legacy handler", () => {
    const builtinEmail = getBuiltinType("email");
    if (!builtinEmail?.validate)
      throw new Error("built-in email control is missing");
    clearTypeHandlers();
    // Satisfies validateText alone, so only the built-in switch rejects it.
    expect(
      validateField("not-an-email", emailControl, builtinEmail).valid,
    ).toBe(false);
    expect(
      validateField("alice@example.com", emailControl, builtinEmail).valid,
    ).toBe(true);
    clearTypeHandlers();
  });
});
