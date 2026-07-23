/**
 * Coverage lane 5 for the changed-file gate (#16639): the coding-container
 * quota suite. Lane 1 deliberately leaves the __tests__ quota suites out —
 * their PGlite/module state collides with eliza-sandbox.test.ts in one
 * process — but composed ALONE the collision cannot occur. Runs in its own
 * gate process (coverage-gate.yml runs every changed test file isolated), and
 * its ElizaSandboxService line hits union-merge into the changed-file report.
 */
import { describe, expect, test } from "bun:test";
import "./__tests__/eliza-sandbox-coding-container-quota.test.ts";

describe("eliza-sandbox composite lane 5 (coding-container quota)", () => {
  test("runs under bun with its composed suite", () => {
    expect(typeof test).toBe("function");
  });
});
