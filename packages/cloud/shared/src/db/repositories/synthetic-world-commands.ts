/** Adapts the synthetic command journal repository to Cloud PostgreSQL/PGlite transactions. */

import { ElizaError } from "@elizaos/core";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { DbTransaction } from "../client";
import {
  type NewSyntheticWorldCommandRow,
  type SyntheticWorldCommandRow,
  syntheticWorldCommands,
} from "../schemas/synthetic-world-commands";
import { readPostLockDatabaseNow } from "./primary-database-clock";

type SyntheticCommandPhase = "OWNED" | "EXECUTING" | "COMMITTED" | "SUCCEEDED" | "FAILED" | "DIRTY";

type SyntheticCommandOutcome = "PENDING" | "KNOWN_SUCCESS" | "KNOWN_FAILURE" | "UNKNOWN";

export interface CloudSyntheticCommandJournalRow {
  namespace: string;
  commandId: string;
  generation: number;
  commandType: string;
  payloadHash: string;
  payloadJson: string;
  phase: SyntheticCommandPhase;
  outcome: SyntheticCommandOutcome;
  resultJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  executionToken: string | null;
  createdAtMs: number;
  heartbeatAtMs: number;
  updatedAtMs: number;
  revision: number;
}

export interface CloudSyntheticCommandJournalIdentity {
  namespace: string;
  commandId: string;
}

export interface CloudSyntheticCommandJournalExpected {
  generation: number;
  phase: SyntheticCommandPhase;
  executionToken: string | null;
  revision: number;
}

export interface CloudSyntheticCommandJournalPatch {
  generation?: number;
  phase?: SyntheticCommandPhase;
  outcome?: SyntheticCommandOutcome;
  resultJson?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  executionToken?: string | null;
  heartbeatAtMs: number;
  updatedAtMs: number;
  revision: number;
}

function storageFailure(message: string, row: SyntheticWorldCommandRow): ElizaError {
  return new ElizaError(message, {
    code: "SYNTHETIC_COMMAND_STORAGE_FAILURE",
    severity: "fatal",
    context: { namespace: row.namespace, commandId: row.command_id },
  });
}

function parsePhase(row: SyntheticWorldCommandRow): SyntheticCommandPhase {
  switch (row.phase) {
    case "OWNED":
    case "EXECUTING":
    case "COMMITTED":
    case "SUCCEEDED":
    case "FAILED":
    case "DIRTY":
      return row.phase;
    default:
      throw storageFailure("Stored synthetic command phase is invalid", row);
  }
}

function parseOutcome(row: SyntheticWorldCommandRow): SyntheticCommandOutcome {
  switch (row.outcome) {
    case "PENDING":
    case "KNOWN_SUCCESS":
    case "KNOWN_FAILURE":
    case "UNKNOWN":
      return row.outcome;
    default:
      throw storageFailure("Stored synthetic command outcome is invalid", row);
  }
}

function toJournalRow(row: SyntheticWorldCommandRow): CloudSyntheticCommandJournalRow {
  return {
    namespace: row.namespace,
    commandId: row.command_id,
    generation: row.generation,
    commandType: row.command_type,
    payloadHash: row.payload_hash,
    payloadJson: row.payload_json,
    phase: parsePhase(row),
    outcome: parseOutcome(row),
    resultJson: row.result_json,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    executionToken: row.execution_token,
    createdAtMs: row.created_at.getTime(),
    heartbeatAtMs: row.heartbeat_at.getTime(),
    updatedAtMs: row.updated_at.getTime(),
    revision: row.revision,
  };
}

