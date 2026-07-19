/**
 * Coverage lane composing the ProvisioningJobService suites for the
 * changed-file gate (#16639) — same pattern as the docker-sandbox-provider
 * and orchestrator composites: the worker's claim/dispatch/recovery surface
 * spans many co-located suites, and a worker-touching change needs their
 * UNION to exercise the class.
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
