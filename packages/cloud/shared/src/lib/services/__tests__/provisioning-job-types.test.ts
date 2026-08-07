/**
 * Smoke tests for the job-type registry. These catch the cheap-to-make
 * mistakes that the orchestrator daemon can't recover from at runtime:
 * duplicate or malformed wire values that route to the wrong executor.
 */
import { describe, expect, test } from "bun:test";
import { JOB_TYPES } from "../provisioning-job-types";

describe("JOB_TYPES", () => {
  test("wire values are unique (no two symbols share a string)", () => {
    const values = Object.values(JOB_TYPES);
    expect(new Set(values).size).toBe(values.length);
  });

  test("wire values are snake_case (matches DB convention)", () => {
    for (const value of Object.values(JOB_TYPES)) {
      expect(value).toMatch(/^[a-z]+(?:_[a-z]+)+$/);
    }
  });
});
