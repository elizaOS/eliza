/** Read-only authenticated GitHub evidence loader; raw job logs never leave this function. */
import {
  approveBackupForStage,
  type CompletedBackupReceipt,
} from "./pitr-approved-backup-receipt";

const PREFIX = "repos/elizaOS/eliza";
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("backup_run_evidence_invalid");
  return value as Record<string, unknown>;
}
type ProtectedBackupInput = {
  runId: number;
  reviewedSourceHead: string;
  expectedVolumeReceipt: string;
  now: number;
  maxAgeHours: number;
  json: (path: string) => Promise<unknown>;
  text: (path: string) => Promise<string>;
};
export async function loadProtectedBackup(input: ProtectedBackupInput) {
  try {
    return await loadEvidence(input);
  } catch (error) {
    const allowed = new Set([
      "backup_run_evidence_invalid",
      "backup_run_reference_invalid",
      "backup_run_not_approved",
      "backup_job_evidence_incomplete",
      "backup_job_not_approved",
      "backup_step_not_approved",
      "backup_log_bound_exceeded",
      "backup_receipt_not_unique",
      "backup_proof_not_approved",
      "backup_proof_not_current",
    ]);
    throw Error(
      error instanceof Error && allowed.has(error.message)
        ? error.message
        : "backup_run_evidence_unavailable",
    );
  }
}
async function loadEvidence(input: ProtectedBackupInput) {
  if (
    !Number.isSafeInteger(input.runId) ||
    input.runId <= 0 ||
    !/^[a-f0-9]{40}$/.test(input.reviewedSourceHead)
  )
    throw Error("backup_run_reference_invalid");
  const run = object(await input.json(`${PREFIX}/actions/runs/${input.runId}`));
  if (
    run.id !== input.runId ||
    run.head_sha !== input.reviewedSourceHead ||
    run.head_branch !== "main" ||
    run.event !== "workflow_dispatch" ||
    run.conclusion !== "success" ||
    run.path !== ".github/workflows/production-pitr-safety-backup.yml" ||
    object(run.repository).full_name !== "elizaOS/eliza"
  )
    throw Error("backup_run_not_approved");
  const jobs = object(
    await input.json(`${PREFIX}/actions/runs/${input.runId}/jobs?per_page=100`),
  );
  if (!Array.isArray(jobs.jobs) || jobs.total_count !== jobs.jobs.length)
    throw Error("backup_job_evidence_incomplete");
  const matches = jobs.jobs
    .map(object)
    .filter(
      (j) =>
        j.name === "Create one protected named safety backup" &&
        j.conclusion === "success" &&
        j.run_id === input.runId,
    );
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id))
    throw Error("backup_job_not_approved");
  const steps = matches[0].steps;
  if (
    !Array.isArray(steps) ||
    !steps
      .map(object)
      .some(
        (s) =>
          s.name === "Create and prove one named safety backup" &&
          s.conclusion === "success",
      ) ||
    !steps
      .map(object)
      .some(
        (s) =>
          s.name === "Destroy private backup evidence" &&
          s.conclusion === "success",
      )
  )
    throw Error("backup_step_not_approved");
  const log = await input.text(`${PREFIX}/actions/jobs/${matches[0].id}/logs`);
  if (Buffer.byteLength(log) > 8 * 1024 * 1024)
    throw Error("backup_log_bound_exceeded");
  const lines = log
    .split("\n")
    .map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T\S+Z /, ""));
  const receipts: CompletedBackupReceipt[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("{")) continue;
    let candidate = "";
    for (let j = i; j < Math.min(lines.length, i + 40); j++) {
      candidate += `${lines[j]}\n`;
      try {
        const parsed = object(JSON.parse(candidate));
        if (parsed.purpose === "production_named_safety_backup")
          receipts.push(parsed as unknown as CompletedBackupReceipt);
        i = j;
        break;
      } catch {
        /* Partial/non-receipt log text is discarded without output. */
      }
    }
  }
  if (receipts.length !== 1) throw Error("backup_receipt_not_unique");
  return approveBackupForStage({
    attestation: {
      runId: input.runId,
      repository: "elizaOS/eliza",
      event: "workflow_dispatch",
      branch: "main",
      workflowPath: ".github/workflows/production-pitr-safety-backup.yml",
      conclusion: "success",
      backupStepConclusion: "success",
      reviewedSourceMatches: true,
    },
    receipt: receipts[0],
    expectedVolumeReceipt: input.expectedVolumeReceipt,
    now: input.now,
    maxAgeHours: input.maxAgeHours,
  });
}
