/** Protected named safety backup only. No stage, commit, restore or DB write. */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BackupBinding,
  type BackupItem,
  createPitrSafetyBackup,
} from "./pitr-backup-proof";
import { privatePitrApi } from "./pitr-private-api";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("private_shape_invalid");
  return value as Record<string, unknown>;
}
export async function runSafetyBackup(input: {
  directory: string;
  projectId: string;
  environmentId: string;
  serviceId: string;
  volumeReceipt: string;
  expiry: number;
  /** Nonempty selects read-only reconciliation; never falls back to creation. */
  reconcileOperationReceipt?: string;
  signal: AbortSignal;
  api: typeof privatePitrApi;
  sourceFresh: () => Promise<boolean>;
  publishIntent?: (receipt: {
    purpose: string;
    operationReceipt: string;
    volumeReceipt: string;
  }) => void;
}) {
  const bindingBase = {
    projectId: input.projectId,
    environmentId: input.environmentId,
    serviceId: input.serviceId,
  };
  if (
    !Object.values(bindingBase).every((id) => UUID.test(id)) ||
    !/^[a-f0-9]{64}$/.test(input.volumeReceipt) ||
    !Number.isFinite(input.expiry) ||
    input.expiry <= Date.now() ||
    input.expiry > Date.now() + 3600000
  )
    throw Error("protected_configuration_invalid");
  const reportPath = join(input.directory, "report.json");
  const report = object(JSON.parse(readFileSync(reportPath, "utf8")));
  const checks = object(report.checks),
    major = object(report.postgresMajor);
  const authorityFresh = () => {
    const age = Date.now() - Math.floor(statSync(reportPath).mtimeMs);
    if (
      age < 0 ||
      age > 60000 ||
      checks.railwayTarget !== "match" ||
      checks.protectedDatabaseAuthority !== "match" ||
      major.canonical !== "18" ||
      major.protected !== "18"
    )
      throw Error("authority_not_fresh");
  };
  authorityFresh();
  const bind = async (): Promise<BackupBinding> => {
    if (input.signal.aborted || !(await input.sourceFresh()))
      throw Error("source_or_operation_unavailable");
    const response = object(
      await input.api("volumes", { id: input.environmentId }, input.signal),
    );
    const env = object(object(response.data).environment);
    if (env.id !== input.environmentId) throw Error("environment_mismatch");
    const edges = object(env.volumeInstances).edges;
    if (!Array.isArray(edges)) throw Error("volumes_invalid");
    const nodes = edges
      .map((v) => object(object(v).node))
      .filter(
        (v) =>
          v.environmentId === input.environmentId &&
          v.serviceId === input.serviceId &&
          v.mountPath === "/var/lib/postgresql/data" &&
          v.state === "READY" &&
          v.deletedAt === null &&
          v.isPendingDeletion === false,
      );
    if (
      nodes.length !== 1 ||
      typeof nodes[0].id !== "string" ||
      !UUID.test(nodes[0].id) ||
      typeof nodes[0].volumeId !== "string" ||
      !UUID.test(nodes[0].volumeId) ||
      sha(nodes[0].id) !== input.volumeReceipt
    )
      throw Error("volume_binding_mismatch");
    return { ...bindingBase, volumeId: nodes[0].id };
  };
  const binding = await bind();
  if (input.reconcileOperationReceipt !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(input.reconcileOperationReceipt))
      throw Error("reconcile_operation_invalid");
    const response = object(
      await input.api("backupList", { id: binding.volumeId }, input.signal),
    );
    const entries = object(response.data).volumeInstanceBackupList;
    if (!Array.isArray(entries)) throw Error("backup_list_invalid");
    const matching = entries
      .map(object)
      .filter(
        (entry) =>
          typeof entry.name === "string" &&
          sha(entry.name) === input.reconcileOperationReceipt,
      );
    const observedAt = Date.now();
    const entry = matching.length === 1 ? matching[0] : undefined;
    if (entry && (typeof entry.id !== "string" || entry.id.length === 0))
      throw Error("reconcile_backup_identity_invalid");
    const created =
      entry && typeof entry.createdAt === "string"
        ? Date.parse(entry.createdAt)
        : NaN;
    const expiry =
      entry?.expiresAt === null
        ? null
        : entry && typeof entry.expiresAt === "string"
          ? Date.parse(entry.expiresAt)
          : NaN;
    if (!(await input.sourceFresh()))
      throw Error("source_or_operation_unavailable");
    return {
      purpose: "production_named_safety_backup_reconciliation",
      state: "observed_read_only",
      operationReceipt: input.reconcileOperationReceipt,
      volumeReceipt: input.volumeReceipt,
      matchingBackup:
        matching.length === 0
          ? "absent"
          : matching.length === 1
            ? "unique"
            : "ambiguous",
      backupReceipt:
        entry && typeof entry.id === "string" ? sha(entry.id) : null,
      retained: entry
        ? Number.isFinite(created) &&
          created <= observedAt &&
          (expiry === null || (Number.isFinite(expiry) && expiry > Date.now()))
        : false,
      observedAt: new Date(observedAt).toISOString(),
      requestSubmitted: false,
      workflowComplete: false,
      completionEvidence: "unavailable_from_backup_list",
      automaticRetryAllowed: false,
      stagePerformed: false,
      restoreProven: false,
      productionMigrationReady: false,
    };
  }
  let phase = "pre_create_admission";
  let requestSubmitted = false;
  let failureCategory: string | null = null;
  const operationName = `alpha-pitr-safety-${randomUUID().replaceAll("-", "")}`;
  const persist = (name: string, value: unknown) =>
    writeFileSync(join(input.directory, name), JSON.stringify(value), {
      mode: 0o600,
      flag: "wx",
    });
  let proof: BackupItem | undefined;
  let workflowReceipt: string | undefined;
  let workflowComplete = false;
  const result = await createPitrSafetyBackup({
    binding,
    operationName,
    expiresAtMs: input.expiry,
    transport: {
      binding: bind,
      async list(id) {
        const response = object(
          await input.api("backupList", { id }, input.signal),
        );
        const items = object(response.data).volumeInstanceBackupList;
        if (!Array.isArray(items)) throw Error("backup_list_invalid");
        return items.map((raw) => {
          const item = object(raw);
          if (
            typeof item.id !== "string" ||
            (item.name !== null && typeof item.name !== "string") ||
            typeof item.createdAt !== "string" ||
            (item.expiresAt !== null && typeof item.expiresAt !== "string")
          )
            throw Error("backup_shape_invalid");
          return {
            id: item.id,
            name: item.name ?? "",
            volumeId: id,
            createdAtMs: Date.parse(item.createdAt),
            expiresAtMs:
              item.expiresAt === null ? null : Date.parse(item.expiresAt),
          };
        });
      },
      async persistIntent(name, identity, priorIds) {
        persist("safety-backup-intent.json", { name, identity, priorIds });
        input.publishIntent?.({
          purpose: "named_backup_intent",
          operationReceipt: sha(name),
          volumeReceipt: input.volumeReceipt,
        });
      },
      async create(id, name) {
        phase = "create_preflight";
        try {
          if (!(await input.sourceFresh()))
            throw Error("source_or_operation_unavailable");
          authorityFresh();
          if (Date.now() >= input.expiry)
            throw Error("review_expired_before_creation");
          phase = "create_request";
          requestSubmitted = true;
          const response = object(
            await input.api("backupCreate", { id, name }, input.signal),
          );
          const operation = object(
            object(response.data).volumeInstanceBackupCreate,
          );
          if (typeof operation.workflowId !== "string")
            throw Error("workflow_missing");
          persist("safety-backup-workflow.json", operation);
          workflowReceipt = sha(operation.workflowId);
          return { workflowId: operation.workflowId };
        } catch (error) {
          const categories = new Set([
            "authority_not_fresh",
            "source_or_operation_unavailable",
            "review_expired_before_creation",
            "workflow_missing",
            "private_provider_cleanup_unconfirmed",
            "private_provider_request_unconfirmed",
            "private_provider_input_refused",
            "private_provider_configuration_missing",
          ]);
          failureCategory =
            error instanceof Error && categories.has(error.message)
              ? error.message
              : "unclassified_private_failure";
          throw Error("backup_create_unconfirmed");
        }
      },
      async status(id) {
        phase = "workflow_wait";
        const deadline = Date.now() + 600000;
        while (Date.now() < deadline && !input.signal.aborted) {
          const response = object(
            await input.api("workflowStatus", { id }, input.signal),
          );
          const status = object(object(response.data).workflowStatus).status;
          if (status === "Complete") {
            workflowComplete = true;
            return status;
          }
          if (status === "Error") return status;
          if (status !== "Running" && status !== "NotFound")
            return "unconfirmed";
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        return "unconfirmed";
      },
      async persistProof(id, backup, identity) {
        phase = "proof_publication";
        if (!(await input.sourceFresh()))
          throw Error("source_changed_after_creation");
        if (backup.expiresAtMs !== null && backup.expiresAtMs <= Date.now())
          throw Error("backup_expired_before_publication");
        persist("safety-backup-proof.json", {
          workflowId: id,
          backup,
          identity,
        });
        proof = backup;
      },
    },
  });
  return {
    ...result,
    phase,
    requestSubmitted,
    failureCategory: failureCategory as string | null,
    purpose: "production_named_safety_backup",
    operationReceipt: sha(operationName),
    workflowReceipt: workflowReceipt ?? null,
    backupReceipt: proof ? sha(proof.id) : null,
    volumeReceipt: input.volumeReceipt,
    observedAt: new Date().toISOString(),
    workflowComplete,
    backupCreatedAt: proof ? new Date(proof.createdAtMs).toISOString() : null,
    backupExpiresAt:
      proof?.expiresAtMs != null
        ? new Date(proof.expiresAtMs).toISOString()
        : null,
    noScheduledExpiry: proof ? proof.expiresAtMs === null : null,
    stagePerformed: false,
    restoreProven: false,
  };
}

