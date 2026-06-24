/**
 * CUA ⇄ browser parity matrix tests (#9476).
 *
 * The matrix is only trustworthy if it can't drift from the code. These tests
 * validate every browser capability verb against the LIVE promoted action
 * surface in both directions, and ratchet the coverage baseline against the
 * filesystem so closing a parity gap (e.g. adding a real-engine test lane) fails
 * here until the matrix records the win.
 */

import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { promoteSubactionsToActions } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { browserAction } from "../actions/browser.js";
import {
  BROWSER_COVERAGE_BASELINE,
  BROWSER_PARITY_MATRIX,
  browserParitySummary,
  validateBrowserMatrix,
} from "./browser-matrix.js";

/** Live registered action surface for the browser umbrella (parent + virtuals). */
const actionNames = promoteSubactionsToActions(browserAction).map(
  (a) => a.name,
);

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Recursively count real-engine test lanes under the plugin (excl. node_modules/dist). */
function countRealTestLanes(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      count += countRealTestLanes(full);
    } else if (
      entry.name.endsWith(".real.test.ts") ||
      entry.name.endsWith(".e2e.test.ts")
    ) {
      count += 1;
    }
  }
  return count;
}

describe("validateBrowserMatrix", () => {
  it("every `have` verb in the matrix is a registered BROWSER_* action", () => {
    const result = validateBrowserMatrix(actionNames);
    expect(
      result.ok,
      `parity drift:\n${result.problems
        .map((p) => `  - ${p.capability}: ${p.problem}`)
        .join("\n")}`,
    ).toBe(true);
    expect(result.confirmed).toBeGreaterThan(10);
  });

  it("flags a `have` verb that is not registered", () => {
    const result = validateBrowserMatrix(
      actionNames.filter((n) => n !== "BROWSER_CLICK"),
    );
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.capability === "click")).toBe(true);
  });

  it("flags a registered BROWSER_* action with no matrix entry", () => {
    const result = validateBrowserMatrix([...actionNames, "BROWSER_TELEPORT"]);
    expect(result.ok).toBe(false);
    expect(
      result.problems.some((p) => p.capability === "BROWSER_TELEPORT"),
    ).toBe(true);
  });

  it("na capabilities never declare a verb", () => {
    for (const cap of BROWSER_PARITY_MATRIX) {
      if (cap.status === "na") {
        expect(cap.verb, cap.id).toBeUndefined();
      }
    }
  });
});

describe("browserParitySummary", () => {
  it("counts have / partial / na to the matrix length", () => {
    const s = browserParitySummary();
    expect(s.have + s.partial + s.na).toBe(s.total);
    expect(s.total).toBe(BROWSER_PARITY_MATRIX.length);
    expect(s.have).toBeGreaterThan(10);
    expect(s.na).toBeGreaterThanOrEqual(3);
  });

  it("encodes the #9476 gap: no capability is real-tested or benchmarked yet", () => {
    const s = browserParitySummary();
    // This is the parity gap. When a real-engine lane or a benchmark wired
    // through plugin-browser lands, flip the relevant capability's
    // `tested`/`benchmarked` flag — these expectations will then need updating,
    // which is the point: the matrix can't silently claim progress it lacks.
    expect(s.realTested).toBe(0);
    expect(s.benchmarked).toBe(0);
    expect(s.mockTested).toBeGreaterThan(0);
  });
});

describe("BROWSER_COVERAGE_BASELINE (ratchet)", () => {
  it("realTestLanes matches the actual count of real/e2e lanes on disk", () => {
    const actual = countRealTestLanes(pluginRoot);
    expect(
      actual,
      `plugin-browser has ${actual} real/e2e test lane(s) but the parity ` +
        `baseline records ${BROWSER_COVERAGE_BASELINE.realTestLanes}. If you ` +
        `ADDED a real-engine lane (closing the #9476 parity gap), bump ` +
        `BROWSER_COVERAGE_BASELINE.realTestLanes to match and flip the ` +
        `relevant capability's \`tested\` flag to "real".`,
    ).toBe(BROWSER_COVERAGE_BASELINE.realTestLanes);
  });

  it("declares the matrix exists but the typed error contract does not (yet)", () => {
    expect(BROWSER_COVERAGE_BASELINE.hasParityMatrix).toBe(true);
    expect(BROWSER_COVERAGE_BASELINE.hasTypedErrorContract).toBe(false);
    expect(BROWSER_COVERAGE_BASELINE.benchmarksThroughPlugin).toBe(0);
  });
});
