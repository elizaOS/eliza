/**
 * Composes ProvisioningJobService claim, dispatch, and recovery suites into
 * one package-runner entry. Imported dispatch suites use per-test spies rather
 * than module-global DB mocks because Bun schedules imported-suite hooks
 * together, and replacing the DB helper while Drizzle loads the PGlite schema
 * can terminate the runner before it reports an assertion.
 */
import { describe, expect, test } from "bun:test";
import "./provisioning-jobs-agent-downgrade.test.ts";
import "./provisioning-jobs-execute-dispatch.test.ts";
import "./provisioning-jobs-lanes.test.ts";
import "./provisioning-jobs-scheduled-backup-sentinel.test.ts";
import "./provisioning-jobs-snapshot-gate.test.ts";
import "./provisioning-jobs-stale-threshold.test.ts";
import "./provisioning-jobs-stuck-reconcile.test.ts";

describe("provisioning-jobs composite lane", () => {
  test("runs under bun with its composed suites", () => {
    expect(typeof test).toBe("function");
  });
});
