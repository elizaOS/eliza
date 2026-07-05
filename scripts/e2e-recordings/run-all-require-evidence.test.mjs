// #13624: the e2e-recordings sweep must not go green having recorded nothing.
// classifyRunResults folds a `skipped` suite into `failed` under
// --require-evidence (auto-on under CI) so a headless runner that captured zero
// artifacts fails the run, while preserving the soft-skip behavior otherwise.
import { describe, expect, it } from "vitest";
import { classifyRunResults } from "./run-all.mjs";

const passedSuite = { name: "app", passed: true, skipped: false, exitCode: 0 };
const failedSuite = {
  name: "cloud",
  passed: false,
  skipped: false,
  exitCode: 1,
};
const skippedSuite = {
  name: "ios-sim",
  passed: false,
  skipped: true,
  exitCode: 77,
  reason: "no booted simulator",
};

describe("classifyRunResults require-evidence contract (#13624)", () => {
  it("without require-evidence: a skip stays a soft skip and does not fail the run", () => {
    const c = classifyRunResults([passedSuite, skippedSuite], false);
    expect(c.passed.map((r) => r.name)).toEqual(["app"]);
    expect(c.softSkipped.map((r) => r.name)).toEqual(["ios-sim"]);
    expect(c.failed).toEqual([]);
    expect(c.shouldFail).toBe(false);
  });

  it("REGRESSION: WITH require-evidence a skipped suite becomes a failure (green-with-nothing closed)", () => {
    const c = classifyRunResults([passedSuite, skippedSuite], true);
    // The skip is no longer counted as a benign skip...
    expect(c.softSkipped).toEqual([]);
    // ...it is folded into failed and the run must fail.
    expect(c.failed.map((r) => r.name)).toEqual(["ios-sim"]);
    expect(c.skippedButRequired.map((r) => r.name)).toEqual(["ios-sim"]);
    expect(c.shouldFail).toBe(true);
  });

  it("a real non-zero failure always fails the run, require-evidence or not", () => {
    expect(classifyRunResults([failedSuite], false).shouldFail).toBe(true);
    expect(classifyRunResults([failedSuite], true).shouldFail).toBe(true);
  });

  it("an all-passing run stays green under require-evidence", () => {
    const c = classifyRunResults([passedSuite], true);
    expect(c.shouldFail).toBe(false);
    expect(c.failed).toEqual([]);
    expect(c.skippedButRequired).toEqual([]);
  });

  it("mixed: pass + real-fail + skip under require-evidence folds skip AND fail together", () => {
    const c = classifyRunResults(
      [passedSuite, failedSuite, skippedSuite],
      true,
    );
    expect(c.passed.map((r) => r.name)).toEqual(["app"]);
    expect(c.failed.map((r) => r.name).sort()).toEqual(["cloud", "ios-sim"]);
    expect(c.shouldFail).toBe(true);
  });

  it("preserves the skip reason so the failure line can explain what was missing", () => {
    const c = classifyRunResults([skippedSuite], true);
    expect(c.failed[0].reason).toBe("no booted simulator");
  });
});
