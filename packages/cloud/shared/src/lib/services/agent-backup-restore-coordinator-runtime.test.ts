/** The gate must stay closed by default and refuse a half-configured deployment. */
import { describe, expect, test } from "bun:test";
import { readAgentBackupRestoreCoordinatorConfig } from "./agent-backup-restore-coordinator-runtime";

describe("readAgentBackupRestoreCoordinatorConfig", () => {
  test("is disabled on an empty environment and reads no tunable", () => {
    expect(readAgentBackupRestoreCoordinatorConfig({})).toEqual({ enabled: false });
    expect(
      readAgentBackupRestoreCoordinatorConfig({
        AGENT_BACKUP_RESTORE_WORKER_ID: "worker-a",
        AGENT_BACKUP_RESTORE_CLAIM_MS: "not-a-number",
      }),
    ).toEqual({ enabled: false });
  });

  test("refuses the dependent failover flag without its parent", () => {
    expect(() =>
      readAgentBackupRestoreCoordinatorConfig({ AGENT_BACKUP_RESTORE_FAILOVER_ENABLED: "1" }),
    ).toThrow("requires AGENT_BACKUP_RESTORE_COORDINATOR_ENABLED=1");
  });

  test("refuses failover even with its parent, because it is not implemented", () => {
    expect(() =>
      readAgentBackupRestoreCoordinatorConfig({
        AGENT_BACKUP_RESTORE_COORDINATOR_ENABLED: "1",
        AGENT_BACKUP_RESTORE_WORKER_ID: "worker-a",
        AGENT_BACKUP_RESTORE_FAILOVER_ENABLED: "1",
      }),
    ).toThrow("explicit restore only");
  });

  // Both refusals above are written with "1". Every value that is NOT "1" used
  // to read as unset, so both of them vanished for a flag that plainly means
  // ON — the operator asked for failover and got a silently-off coordinator.
  test('refuses a flag value that means on but is not "1"', () => {
    for (const value of ["true", "TRUE", "yes", "on", "2", " 1"]) {
      expect(() =>
        readAgentBackupRestoreCoordinatorConfig({
          AGENT_BACKUP_RESTORE_FAILOVER_ENABLED: value,
        }),
      ).toThrow('AGENT_BACKUP_RESTORE_FAILOVER_ENABLED must be "1" or "0"');
      expect(() =>
        readAgentBackupRestoreCoordinatorConfig({
          AGENT_BACKUP_RESTORE_COORDINATOR_ENABLED: value,
          AGENT_BACKUP_RESTORE_WORKER_ID: "worker-a",
        }),
      ).toThrow('AGENT_BACKUP_RESTORE_COORDINATOR_ENABLED must be "1" or "0"');
    }
  });

  // The refusal must not swallow an unambiguous "off": rejecting "0" would
  // turn a deployment that means disabled into a boot failure.
  test('accepts "0" and empty as off without reading a tunable', () => {
    for (const value of ["0", ""]) {
      expect(
        readAgentBackupRestoreCoordinatorConfig({
          AGENT_BACKUP_RESTORE_COORDINATOR_ENABLED: value,
          AGENT_BACKUP_RESTORE_FAILOVER_ENABLED: value,
          AGENT_BACKUP_RESTORE_CLAIM_MS: "not-a-number",
        }),
      ).toEqual({ enabled: false });
    }
  });

  test("requires an exact worker id once enabled", () => {
    for (const workerId of [undefined, "", " worker-a", "worker-a "]) {
      expect(() =>
        readAgentBackupRestoreCoordinatorConfig({
          AGENT_BACKUP_RESTORE_COORDINATOR_ENABLED: "1",
          ...(workerId === undefined ? {} : { AGENT_BACKUP_RESTORE_WORKER_ID: workerId }),
        }),
      ).toThrow("AGENT_BACKUP_RESTORE_WORKER_ID must be explicitly configured");
    }
  });

  test("applies defaults and bounds the claim window to the DB-enforced range", () => {
    expect(
      readAgentBackupRestoreCoordinatorConfig({
        AGENT_BACKUP_RESTORE_COORDINATOR_ENABLED: "1",
        AGENT_BACKUP_RESTORE_WORKER_ID: "worker-a",
      }),
    ).toEqual({
      enabled: true,
      workerId: "worker-a",
      claimMs: 60_000,
      retryBaseMs: 5_000,
      automaticFailoverEnabled: false,
    });

    for (const claimMs of ["999", "3600001", "0", "-1", "60_000"]) {
      expect(() =>
        readAgentBackupRestoreCoordinatorConfig({
          AGENT_BACKUP_RESTORE_COORDINATOR_ENABLED: "1",
          AGENT_BACKUP_RESTORE_WORKER_ID: "worker-a",
          AGENT_BACKUP_RESTORE_CLAIM_MS: claimMs,
        }),
      ).toThrow(/AGENT_BACKUP_RESTORE_CLAIM_MS/);
    }
  });
});
