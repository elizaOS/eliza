/**
 * Serializes family operation admission against the workspace's durable deletion fence.
 * Claims contain identities only and have no expiry: elapsed time cannot prove that
 * an external request stopped. The deletion transaction must observe every claim
 * settled before fencing the workspace. The fence survives runtime restarts.
 */
import { randomUUID } from "node:crypto";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { z } from "zod";
import {
  executeRawSql,
  executeRawSqlTx,
  sqlQuote,
  type TransactionalDb,
  withTransaction,
} from "../sql.js";

const operations = "app_lifeops.life_family_workspace_operations";
const lifecycle = "app_lifeops.life_family_workspace_state";
const schema = [
  "CREATE SCHEMA IF NOT EXISTS app_lifeops",
  `CREATE TABLE IF NOT EXISTS ${lifecycle} (
    agent_id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('active', 'revoking', 'deleted')),
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${operations} (
    agent_id TEXT NOT NULL, operation_id TEXT NOT NULL,
    kind TEXT NOT NULL, started_at TEXT NOT NULL,
    artifact_id TEXT NOT NULL, content_sha256 TEXT NOT NULL,
    PRIMARY KEY (agent_id, operation_id)
  )`,
] as const;

export async function ensureFamilyWorkspaceOperationStore(
  runtime: IAgentRuntime,
) {
  for (const statement of schema) await executeRawSql(runtime, statement);
  await executeRawSql(
    runtime,
    `INSERT INTO ${lifecycle} (agent_id,state,updated_at)
     VALUES (${sqlQuote(runtime.agentId)},'active',${sqlQuote(new Date().toISOString())})
     ON CONFLICT (agent_id) DO NOTHING`,
  );
}

export async function beginFamilyWorkspaceOperation(
  runtime: IAgentRuntime,
  kind: "agreement-upload",
  target: { artifactId: string; contentSha256: string },
): Promise<string> {
  const identity = z
    .object({
      artifactId: z.string().regex(/^hag_[0-9a-f-]{36}$/),
      contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict()
    .parse(target);
  await ensureFamilyWorkspaceOperationStore(runtime);
  return withTransaction(runtime, async (tx) => {
    // Match deletion's sorted table-lock order before taking the tenant row lock.
    await executeRawSqlTx(
      tx,
      `LOCK TABLE ${operations}, ${lifecycle} IN ROW EXCLUSIVE MODE`,
    );
    const rows = await executeRawSqlTx(
      tx,
      `SELECT state FROM ${lifecycle} WHERE agent_id=${sqlQuote(runtime.agentId)} FOR UPDATE`,
    );
    if (rows.length !== 1 || rows[0].state !== "active")
      throw new ElizaError(
        "[FamilyWorkspace] Deletion has fenced new family work",
        {
          code: "FAMILY_WORKSPACE_FENCED",
        },
      );
    const id = randomUUID();
    await executeRawSqlTx(
      tx,
      `INSERT INTO ${operations} (agent_id,operation_id,kind,started_at,artifact_id,content_sha256)
       VALUES (${sqlQuote(runtime.agentId)},${sqlQuote(id)},${sqlQuote(kind)},${sqlQuote(new Date().toISOString())},${sqlQuote(identity.artifactId)},${sqlQuote(identity.contentSha256)})`,
    );
    return id;
  });
}

/** Settle only after the operation and any required compensation have finished. */
export async function settleFamilyWorkspaceOperation(
  runtime: IAgentRuntime,
  operationId: string,
): Promise<void> {
  const id = z.uuid().parse(operationId);
  const rows = await executeRawSql(
    runtime,
    `DELETE FROM ${operations} WHERE agent_id=${sqlQuote(runtime.agentId)}
     AND operation_id=${sqlQuote(id)} RETURNING operation_id`,
  );
  if (rows.length !== 1)
    throw new ElizaError(
      "[FamilyWorkspace] Operation settlement requires reconciliation",
      {
        code: "FAMILY_OPERATION_SETTLEMENT_UNKNOWN",
        context: { operationId: id },
      },
    );
}

/** Called inside the reviewed deletion transaction, never from an unguarded route. */
export async function fenceFamilyWorkspace(
  tx: TransactionalDb,
  agentId: string,
): Promise<void> {
  await executeRawSqlTx(
    tx,
    `LOCK TABLE ${operations}, ${lifecycle} IN SHARE ROW EXCLUSIVE MODE`,
  );
  const active = await executeRawSqlTx(
    tx,
    `SELECT operation_id FROM ${operations} WHERE agent_id=${sqlQuote(agentId)}`,
  );
  if (active.length)
    throw new ElizaError(
      "[FamilyWorkspace] Settle or reconcile active operations before deletion",
      {
        code: "FAMILY_DELETION_WORK_UNSETTLED",
        context: {
          operationIds: active.map((row) => z.string().parse(row.operation_id)),
        },
      },
    );
  const rows = await executeRawSqlTx(
    tx,
    `UPDATE ${lifecycle} SET state='revoking',updated_at=${sqlQuote(new Date().toISOString())}
     WHERE agent_id=${sqlQuote(agentId)} AND state='active' RETURNING agent_id`,
  );
  if (rows.length !== 1)
    throw new ElizaError(
      "[FamilyWorkspace] The workspace is already fenced or unavailable",
      {
        code: "FAMILY_WORKSPACE_FENCED",
      },
    );
}
