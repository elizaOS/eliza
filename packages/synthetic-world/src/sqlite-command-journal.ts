/** Adapts the storage-neutral command journal to the lease store's SQLite transaction. */

import type { Database } from "bun:sqlite";
import type { SyntheticEnvironmentLeaseStore } from "@elizaos/shared/contracts/synthetic-environment-lease";
import { LeaseFencedSyntheticCommandJournal } from "./command-journal";
import type {
  SyntheticCommandJournalExpected,
  SyntheticCommandJournalIdentity,
  SyntheticCommandJournalPatch,
  SyntheticCommandJournalRepository,
  SyntheticCommandJournalRow,
} from "./journal-repository";

interface SqliteCommandRow {
  namespace: string;
  command_id: string;
  generation: number;
  command_type: string;
  payload_hash: string;
  payload_json: string;
  phase: SyntheticCommandJournalRow["phase"];
  outcome: SyntheticCommandJournalRow["outcome"];
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  execution_token: string | null;
  created_at_ms: number;
  heartbeat_at_ms: number;
  updated_at_ms: number;
  revision: number;
}

function toJournalRow(row: SqliteCommandRow): SyntheticCommandJournalRow {
  return {
    namespace: row.namespace,
    commandId: row.command_id,
    generation: row.generation,
    commandType: row.command_type,
    payloadHash: row.payload_hash,
    payloadJson: row.payload_json,
    phase: row.phase,
    outcome: row.outcome,
    resultJson: row.result_json,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    executionToken: row.execution_token,
    createdAtMs: row.created_at_ms,
    heartbeatAtMs: row.heartbeat_at_ms,
    updatedAtMs: row.updated_at_ms,
    revision: row.revision,
  };
}

class SqliteSyntheticCommandJournalRepository
  implements SyntheticCommandJournalRepository<Database>
{
  initialize(database: Database): void {
    database.run(`
      CREATE TABLE IF NOT EXISTS synthetic_world_commands (
        namespace TEXT NOT NULL,
        command_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        command_type TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('OWNED', 'EXECUTING', 'COMMITTED', 'SUCCEEDED', 'FAILED', 'DIRTY')),
        outcome TEXT NOT NULL CHECK (outcome IN ('PENDING', 'KNOWN_SUCCESS', 'KNOWN_FAILURE', 'UNKNOWN')),
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        execution_token TEXT,
        created_at_ms INTEGER NOT NULL,
        heartbeat_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        PRIMARY KEY (namespace, command_id)
      )
    `);
  }

  now(): number {
    return Date.now();
  }

  find(
    database: Database,
    identity: SyntheticCommandJournalIdentity,
  ): SyntheticCommandJournalRow | null {
    const row = database
      .query<SqliteCommandRow, [string, string]>(
        "SELECT * FROM synthetic_world_commands WHERE namespace = ? AND command_id = ?",
      )
      .get(identity.namespace, identity.commandId);
    return row === null ? null : toJournalRow(row);
  }

  list(database: Database, namespace: string): SyntheticCommandJournalRow[] {
    return database
      .query<SqliteCommandRow, [string]>(
        "SELECT * FROM synthetic_world_commands WHERE namespace = ? ORDER BY command_id",
      )
      .all(namespace)
      .map(toJournalRow);
  }

  insert(database: Database, row: SyntheticCommandJournalRow): number {
    return database.run(
      `INSERT INTO synthetic_world_commands (
        namespace, command_id, generation, command_type, payload_hash,
        payload_json, phase, outcome, result_json, error_code, error_message,
        execution_token, created_at_ms, heartbeat_at_ms, updated_at_ms, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.namespace,
        row.commandId,
        row.generation,
        row.commandType,
        row.payloadHash,
        row.payloadJson,
        row.phase,
        row.outcome,
        row.resultJson,
        row.errorCode,
        row.errorMessage,
        row.executionToken,
        row.createdAtMs,
        row.heartbeatAtMs,
        row.updatedAtMs,
        row.revision,
      ],
    ).changes;
  }

  compareAndSet(
    database: Database,
    identity: SyntheticCommandJournalIdentity,
    expected: SyntheticCommandJournalExpected,
    patch: SyntheticCommandJournalPatch,
  ): number {
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    const columns: Array<[keyof SyntheticCommandJournalPatch, string]> = [
      ["generation", "generation"],
      ["phase", "phase"],
      ["outcome", "outcome"],
      ["resultJson", "result_json"],
      ["errorCode", "error_code"],
      ["errorMessage", "error_message"],
      ["executionToken", "execution_token"],
      ["heartbeatAtMs", "heartbeat_at_ms"],
      ["updatedAtMs", "updated_at_ms"],
      ["revision", "revision"],
    ];
    for (const [property, column] of columns) {
      if (!Object.hasOwn(patch, property)) continue;
      assignments.push(`${column} = ?`);
      values.push(patch[property] as string | number | null);
    }
    values.push(
      identity.namespace,
      identity.commandId,
      expected.generation,
      expected.phase,
      expected.executionToken,
      expected.executionToken,
      expected.revision,
    );
    return database.run(
      `UPDATE synthetic_world_commands SET ${assignments.join(", ")}
       WHERE namespace = ? AND command_id = ? AND generation = ? AND phase = ?
         AND ((execution_token = ?) OR (execution_token IS NULL AND ? IS NULL))
         AND revision = ?`,
      values,
    ).changes;
  }
}

/** Local SW-1 adapter composed over a lease store backed by the same database. */
export class SqliteSyntheticCommandJournal extends LeaseFencedSyntheticCommandJournal<Database> {
  constructor(leaseStore: SyntheticEnvironmentLeaseStore<Database>) {
    super(leaseStore, new SqliteSyntheticCommandJournalRepository());
  }
}
