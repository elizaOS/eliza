/**
 * Pins the provisioning daemon's backup-RPO health phase to the shared service.
 * Fleet classification and persistence run against real PGlite in cloud-shared.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  __setBackupFleetHealthRunnerForTests,
  processBackupFleetHealthCycle,
} from "./provisioning-worker";

afterEach(() => {
  __setBackupFleetHealthRunnerForTests(null);
});

describe("processBackupFleetHealthCycle", () => {
  test("returns the shared fleet-health summary unchanged", async () => {
    const summary = {
      laneEnabled: true,
      healthy: false,
      total: 12,
      absent: 1,
      stale: 2,
      unsupported: 3,
      unreachable: 1,
      repeatedFailures: 1,
      imageRefreshRequired: 1,
      backlog: 7,
      backlogPressure: false,
      oldestBackupAgeMs: 48_000,
      newAlerts: 4,
    };
    const runBackupFleetHealthCycle = mock(async () => summary);
    __setBackupFleetHealthRunnerForTests(runBackupFleetHealthCycle);

    await expect(processBackupFleetHealthCycle()).resolves.toEqual(summary);
    expect(runBackupFleetHealthCycle).toHaveBeenCalledTimes(1);
  });

  test("propagates persistence failures to the bounded daemon phase", async () => {
    const runBackupFleetHealthCycle = mock(async () => {
      throw new Error("backup health database unavailable");
    });
    __setBackupFleetHealthRunnerForTests(runBackupFleetHealthCycle);

    await expect(processBackupFleetHealthCycle()).rejects.toThrow(
      "backup health database unavailable",
    );
  });
});
