import { expect, test } from "bun:test";
import { readAppsWorkerConfig } from "../src/apps";
import {
  allowsOrphanReconciliation,
  evaluateDbLiveness,
  evaluateJobsTableLiveness,
  prePullAllowsPoolImageRollout,
  readWorkerConfig,
} from "../src/index";

test("moved service entrypoints retain once mode and lane filtering without starting workers", () => {
  expect(
    readWorkerConfig({ PROVISIONING_JOB_LANES: "agent" }, ["--once"]).runOnce,
  ).toBe(true);
  expect(readAppsWorkerConfig({}, ["--once"]).runOnce).toBe(true);
  const config = readWorkerConfig({ PROVISIONING_JOB_LANES: "agent" }, []);
  expect(config.jobTypes.some((type) => type.startsWith("container_"))).toBe(
    false,
  );
  expect(config.jobTypes.some((type) => type.startsWith("agent_"))).toBe(true);
});

test("unknown or split database authority cannot authorize orphan deletion", () => {
  const now = new Date("2026-01-02T00:00:00Z");
  const jobs = evaluateJobsTableLiveness({
    latestJobCreatedAt: null,
    maxAgeHours: 12,
    now,
  });
  for (const heartbeatAt of [null, new Date("2026-01-01T00:00:00Z")]) {
    expect(
      allowsOrphanReconciliation(
        evaluateDbLiveness({
          jobs,
          heartbeatAt,
          heartbeatMaxAgeMinutes: 10,
          now,
        }),
      ),
    ).toBe(false);
  }
  expect(
    allowsOrphanReconciliation(
      evaluateDbLiveness({
        jobs,
        heartbeatAt: now,
        heartbeatMaxAgeMinutes: 10,
        now,
      }),
    ),
  ).toBe(true);
  expect(prePullAllowsPoolImageRollout(null)).toBe(false);
});
