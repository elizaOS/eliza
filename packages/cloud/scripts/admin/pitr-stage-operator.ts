/** Protected stage-only composition. No workflow dispatch or commit is provided here. */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadProtectedBackup } from "./pitr-backup-run-attestation";
import { protectedGithubEvidence } from "./pitr-github-evidence";
import { privatePitrApi } from "./pitr-private-api";
import { refreshStageAuthority } from "./pitr-stage-authority";
import { runStageOnly } from "./pitr-stage-runner";

const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export async function protectedStageOperator(signal: AbortSignal) {
  let handedToRunner = false;
  try {
    const env = process.env;
    const expiry = Date.parse(env.PITR_REVIEW_EXPIRES_UTC ?? "");
    const runId = Number(env.PITR_COMPLETED_BACKUP_RUN_ID);
    const source = env.GITHUB_SHA ?? "",
      backupSource = env.PITR_COMPLETED_BACKUP_SOURCE_HEAD ?? "";
    const projectId = env.RAILWAY_PROJECT_ID ?? "",
      environmentId = env.RAILWAY_ENVIRONMENT_ID ?? "",
      serviceId = env.RAILWAY_POSTGRES_SERVICE_ID ?? "";
    const volumeReceipt = env.PITR_APPROVED_VOLUME_RECEIPT ?? "",
      imageReceipt = env.PITR_APPROVED_IMAGE_RECEIPT ?? "",
      maintenanceReceipt = env.PITR_WRITER_MAINTENANCE_RECEIPT ?? "";
    if (
      env.GITHUB_ACTIONS !== "true" ||
      env.GITHUB_REF !== "refs/heads/main" ||
      env.GITHUB_REPOSITORY !== "elizaOS/eliza" ||
      !COMMIT.test(source) ||
      !COMMIT.test(backupSource) ||
      ![projectId, environmentId, serviceId].every((v) => UUID.test(v)) ||
      ![volumeReceipt, imageReceipt, maintenanceReceipt].every((v) =>
        SHA.test(v),
      ) ||
      !Number.isSafeInteger(runId) ||
      runId <= 0 ||
      !Number.isFinite(expiry) ||
      expiry <= Date.now() ||
      expiry > Date.now() + 3600000 ||
      !env.GITHUB_TOKEN ||
      !env.RUNNER_TEMP ||
      !/^\d+$/.test(env.GITHUB_RUN_ID ?? "") ||
      !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
      !env.PITR_STAGE_RECIPIENT_PUBLIC_KEY
    )
      throw Error();
    const github = protectedGithubEvidence({ token: env.GITHUB_TOKEN, signal });
    const sourceFresh = async () => {
      try {
        const result = (await github.json(
          "repos/elizaOS/eliza/git/ref/heads/main",
        )) as { object?: { sha?: unknown } };
        return result.object?.sha === source;
      } catch {
        return false;
      }
    };
    if (!(await sourceFresh())) throw Error();
    // Existing production backup freshness policy: 36 hours. No metadata-only fallback.
    const approvedBackup = await loadProtectedBackup({
      runId,
      reviewedSourceHead: backupSource,
      expectedVolumeReceipt: volumeReceipt,
      now: Date.now(),
      maxAgeHours: 36,
      json: github.json,
      text: github.text,
    });
    const directory = join(
      env.RUNNER_TEMP,
      `production-pitr-stage-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    );
    mkdirSync(directory, { mode: 0o700 });
    handedToRunner = true;
    return await runStageOnly({
      directory,
      recipientPublicKey: env.PITR_STAGE_RECIPIENT_PUBLIC_KEY,
      projectId,
      environmentId,
      serviceId,
      sourceHead: source,
      volumeReceipt,
      imageReceipt,
      maintenanceReceipt,
      expiry,
      approvedBackup,
      signal,
      api: privatePitrApi,
      sourceFresh,
      refreshAuthority: () =>
        refreshStageAuthority({ projectId, environmentId, serviceId, signal }),
      publish: (receipt) => {
        process.stdout.write(`${JSON.stringify(receipt)}\n`);
      },
    });
  } catch {
    return {
      purpose: "production_pitr_stage_only",
      state: handedToRunner ? "creation_unconfirmed" : "refused_before_stage",
      resourceCreationPossible: handedToRunner,
      automaticRetryAllowed: false,
      committed: false,
      productionMigrationReady: false,
    };
  }
}
if (import.meta.main) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  try {
    const result = await protectedStageOperator(controller.signal);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.state !== "staged_requires_review") process.exitCode = 1;
  } finally {
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
  }
}