function toInsert(row: CloudSyntheticCommandJournalRow): NewSyntheticWorldCommandRow {
  return {
    namespace: row.namespace,
    command_id: row.commandId,
    generation: row.generation,
    command_type: row.commandType,
    payload_hash: row.payloadHash,
    payload_json: row.payloadJson,
    phase: row.phase,
    outcome: row.outcome,
    result_json: row.resultJson,
    error_code: row.errorCode,
    error_message: row.errorMessage,
    execution_token: row.executionToken,
    created_at: new Date(row.createdAtMs),
    heartbeat_at: new Date(row.heartbeatAtMs),
    updated_at: new Date(row.updatedAtMs),
    revision: row.revision,
  };
}

/** Repository implementation consumed structurally by the storage-neutral journal engine. */
export class CloudSyntheticCommandJournalRepository {
  async initialize(_transaction: DbTransaction): Promise<void> {
    // Production schema is installed by the append-only Cloud migration lane.
  }

  async now(transaction: DbTransaction): Promise<number> {
    return (await readPostLockDatabaseNow(transaction)).getTime();
  }

  async find(
    transaction: DbTransaction,
    identity: CloudSyntheticCommandJournalIdentity,
  ): Promise<CloudSyntheticCommandJournalRow | null> {
    const [row] = await transaction
      .select()
      .from(syntheticWorldCommands)
      .where(
        and(
          eq(syntheticWorldCommands.namespace, identity.namespace),
          eq(syntheticWorldCommands.command_id, identity.commandId),
        ),
      )
      .limit(1);
    return row ? toJournalRow(row) : null;
  }

  async list(
    transaction: DbTransaction,
    namespace: string,
  ): Promise<CloudSyntheticCommandJournalRow[]> {
    const rows = await transaction
      .select()
      .from(syntheticWorldCommands)
      .where(eq(syntheticWorldCommands.namespace, namespace))
      .orderBy(asc(syntheticWorldCommands.command_id));
    return rows.map(toJournalRow);
  }

  async insert(transaction: DbTransaction, row: CloudSyntheticCommandJournalRow): Promise<number> {
    const inserted = await transaction
      .insert(syntheticWorldCommands)
      .values(toInsert(row))
      .onConflictDoNothing()
      .returning({ commandId: syntheticWorldCommands.command_id });
    return inserted.length;
  }

  async compareAndSet(
    transaction: DbTransaction,
    identity: CloudSyntheticCommandJournalIdentity,
    expected: CloudSyntheticCommandJournalExpected,
    patch: CloudSyntheticCommandJournalPatch,
  ): Promise<number> {
    const values: Partial<NewSyntheticWorldCommandRow> = {
      heartbeat_at: new Date(patch.heartbeatAtMs),
      updated_at: new Date(patch.updatedAtMs),
      revision: patch.revision,
    };
    if (patch.generation !== undefined) values.generation = patch.generation;
    if (patch.phase !== undefined) values.phase = patch.phase;
    if (patch.outcome !== undefined) values.outcome = patch.outcome;
    if (patch.resultJson !== undefined) values.result_json = patch.resultJson;
    if (patch.errorCode !== undefined) values.error_code = patch.errorCode;
    if (patch.errorMessage !== undefined) values.error_message = patch.errorMessage;
    if (patch.executionToken !== undefined) values.execution_token = patch.executionToken;

    const tokenCondition =
      expected.executionToken === null
        ? isNull(syntheticWorldCommands.execution_token)
        : eq(syntheticWorldCommands.execution_token, expected.executionToken);
    const updated = await transaction
      .update(syntheticWorldCommands)
      .set(values)
      .where(
        and(
          eq(syntheticWorldCommands.namespace, identity.namespace),
          eq(syntheticWorldCommands.command_id, identity.commandId),
          eq(syntheticWorldCommands.generation, expected.generation),
          eq(syntheticWorldCommands.phase, expected.phase),
          tokenCondition,
          eq(syntheticWorldCommands.revision, expected.revision),
        ),
      )
      .returning({ commandId: syntheticWorldCommands.command_id });
    return updated.length;
  }
}

export const cloudSyntheticCommandJournalRepository = new CloudSyntheticCommandJournalRepository();
