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
