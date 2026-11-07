import { expect, test } from "bun:test";
import { loadProtectedBackup } from "./pitr-backup-run-attestation";

function fixture() {
  const receipt = {
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
  const run = {
    id: 1,
    head_sha: "e".repeat(40),
    head_branch: "main",
    event: "workflow_dispatch",
    conclusion: "success",
    path: ".github/workflows/production-pitr-safety-backup.yml",
    repository: { full_name: "elizaOS/eliza" },
  };
  const job = {
    id: 2,
    run_id: 1,
    name: "Create one protected named safety backup",
    conclusion: "success",
    steps: [
      {
        name: "Create and prove one named safety backup",
        conclusion: "success",
      },
      { name: "Destroy private backup evidence", conclusion: "success" },
    ],
  };
  const data = {
    run,
    jobs: { total_count: 1, jobs: [job] },
    log: JSON.stringify(receipt, null, 2)
      .split("\n")
      .map((l) => `2026-10-20T03:00:00.000Z ${l}`)
      .join("\n"),
  };
  const input = {
    runId: 1,
    reviewedSourceHead: run.head_sha,
    expectedVolumeReceipt: receipt.volumeReceipt,
    now: 3000,
    maxAgeHours: 36,
    json: async (path: string) =>
      path.includes("/jobs?") ? data.jobs : data.run,
    text: async () => data.log,
  };
  return { data, input };
}
test("authenticates exact reviewed successful run and reads only unique completed receipt", async () => {
  const { data, input } = fixture();
  data.log = `2026-10-20T03:00:00.000Z {"unrelated":"private sentinel"}\n${data.log}`;
  expect(await loadProtectedBackup(input)).toEqual({
    backupReceipt: "c".repeat(64),
    volumeReceipt: "d".repeat(64),
    createdAtMs: 1000,
    expiresAtMs: null,
    validUntilMs: 129601000,
    verifiedRunId: 1,
  });
});
test("wrong run/source/workflow, incomplete jobs and cleanup failure refuse", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.data.run.id = 3;
    },
    (f: ReturnType<typeof fixture>) => {
      f.data.run.head_sha = "f".repeat(40);
    },
    (f: ReturnType<typeof fixture>) => {
      f.data.run.path = "another.yml";
    },
    (f: ReturnType<typeof fixture>) => {
      f.data.run.conclusion = "failure";
    },
    (f: ReturnType<typeof fixture>) => {
      f.data.jobs.total_count = 2;
    },
    (f: ReturnType<typeof fixture>) => {
      f.data.jobs.jobs[0].steps[1].conclusion = "failure";
    },
  ]) {
    const f = fixture();
    change(f);
    await expect(loadProtectedBackup(f.input)).rejects.toThrow();
  }
});
test("duplicate receipts, unrelated-only logs and oversized evidence refuse without exposing text", async () => {
  for (const kind of ["duplicate", "unrelated", "oversized"]) {
    const f = fixture();
    f.data.log =
      kind === "duplicate"
        ? `${f.data.log}\n${f.data.log}`
        : kind === "unrelated"
          ? '{"secret":"private sentinel"}'
          : "private sentinel".repeat(600000);
    let error = "";
    try {
      await loadProtectedBackup(f.input);
    } catch (e) {
      error = (e as Error).message;
    }
    expect(error).toMatch(/^backup_(receipt_not_unique|log_bound_exceeded)$/);
    expect(error).not.toContain("private sentinel");
  }
});
test("transport errors cannot expose private provider or GitHub evidence", async () => {
  const f = fixture();
  f.input.json = async () => {
    throw Error("private sentinel");
  };
  await expect(loadProtectedBackup(f.input)).rejects.toThrow(
    "backup_run_evidence_unavailable",
  );
});
