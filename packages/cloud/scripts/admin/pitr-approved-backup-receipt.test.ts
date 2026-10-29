import { expect, test } from "bun:test";
import {
  approveBackupForStage,
  type BackupRunAttestation,
  type CompletedBackupReceipt,
} from "./pitr-approved-backup-receipt";

function fixture() {
  const attestation: BackupRunAttestation = {
    runId: 1,
    repository: "elizaOS/eliza",
    event: "workflow_dispatch",
    branch: "main",
    workflowPath: ".github/workflows/production-pitr-safety-backup.yml",
    conclusion: "success",
    backupStepConclusion: "success",
    reviewedSourceMatches: true,
  };
  const receipt: CompletedBackupReceipt = {
    purpose: "production_named_safety_backup",
    state: "completed_retained",
    workflowComplete: true,
    operationReceipt: "a".repeat(64),
    workflowReceipt: "b".repeat(64),
    backupReceipt: "c".repeat(64),
    volumeReceipt: "d".repeat(64),
    observedAt: new Date(2000).toISOString(),
    backupCreatedAt: new Date(1000).toISOString(),
    backupExpiresAt: null,
    noScheduledExpiry: true,
    stagePerformed: false,
    restoreProven: false,
    productionMigrationReady: false,
  };
  return {
    attestation,
    receipt,
    expectedVolumeReceipt: "d".repeat(64),
    now: 3000,
    maxAgeHours: 36,
  };
}
test("protected completed backup receipt is current and exact-volume bound", () => {
  const f = fixture();
  expect(approveBackupForStage(f).backupReceipt).toBe(f.receipt.backupReceipt);
});
test("wrong source, volume, workflow outcome and expired or future proof never qualify", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.attestation.reviewedSourceMatches = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.expectedVolumeReceipt = "e".repeat(64);
    },
    (f: ReturnType<typeof fixture>) => {
      f.receipt.workflowComplete = false as true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.receipt.backupExpiresAt = new Date(2500).toISOString();
      f.receipt.noScheduledExpiry = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.receipt.observedAt = new Date(4000).toISOString();
    },
  ]) {
    const f = fixture();
    mutate(f);
    expect(() => approveBackupForStage(f)).toThrow();
  }
});
