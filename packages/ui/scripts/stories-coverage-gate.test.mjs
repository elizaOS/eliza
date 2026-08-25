/** Tests deterministic story-coverage regression comparison without scanning source files. */

import assert from "node:assert/strict";
import test from "node:test";
import {
  compareCoverage,
  validateCoverageSummary,
} from "./stories-coverage-gate.mjs";

function summary(componentFiles, withStories, missing) {
  return { componentFiles, withStories, missing };
}

test("accepts unchanged coverage and improvements", () => {
  assert.deepEqual(
    compareCoverage(
      summary(3, 2, ["src/components/legacy.tsx"]),
      summary(3, 2, ["src/components/legacy.tsx"]),
    ).failures,
    [],
  );
  assert.deepEqual(
    compareCoverage(
      summary(4, 3, ["src/components/legacy.tsx"]),
      summary(3, 2, ["src/components/legacy.tsx"]),
    ).failures,
    [],
  );
});

test("rejects a lower story count even when its ratio improves", () => {
  assert.match(
    compareCoverage(
      summary(3, 1, ["src/components/first.tsx", "src/components/second.tsx"]),
      summary(6, 2, [
        "src/components/first.tsx",
        "src/components/fourth.tsx",
        "src/components/second.tsx",
        "src/components/third.tsx",
      ]),
    ).failures.join("\n"),
    /withStories decreased/,
  );
});

test("rejects a lower ratio even when story count increases", () => {
  assert.match(
    compareCoverage(
      summary(6, 3, [
        "src/components/first.tsx",
        "src/components/second.tsx",
        "src/components/third.tsx",
      ]),
      summary(3, 2, ["src/components/first.tsx"]),
    ).failures.join("\n"),
    /coverage ratio decreased/,
  );
});

test("rejects a newly missing story when aggregate coverage is unchanged", () => {
  const comparison = compareCoverage(
    summary(3, 2, ["src/components/second.tsx"]),
    summary(3, 2, ["src/components/first.tsx"]),
  );

  assert.deepEqual(comparison.newMissing, ["src/components/second.tsx"]);
  assert.match(
    comparison.failures.join("\n"),
    /new components without stories/,
  );
});

test("refuses malformed summaries", () => {
  assert.throws(
    () => validateCoverageSummary(summary(0, 0, [])),
    /positive integer/,
  );
  assert.throws(
    () => validateCoverageSummary(summary(2, 3, [])),
    /between 0 and componentFiles/,
  );
  assert.throws(
    () => compareCoverage(summary(2, 1, ["src/components/first.tsx"]), {}),
    /baseline/,
  );
  assert.throws(
    () => validateCoverageSummary(summary(2, 1, [])),
    /missing length/,
  );
});
