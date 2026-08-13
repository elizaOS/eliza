/**
 * Offline unit tests for the CI auto-heal safety interlock: pure `decide()`
 * refusal paths and fail-closed AUTOHEAL_* env policy resolution. No network.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "ci-autoheal-context.mjs",
);

const autoheal = await import(
  new URL("../ci-autoheal-context.mjs", import.meta.url).href
);

const {
  DEFAULT_LOG_BUDGET,
  DEFAULT_MAX_ATTEMPTS,
  decide,
  excerptFailureLog,
  healBranchFor,
  parsePositiveSafeInteger,
  resolveAutohealPolicy,
  slugifyWorkflow,
} = autoheal;

function failedDevelopRun(overrides = {}) {
  return {
    status: "completed",
    conclusion: "failure",
    head_branch: "develop",
    name: "Unit Tests",
    ...overrides,
  };
}

describe("parsePositiveSafeInteger", () => {
  test("accepts complete positive safe-integer decimals", () => {
    expect(parsePositiveSafeInteger("1", "X")).toBe(1);
    expect(parsePositiveSafeInteger("3", "X")).toBe(3);
    expect(parsePositiveSafeInteger("0003", "X")).toBe(3);
    expect(parsePositiveSafeInteger(42, "X")).toBe(42);
  });

  test("rejects malformed, padded, signed, fractional, zero, and non-finite values", () => {
    for (const value of [
      "abc",
      "3junk",
      " 4 ",
      "1.5",
      "+2",
      "-1",
      "0",
      "",
      " ",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1.5,
      0,
      -3,
    ]) {
      expect(() => parsePositiveSafeInteger(value, "LABEL")).toThrow(/LABEL/);
    }
  });
});

describe("resolveAutohealPolicy", () => {
  test("keeps historical defaults when overrides are unset or empty", () => {
    expect(resolveAutohealPolicy({})).toEqual({
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      logBudget: DEFAULT_LOG_BUDGET,
    });
    expect(
      resolveAutohealPolicy({
        AUTOHEAL_MAX_ATTEMPTS: "",
        AUTOHEAL_LOG_BUDGET: "",
      }),
    ).toEqual({
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      logBudget: DEFAULT_LOG_BUDGET,
    });
  });

  test("accepts valid explicit overrides", () => {
    expect(
      resolveAutohealPolicy({
        AUTOHEAL_MAX_ATTEMPTS: "0005",
        AUTOHEAL_LOG_BUDGET: "00050000",
      }),
    ).toEqual({ maxAttempts: 5, logBudget: 50000 });
  });

  test("fails closed on malformed attempt ceiling before any network work", () => {
    expect(() =>
      resolveAutohealPolicy({ AUTOHEAL_MAX_ATTEMPTS: "abc" }),
    ).toThrow(/AUTOHEAL_MAX_ATTEMPTS/);
    expect(() =>
      resolveAutohealPolicy({ AUTOHEAL_MAX_ATTEMPTS: "3junk" }),
    ).toThrow(/AUTOHEAL_MAX_ATTEMPTS/);
    expect(() =>
      resolveAutohealPolicy({ AUTOHEAL_MAX_ATTEMPTS: "1.5" }),
    ).toThrow(/AUTOHEAL_MAX_ATTEMPTS/);
    expect(() => resolveAutohealPolicy({ AUTOHEAL_MAX_ATTEMPTS: "0" })).toThrow(
      /AUTOHEAL_MAX_ATTEMPTS/,
    );
  });

  test("fails closed on malformed log budget", () => {
    expect(() =>
      resolveAutohealPolicy({ AUTOHEAL_LOG_BUDGET: "junk" }),
    ).toThrow(/AUTOHEAL_LOG_BUDGET/);
    expect(() =>
      resolveAutohealPolicy({ AUTOHEAL_LOG_BUDGET: "120000.5" }),
    ).toThrow(/AUTOHEAL_LOG_BUDGET/);
    expect(() => resolveAutohealPolicy({ AUTOHEAL_LOG_BUDGET: "0" })).toThrow(
      /AUTOHEAL_LOG_BUDGET/,
    );
  });

  test("rejects whitespace-padded overrides for both policy knobs", () => {
    expect(() =>
      resolveAutohealPolicy({ AUTOHEAL_MAX_ATTEMPTS: " 4 " }),
    ).toThrow(/AUTOHEAL_MAX_ATTEMPTS/);
    expect(() =>
      resolveAutohealPolicy({ AUTOHEAL_LOG_BUDGET: " 50000 " }),
    ).toThrow(/AUTOHEAL_LOG_BUDGET/);
    expect(() =>
      resolveAutohealPolicy({ AUTOHEAL_MAX_ATTEMPTS: "   " }),
    ).toThrow(/AUTOHEAL_MAX_ATTEMPTS/);
  });

  test("real CLI rejects padded overrides before required GitHub configuration", () => {
    for (const [name, value] of [
      ["AUTOHEAL_MAX_ATTEMPTS", " 4 "],
      ["AUTOHEAL_LOG_BUDGET", " 50000 "],
    ]) {
      const result = spawnSync(process.execPath, [SCRIPT], {
        encoding: "utf8",
        env: { [name]: value },
        timeout: 5_000,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(name);
      expect(result.stderr).not.toContain("GITHUB_REPOSITORY");
    }
  });
});

describe("decide", () => {
  test("proceeds for a completed failure on develop within the attempt ceiling", () => {
    expect(
      decide({
        run: failedDevelopRun(),
        openHealPr: null,
        attempt: 1,
        maxAttempts: 3,
      }),
    ).toEqual({ proceed: true, reason: "" });
  });

  test("refuses runs that are not completed failures", () => {
    expect(
      decide({
        run: failedDevelopRun({ status: "in_progress", conclusion: null }),
        openHealPr: null,
        attempt: 1,
      }).proceed,
    ).toBe(false);
    expect(
      decide({
        run: failedDevelopRun({ conclusion: "success" }),
        openHealPr: null,
        attempt: 1,
      }).proceed,
    ).toBe(false);
  });

  test("refuses non-healable branches", () => {
    const decision = decide({
      run: failedDevelopRun({ head_branch: "feat/something" }),
      openHealPr: null,
      attempt: 1,
    });
    expect(decision.proceed).toBe(false);
    expect(decision.reason).toMatch(/not healable/);
  });

  test("enforces the hard attempt ceiling", () => {
    const decision = decide({
      run: failedDevelopRun(),
      openHealPr: null,
      attempt: 4,
      maxAttempts: 3,
    });
    expect(decision).toEqual({
      proceed: false,
      reason:
        "attempt 4 exceeds the ceiling of 3; a human must look at this failure",
    });
  });

  test("refuses a second concurrent heal PR on develop", () => {
    const decision = decide({
      run: failedDevelopRun(),
      openHealPr: { number: 42 },
      attempt: 1,
      maxAttempts: 3,
    });
    expect(decision.proceed).toBe(false);
    expect(decision.reason).toMatch(/#42/);
  });

  test("allows continued healing on the heal branch even with an open PR", () => {
    expect(
      decide({
        run: failedDevelopRun({
          head_branch: healBranchFor("Unit Tests"),
        }),
        openHealPr: { number: 42 },
        attempt: 2,
        maxAttempts: 3,
      }),
    ).toEqual({ proceed: true, reason: "" });
  });
});

describe("excerptFailureLog", () => {
  test("truncates to a finite positive budget", () => {
    const raw = Array.from({ length: 200 }, (_, i) =>
      i === 100 ? "##[error] boom" : `line ${i}`,
    ).join("\n");
    const result = excerptFailureLog(raw, 80);
    expect(result.truncated).toBe(true);
    expect(result.excerpt.length).toBeLessThanOrEqual(80 + 40);
    expect(result.matchedErrors).toBeGreaterThanOrEqual(1);
  });
});

describe("slugifyWorkflow / healBranchFor", () => {
  test("produces a stable branch-safe slug", () => {
    expect(slugifyWorkflow("Unit Tests")).toBe("unit-tests");
    expect(healBranchFor("Unit Tests")).toBe("claude/autoheal/unit-tests");
  });

  test("rejects names that collapse to an empty slug", () => {
    expect(() => slugifyWorkflow("!!!")).toThrow(/empty slug/);
  });
});
