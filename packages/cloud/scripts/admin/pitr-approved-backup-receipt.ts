/** Finite approval for stage-only from an authenticated protected backup run. */
const SHA = /^[a-f0-9]{64}$/;
export interface BackupRunAttestation {
  runId: number;
  repository: "elizaOS/eliza";
  event: "workflow_dispatch";
  branch: "main";
  workflowPath: ".github/workflows/production-pitr-safety-backup.yml";
  conclusion: "success";
  backupStepConclusion: "success";
  /** Authenticated run head equals the explicitly reviewed complete backup source commit. */
  reviewedSourceMatches: boolean;
}
export interface CompletedBackupReceipt {
  purpose: "production_named_safety_backup";
  state: "completed_retained";
  workflowComplete: true;
  operationReceipt: string;
  workflowReceipt: string;
  backupReceipt: string;
  volumeReceipt: string;
  observedAt: string;
  backupCreatedAt: string;
  backupExpiresAt: string | null;
  noScheduledExpiry: boolean;
  stagePerformed: false;
  restoreProven: false;
  productionMigrationReady: false;
}
/** Caller must authenticate attestation through GitHub Actions API, never dispatch inputs alone. */
export function approveBackupForStage(input: {
  attestation: BackupRunAttestation;
  receipt: CompletedBackupReceipt;
  expectedVolumeReceipt: string;
  now: number;
  maxAgeHours: number;
}) {
  const { attestation: a, receipt: r } = input;
  const created = Date.parse(r.backupCreatedAt),
    observed = Date.parse(r.observedAt),
    expiry = r.backupExpiresAt === null ? null : Date.parse(r.backupExpiresAt);
  if (
    !Number.isSafeInteger(a.runId) ||
    a.runId <= 0 ||
    a.repository !== "elizaOS/eliza" ||
    a.event !== "workflow_dispatch" ||
    a.branch !== "main" ||
    a.workflowPath !== ".github/workflows/production-pitr-safety-backup.yml" ||
    a.conclusion !== "success" ||
    a.backupStepConclusion !== "success" ||
    a.reviewedSourceMatches !== true
  )
    throw Error("backup_run_not_approved");
  if (
    r.purpose !== "production_named_safety_backup" ||
    r.state !== "completed_retained" ||
    r.workflowComplete !== true ||
    r.stagePerformed !== false ||
    r.restoreProven !== false ||
    r.productionMigrationReady !== false ||
    ![
      r.operationReceipt,
      r.workflowReceipt,
      r.backupReceipt,
      r.volumeReceipt,
      input.expectedVolumeReceipt,
    ].every((v) => typeof v === "string" && SHA.test(v)) ||
    r.volumeReceipt !== input.expectedVolumeReceipt
  )
    throw Error("backup_proof_not_approved");
  if (
    !Number.isFinite(input.now) ||
    !Number.isFinite(input.maxAgeHours) ||
    input.maxAgeHours <= 0 ||
    !Number.isFinite(created) ||
    !Number.isFinite(observed) ||
    created > observed ||
    observed > input.now ||
    input.now - created > input.maxAgeHours * 3600000 ||
    r.noScheduledExpiry !== (expiry === null) ||
    (expiry !== null && (!Number.isFinite(expiry) || expiry <= input.now))
  )
    throw Error("backup_proof_not_current");
  return {
    backupReceipt: r.backupReceipt,
    volumeReceipt: r.volumeReceipt,
    createdAtMs: created,
    expiresAtMs: expiry,
    validUntilMs: Math.min(
      created + input.maxAgeHours * 3600000,
      expiry ?? Infinity,
    ),
    verifiedRunId: a.runId,
  };
}