if (import.meta.main) {
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const { execFile } = await import("node:child_process");
    const sourceFresh = () =>
      new Promise<boolean>((resolve) => {
        execFile(
          "node",
          [
            "packages/cloud/scripts/canonical-deploy-source-guard.ts",
            "--run-sha",
            process.env.GITHUB_SHA ?? "",
            "--canonical-ref",
            "refs/heads/main",
          ],
          { timeout: 120000, maxBuffer: 1024 * 1024, signal: abort.signal },
          (error) => resolve(!error),
        );
      });
    if (
      process.env.GITHUB_REF !== "refs/heads/main" ||
      process.env.GITHUB_ACTIONS !== "true"
    )
      throw Error("protected_runner_required");
    const result = await runSafetyBackup({
      directory: process.env.BACKUP_EVIDENCE_DIR ?? "",
      projectId: process.env.RAILWAY_PROJECT_ID ?? "",
      environmentId: process.env.RAILWAY_ENVIRONMENT_ID ?? "",
      serviceId: readFileSync(
        join(process.env.BACKUP_EVIDENCE_DIR ?? "", "resolved-service-id"),
        "utf8",
      ).trim(),
      volumeReceipt: process.env.PITR_APPROVED_VOLUME_RECEIPT ?? "",
      expiry: Date.parse(process.env.PITR_REVIEW_EXPIRES_UTC ?? ""),
      reconcileOperationReceipt:
        process.env.PITR_RECONCILE_OPERATION_RECEIPT || undefined,
      signal: abort.signal,
      api: privatePitrApi,
      publishIntent: (receipt) => console.log(JSON.stringify(receipt)),
      sourceFresh,
    });
    console.log(JSON.stringify(result, null, 2));
    if (
      result.state !== "completed_retained" &&
      result.state !== "observed_read_only"
    )
      process.exitCode = 1;
  } catch {
    // error-policy:J1 credentials and provider metadata never enter public errors.
    console.log(
      JSON.stringify({
        purpose: "production_named_safety_backup",
        state: "unconfirmed",
        automaticRetryAllowed: false,
        productionMigrationReady: false,
      }),
    );
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}
