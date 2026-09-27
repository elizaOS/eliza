import { describe, expect, test } from "bun:test";
import { readAgentBackupRestoreCoordinatorConfig } from "./agent-backup-restore-coordinator-runtime";

describe("readAgentBackupRestoreCoordinatorConfig flags", () => {
  test("treats unset, empty, and 0 as off", () => {
    expect(readAgentBackupRestoreCoordinatorConfig({})).toEqual({ enabled: false });
    expect(
      readAgentBackupRestoreCoordinatorConfig({
        AGENT_BACKUP_RESTORE_COORDINATOR_ENABLED: "0",
        AGENT_BACKUP_RESTORE_FAILOVER_ENABLED: "",
      }),
    ).toEqual({ enabled: false });
  });

  test("refuses an ambiguous coordinator flag instead of reading it as off", () => {
    expect(() =>
      readAgentBackupRestoreCoordinatorConfig({ AGENT_BACKUP_RESTORE_COORDINATOR_ENABLED: "true" }),
    ).toThrow('AGENT_BACKUP_RESTORE_COORDINATOR_ENABLED must be "1" or "0"');
  });

  test("refuses an ambiguous failover flag instead of reading it as off", () => {
    expect(() =>
      readAgentBackupRestoreCoordinatorConfig({
        AGENT_BACKUP_RESTORE_COORDINATOR_ENABLED: "1",
        AGENT_BACKUP_RESTORE_WORKER_ID: "worker-1",
        AGENT_BACKUP_RESTORE_FAILOVER_ENABLED: "yes",
      }),
    ).toThrow('AGENT_BACKUP_RESTORE_FAILOVER_ENABLED must be "1" or "0"');
  });
});
