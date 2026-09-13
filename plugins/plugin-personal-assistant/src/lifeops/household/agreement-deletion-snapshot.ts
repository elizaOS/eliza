/**
 * Binds a reviewed agreement-family dependency snapshot to a database transaction.
 * The complete immutable version family is selected before review. Table locks
 * prevent later versions, grants, pins, and review decisions from racing the
 * comparison and its caller's transactional revocation. This is one component
 * of workspace deletion; it does not delete documents, files, or provider data.
 */
import { createHash } from "node:crypto";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { z } from "zod";
import {
  executeRawSqlTx,
  sqlQuote,
  type TransactionalDb,
  withTransaction,
} from "../sql.js";

const selectionSchema = z.strictObject({
  householdId: z.string().trim().min(1),
  agreementKey: z.string().trim().min(1),
});
export type AgreementDeletionSelection = z.infer<typeof selectionSchema>;

const categories = [
  "versions",
  "obligations",
  "pins",
  "resourceGrants",
  "audit",
] as const;
const recordSchema = z.strictObject({
  kind: z.enum(categories),
  payload: z.string(),
});

export interface AgreementDeletionSnapshot {
  readonly selection: AgreementDeletionSelection;
  readonly sha256: string;
  /** Complete persisted JSON records. These owner-private values are not audit metadata. */
  readonly records: ReadonlyArray<{
    kind: (typeof categories)[number];
    payload: string;
  }>;
}

const tables = [
  "life_household_agreement_artifacts",
  "life_household_agreement_obligations",
  "life_household_knowledge_pins",
  "life_household_knowledge_grants",
  "life_audit_events",
] as const;

function requireOwner(ownerEntityId: string): void {
  if (ownerEntityId !== SELF_ENTITY_ID)
    throw new ElizaError(
      "[AgreementDeletion] Only the owner may review deletion dependencies",
      {
        code: "AGREEMENT_ACCESS_DENIED",
      },
    );
}

async function readSnapshot(
  tx: TransactionalDb,
  agentId: string,
  selection: AgreementDeletionSelection,
): Promise<AgreementDeletionSnapshot> {
  const agent = `agent_id = ${sqlQuote(agentId)}`;
  const versions = `SELECT id FROM app_lifeops.life_household_agreement_artifacts
    WHERE ${agent} AND household_id = ${sqlQuote(selection.householdId)}
    AND agreement_key = ${sqlQuote(selection.agreementKey)}`;
  const predicates = [
    `id IN (${versions})`,
    `artifact_id IN (${versions})`,
    `artifact_id IN (${versions})`,
    `artifact_id IN (${versions})`,
    `owner_type = 'parenting_agreement' AND owner_id IN (${versions})`,
  ];
  const raw = await executeRawSqlTx(
    tx,
    tables
      .map(
        (table, index) =>
          `SELECT ${sqlQuote(categories[index])} AS kind, to_jsonb(record)::text AS payload
     FROM app_lifeops.${table} AS record WHERE ${agent} AND ${predicates[index]}`,
      )
      .join(" UNION ALL "),
  );
  const records = raw
    .map((row) => recordSchema.parse(row))
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) || a.payload.localeCompare(b.payload),
    );
  if (!records.some((record) => record.kind === "versions"))
    throw new ElizaError(
      "[AgreementDeletion] The selected agreement family no longer exists",
      {
        code: "AGREEMENT_ARTIFACT_NOT_FOUND",
      },
    );
  const sha256 = createHash("sha256")
    .update(JSON.stringify({ agentId, selection, records }))
    .digest("hex");
  return { selection, sha256, records };
}

export async function previewAgreementDeletion(
  runtime: IAgentRuntime,
  input: { ownerEntityId: string; selection: AgreementDeletionSelection },
): Promise<AgreementDeletionSnapshot> {
  requireOwner(input.ownerEntityId);
  const selection = selectionSchema.parse(input.selection);
  // All records come from one statement snapshot; preview never mutates state.
  return withTransaction(runtime, (tx) =>
    readSnapshot(tx, runtime.agentId, selection),
  );
}

/** Compare under write-excluding locks and keep those locks through revocation. */
export async function withReviewedAgreementDeletion<T>(
  runtime: IAgentRuntime,
  input: {
    ownerEntityId: string;
    selection: AgreementDeletionSelection;
    expectedSha256: string;
  },
  revoke: (
    tx: TransactionalDb,
    snapshot: AgreementDeletionSnapshot,
  ) => Promise<T>,
): Promise<T> {
  requireOwner(input.ownerEntityId);
  const selection = selectionSchema.parse(input.selection);
  const expected = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(input.expectedSha256);
  return withTransaction(runtime, async (tx) => {
    // Every writer acquires a conflicting PostgreSQL table lock, including an
    // insertion that has no pre-existing row for SELECT FOR UPDATE to lock.
    await executeRawSqlTx(
      tx,
      `LOCK TABLE ${tables.map((table) => `app_lifeops.${table}`).join(", ")} IN SHARE ROW EXCLUSIVE MODE`,
    );
    const snapshot = await readSnapshot(tx, runtime.agentId, selection);
    if (snapshot.sha256 !== expected)
      throw new ElizaError(
        "[AgreementDeletion] Dependencies changed; review a new deletion preview",
        {
          code: "AGREEMENT_DELETION_PREVIEW_STALE",
        },
      );
    return revoke(tx, snapshot);
  });
}
