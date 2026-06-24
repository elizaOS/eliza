/**
 * trycua/cua parity matrix (#9170 M14).
 *
 * The matrix is only trustworthy if it can't drift from the code, so the key
 * test validates every `have` verb against the LIVE registered action surface.
 * Add a verb to the matrix without registering it (or rename a promoted action)
 * and this fails.
 */

import { describe, expect, it } from "vitest";
import { computerUsePlugin } from "../index.js";
import {
  PARITY_MATRIX,
  parityCoverageByOs,
  parityMatrixSummary,
  validateParityCoverage,
  validateParityMatrix,
} from "../parity/parity-matrix.js";

const actionNames = (computerUsePlugin.actions ?? []).map((a) => a.name);

describe("validateParityMatrix", () => {
  it("every `have` verb in the matrix is a registered action", () => {
    const result = validateParityMatrix(actionNames);
    expect(
      result.ok,
      `parity drift:\n${result.problems
        .map((p) => `  - ${p.capability}: ${p.problem}`)
        .join("\n")}`,
    ).toBe(true);
    expect(result.confirmed).toBeGreaterThan(0);
  });

  it("flags a `have` verb that is not registered", () => {
    const result = validateParityMatrix(
      actionNames.filter((n) => n !== "COMPUTER_USE_OPEN"),
    );
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.capability === "open")).toBe(true);
  });

  it("na capabilities never declare an elizaVerb", () => {
    for (const cap of PARITY_MATRIX) {
      if (cap.status === "na") {
        expect(cap.elizaVerb, `${cap.id}`).toBeUndefined();
      }
    }
  });
});

describe("parityMatrixSummary", () => {
  it("counts have / partial / na to the matrix length", () => {
    const s = parityMatrixSummary();
    expect(s.have + s.partial + s.na).toBe(s.total);
    expect(s.total).toBe(PARITY_MATRIX.length);
    expect(s.have).toBeGreaterThan(10);
    expect(s.na).toBeGreaterThanOrEqual(3);
  });
});

describe("validateParityCoverage", () => {
  it("every per-OS coverage record in the matrix is well-formed", () => {
    const result = validateParityCoverage();
    expect(
      result.ok,
      `coverage drift:\n${result.problems
        .map((p) => `  - ${p.capability}: ${p.problem}`)
        .join("\n")}`,
    ).toBe(true);
    expect(result.confirmed).toBeGreaterThan(0);
  });
});

describe("parityCoverageByOs", () => {
  it("rolls up covered/planned/na for all four OSes", () => {
    const rollup = parityCoverageByOs();
    expect(rollup.map((r) => r.os).sort()).toEqual([
      "aosp",
      "linux",
      "macos",
      "windows",
    ]);
    const nonNa = PARITY_MATRIX.filter((c) => c.status !== "na").length;
    for (const r of rollup) {
      // every non-na capability is accounted for exactly once per OS
      expect(r.covered + r.planned + r.na).toBe(nonNa);
    }
    // windows is the primary dev box → at least one verb is covered there
    const windows = rollup.find((r) => r.os === "windows");
    expect(windows?.covered).toBeGreaterThan(0);
  });
});
