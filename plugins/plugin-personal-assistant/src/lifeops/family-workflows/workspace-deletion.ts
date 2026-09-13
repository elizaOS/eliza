/**
 * Commits a reviewed family deletion and its remaining private-file work atomically.
 * Derived database content disappears at revocation; a durable identity-only journal
 * survives interruption before file and backup cleanup. Shared records are retained.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  ElizaError,
  type IAgentRuntime,
  type IFileStorageService,
  ServiceType,
} from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { z } from "zod";
import {
  executeRawSql,
  executeRawSqlTx,
  sqlQuote,
  withTransaction,
} from "../sql.js";
import {
  purgeReviewedFamilyDatabaseRows,
  withReviewedFamilyDeletionDatabase,
} from "./deletion-database-snapshot.js";
import { fenceFamilyWorkspace } from "./workspace-operation-store.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const retention = z.enum(["immediate", "7-days", "30-days"]);
const deletionJob = z.strictObject({
  id: z.string().uuid(),
  agentId: z.string().min(1),
  reviewedSha256: sha256,
  startedAt: z.string().datetime(),
  state: z.enum(["purge_pending", "backup_pending"]),
  backupRetention: retention,
  files: z.array(z.strictObject({ fileName: z.string().min(1), sha256 })),
  databaseRowsRemoved: z.number().int().nonnegative(),
  retained: z.array(
    z.strictObject({ kind: z.string(), count: z.number().int().positive() }),
  ),
});
export type FamilyDeletionJob = z.infer<typeof deletionJob>;
const table = "app_lifeops.life_family_workspace_deletions";

function requireOwner(ownerEntityId: string) {
  if (ownerEntityId !== SELF_ENTITY_ID)
    throw new ElizaError(
      "[FamilyDeletion] Only the owner may delete the workspace",
      { code: "FAMILY_DELETION_ACCESS_DENIED" },
    );
}

async function ensureStore(runtime: IAgentRuntime) {
  await executeRawSql(
    runtime,
    `CREATE TABLE IF NOT EXISTS ${table} (
    agent_id TEXT PRIMARY KEY, job_json JSONB NOT NULL
  )`,
  );
}

export async function readFamilyDeletionJob(
  runtime: IAgentRuntime,
  ownerEntityId: string,
): Promise<FamilyDeletionJob | null> {
  requireOwner(ownerEntityId);
  await ensureStore(runtime);
  const rows = await executeRawSql(
    runtime,
    `SELECT job_json FROM ${table} WHERE agent_id=${sqlQuote(runtime.agentId)}`,
  );
  if (rows.length === 0) return null;
  return deletionJob.parse(rows[0].job_json);
}

/** Confirmation is bound to the complete reviewed snapshot and an explicit backup policy. */
export async function beginFamilyWorkspaceDeletion(
  runtime: IAgentRuntime,
  input: {
    ownerEntityId: string;
    expectedSha256: string;
    backupRetention: z.infer<typeof retention>;
  },
): Promise<FamilyDeletionJob> {
  requireOwner(input.ownerEntityId);
  const backupRetention = retention.parse(input.backupRetention);
  await ensureStore(runtime);
  try {
    return await withReviewedFamilyDeletionDatabase(
      runtime,
      input,
      async (tx, snapshot) => {
        const files = snapshot.records
          .filter((record) => record.kind === "agreements")
          .map((record) => ({
            fileName: z.string().min(1).parse(record.identity.media_file_name),
            sha256: sha256.parse(record.identity.content_sha256),
          }));
        if (files.length) {
          const documentIds = snapshot.records
            .filter((record) => record.kind === "agreements")
            .map((record) => z.string().parse(record.identity.document_id));
          const shared = await executeRawSqlTx(
            tx,
            `SELECT 1 FROM app_lifeops.life_household_agreement_artifacts WHERE agent_id<>${sqlQuote(runtime.agentId)} AND (media_file_name IN (${files.map((file) => sqlQuote(file.fileName)).join(",")}) OR document_id IN (${documentIds.map(sqlQuote).join(",")})) LIMIT 1`,
          );
          if (shared.length)
            throw new ElizaError(
              "[FamilyDeletion] A source is still referenced by another workspace",
              { code: "FAMILY_DELETION_SHARED_SOURCE" },
            );
        }
        const retained = new Map<string, number>();
        for (const record of snapshot.records) {
          if (record.classification !== "owned")
            retained.set(record.kind, (retained.get(record.kind) ?? 0) + 1);
        }
        await fenceFamilyWorkspace(tx, runtime.agentId);
        const databaseRowsRemoved = await purgeReviewedFamilyDatabaseRows(
          tx,
          snapshot,
        );
        const job: FamilyDeletionJob = {
          id: randomUUID(),
          agentId: runtime.agentId,
          reviewedSha256: snapshot.sha256,
          startedAt: new Date().toISOString(),
          state: "purge_pending",
          backupRetention,
          files,
          databaseRowsRemoved,
          retained: [...retained].map(([kind, count]) => ({ kind, count })),
        };
        await executeRawSqlTx(
          tx,
          `INSERT INTO ${table} (agent_id,job_json) VALUES (${sqlQuote(runtime.agentId)},${sqlQuote(JSON.stringify(job))}::jsonb)`,
        );
        return job;
      },
    );
  } catch (cause) {
    // error-policy:J2 Keep SQL payloads out of the public deletion failure while preserving the cause.
    if (cause instanceof ElizaError) throw cause;
    throw new ElizaError(
      "[FamilyDeletion] The deletion transaction did not complete",
      { code: "FAMILY_DELETION_TRANSACTION_FAILED", cause },
    );
  }
}

