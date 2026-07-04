/**
 * Browser parity matrix tests against the live BROWSER action schema.
 */

import { listSubactionsFromParameters } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { browserAction } from "../actions/browser.js";
import { browserPlugin } from "../plugin.js";
import {
  BROWSER_PARITY_MATRIX,
  browserParitySummary,
  validateBrowserParityMatrix,
} from "./browser-matrix.js";

const actionNames = (browserPlugin.actions ?? []).map((action) => action.name);
const browserActionValues = listSubactionsFromParameters(
  browserAction.parameters,
);

describe("validateBrowserParityMatrix", () => {
  it("matches the live promoted BROWSER action surface", () => {
    const result = validateBrowserParityMatrix(
      actionNames,
      browserActionValues,
    );
    expect(
      result.ok,
      `browser parity drift:\n${result.problems
        .map((problem) => `  - ${problem.capability}: ${problem.problem}`)
        .join("\n")}`,
    ).toBe(true);
    expect(result.confirmed).toBeGreaterThan(20);
  });

  it("flags a missing registered browser verb", () => {
    const result = validateBrowserParityMatrix(
      actionNames.filter((name) => name !== "BROWSER_OPEN"),
      browserActionValues,
    );
    expect(result.ok).toBe(false);
    expect(
      result.problems.some((problem) => problem.capability === "open"),
    ).toBe(true);
  });

  it("flags a schema action value that has no matrix row", () => {
    const result = validateBrowserParityMatrix(actionNames, [
      ...browserActionValues,
      "future_browser_action",
    ]);
    expect(result.ok).toBe(false);
    expect(
      result.problems.some(
        (problem) => problem.capability === "future_browser_action",
      ),
    ).toBe(true);
  });

  it("keeps status counts aligned to the matrix length", () => {
    const summary = browserParitySummary();
    expect(summary.have + summary.partial + summary.planned + summary.na).toBe(
      summary.total,
    );
    expect(summary.total).toBe(BROWSER_PARITY_MATRIX.length);
    expect(summary.have).toBeGreaterThan(20);
    expect(summary.na).toBe(0);
  });

  it("does not allow duplicate action values or promoted verbs", () => {
    const actionValues = new Set<string>();
    const elizaVerbs = new Set<string>();
    for (const capability of BROWSER_PARITY_MATRIX) {
      if (capability.actionValue) {
        expect(
          actionValues.has(capability.actionValue),
          `duplicate actionValue ${capability.actionValue}`,
        ).toBe(false);
        actionValues.add(capability.actionValue);
      }
      if (capability.elizaVerb) {
        expect(
          elizaVerbs.has(capability.elizaVerb),
          `duplicate elizaVerb ${capability.elizaVerb}`,
        ).toBe(false);
        elizaVerbs.add(capability.elizaVerb);
      }
    }
  });
});
