/**
 * Verifies completionHasFailureMarkerWithoutPositiveEvidence.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import { completionHasFailureMarkerWithoutPositiveEvidence } from "../../src/evaluators/sub-agent-completion.js";

// The response evaluator uses this predicate to decide whether a sub-agent's
// `task_complete` is actually a FAILURE that must be routed back rather than
// relayed to the user as success. Regression coverage for the ordering bug
// where a positive count masked an explicit tool-failure marker.

describe("completionHasFailureMarkerWithoutPositiveEvidence", () => {
  it("flags an explicit tool-failure marker even when a positive count is also present", () => {
    // Prior bug: `found 5` short-circuited to "no failure" BEFORE the
    // `exit code 1` failure marker was ever checked, so this relayed as success.
    expect(
      completionHasFailureMarkerWithoutPositiveEvidence(
        "Ran the test suite: exit code 1. Also found 5 matching files.",
      ),
    ).toBe(true);
    expect(
      completionHasFailureMarkerWithoutPositiveEvidence(
        "permission denied while writing output; there are 3 candidates.",
      ),
    ).toBe(true);
  });

  it("does not flag a genuine positive result with no failure marker", () => {
    expect(
      completionHasFailureMarkerWithoutPositiveEvidence(
        "Search complete — found 5 matching files.",
      ),
    ).toBe(false);
  });

  it("flags a bare failure marker", () => {
    expect(
      completionHasFailureMarkerWithoutPositiveEvidence(
        "The build command exited with code 1.",
      ),
    ).toBe(true);
  });

  it("treats a verified/user-facing URL as decisive positive evidence (no route-back)", () => {
    // A reachable deploy is strong positive evidence; documented short-circuit.
    expect(
      completionHasFailureMarkerWithoutPositiveEvidence(
        "Deployed, though a lint step exited with code 1. https://example.test/apps/demo/",
      ),
    ).toBe(false);
    expect(
      completionHasFailureMarkerWithoutPositiveEvidence(
        "A step exited with code 1.",
        ["https://example.test/apps/demo/"],
      ),
    ).toBe(false);
  });
});
