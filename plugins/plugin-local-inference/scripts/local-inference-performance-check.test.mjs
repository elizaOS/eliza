/**
 * Exercises relative local-inference performance policy and vacuous reports.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePerformance } from "./local-inference-performance-check.mjs";

const policy = {
  baseline: "baseline",
  minimumExecutedVariants: 2,
  minimumSamplesPerVariant: 3,
  backends: { cpu: { optimized: 0.75 } },
};
const row = (name, samples) => ({
  name,
  ok: true,
  runs: samples.map((tokPerSec) => ({ tokPerSec })),
});

test("uses same-run medians rather than absolute runner speed", () => {
  for (const scale of [0.25, 1, 100]) {
    const result = evaluatePerformance(
      {
        hardware: { backend: "cpu" },
        variants: [
          row(
            "baseline",
            [8, 10, 12].map((v) => v * scale),
          ),
          row(
            "optimized",
            [7, 8, 9].map((v) => v * scale),
          ),
        ],
      },
      policy,
    );
    assert.equal(result.comparisons[0].ratio, 0.8);
  }
});

test("rejects empty, skipped, undersampled, and regressed reports", () => {
  assert.throws(
    () =>
      evaluatePerformance(
        { hardware: { backend: "cpu" }, variants: [] },
        policy,
      ),
    /only 0 variants/,
  );
  assert.throws(
    () =>
      evaluatePerformance(
        {
          hardware: { backend: "cpu" },
          variants: [
            row("baseline", [1, 1, 1]),
            { name: "optimized", skipped: true },
          ],
        },
        policy,
      ),
    /only 1 variants/,
  );
  assert.throws(
    () =>
      evaluatePerformance(
        {
          hardware: { backend: "cpu" },
          variants: [row("baseline", [1, 1]), row("optimized", [1, 1, 1])],
        },
        policy,
      ),
    /expected at least 3/,
  );
  assert.throws(
    () =>
      evaluatePerformance(
        {
          hardware: { backend: "cpu" },
          variants: [
            row("baseline", [10, 10, 10]),
            row("optimized", [5, 5, 5]),
          ],
        },
        policy,
      ),
    /below 0.750/,
  );
});