/** Verify private-byte removal before advancing; a lost acknowledgement remains safely retryable. */
export async function purgeFamilyWorkspaceFiles(
  runtime: IAgentRuntime,
  ownerEntityId: string,
): Promise<FamilyDeletionJob> {
  requireOwner(ownerEntityId);
  const storage = runtime.getService<IFileStorageService>(
    ServiceType.REMOTE_FILES,
  );
  if (!storage)
    throw new ElizaError(
      "[FamilyDeletion] Private file storage is unavailable",
      { code: "FAMILY_DELETION_STORAGE_UNAVAILABLE" },
    );
  await ensureStore(runtime);
  try {
    return await withTransaction(runtime, async (tx) => {
      // The same ordering as admission keeps source references stable through file removal.
      await executeRawSqlTx(
        tx,
        "LOCK TABLE app_lifeops.life_household_agreement_artifacts IN SHARE ROW EXCLUSIVE MODE",
      );
      const rows = await executeRawSqlTx(
        tx,
        `SELECT job_json FROM ${table} WHERE agent_id=${sqlQuote(runtime.agentId)} FOR UPDATE`,
      );
      if (rows.length !== 1)
        throw new ElizaError("[FamilyDeletion] No deletion is pending", {
          code: "FAMILY_DELETION_NOT_FOUND",
        });
      const job = deletionJob.parse(rows[0].job_json);
      if (job.state === "backup_pending") return job;
      for (const file of job.files) {
        const references = await executeRawSqlTx(
          tx,
          `SELECT 1 FROM app_lifeops.life_household_agreement_artifacts WHERE media_file_name=${sqlQuote(file.fileName)} LIMIT 1`,
        );
        if (references.length)
          throw new ElizaError(
            "[FamilyDeletion] A private file is still referenced",
            { code: "FAMILY_DELETION_SHARED_SOURCE" },
          );
        const bytes = await storage.readPrivate(file.fileName);
        if (bytes !== null) {
          if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
            throw new ElizaError(
              "[FamilyDeletion] Private file content changed; reconcile it before deletion",
              { code: "FAMILY_DELETION_FILE_CHANGED" },
            );
          await storage.deletePrivate(file.fileName);
        }
        if ((await storage.readPrivate(file.fileName)) !== null)
          throw new ElizaError(
            "[FamilyDeletion] Private file removal could not be verified",
            { code: "FAMILY_DELETION_FILE_PURGE_FAILED" },
          );
      }
      const updated: FamilyDeletionJob = { ...job, state: "backup_pending" };
      await executeRawSqlTx(
        tx,
        `UPDATE ${table} SET job_json=${sqlQuote(JSON.stringify(updated))}::jsonb WHERE agent_id=${sqlQuote(runtime.agentId)}`,
      );
      return updated;
    });
  } catch (cause) {
    // error-policy:J2 Preserve the pending journal when storage or acknowledgement fails.
    if (cause instanceof ElizaError) throw cause;
    throw new ElizaError(
      "[FamilyDeletion] Private file cleanup is incomplete; retry to reconcile it",
      { code: "FAMILY_DELETION_FILE_PURGE_FAILED", cause },
    );
  }
}
