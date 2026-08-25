/**
 * Persists idempotent synthetic commands inside the existing lease store's
 * guarded SQLite transaction and classifies ambiguous restarts as dirty.
 */

import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core/errors";
import type {
  SyntheticEnvironmentLeaseAuthority,
  SyntheticEnvironmentLeaseStore,
} from "@elizaos/shared/contracts/synthetic-environment-lease";
import { isSyntheticEnvironmentNamespace } from "@elizaos/shared/contracts/synthetic-environment-lease";
import type {
  SyntheticCommandExecution,
  SyntheticCommandExecutionOptions,
  SyntheticCommandHeartbeat,
  SyntheticCommandOutcome,
  SyntheticCommandPhase,
  SyntheticCommandRecord,
  SyntheticCommandRecovery,
  SyntheticJson,
  SyntheticWorldCommand,
} from "./types";
import { SYNTHETIC_WORLD_COMMAND_VERSION } from "./types";

interface CommandRow {
  namespace: string;
  command_id: string;
  generation: number;
  command_type: string;
  payload_hash: string;
  payload_json: string;
  phase: SyntheticCommandPhase;
  outcome: SyntheticCommandOutcome;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  execution_token: string | null;
  created_at_ms: number;
  heartbeat_at_ms: number;
  updated_at_ms: number;
  revision: number;
}

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,127}$/;

function commandError(
  code: string,
  message: string,
  context?: Record<string, string | number>,
  cause?: unknown,
): ElizaError {
  return new ElizaError(message, {
    code,
    severity: "fatal",
    context,
    cause,
  });
}

function invalidJson(message: string, cause?: unknown): ElizaError {
  return commandError(
    "SYNTHETIC_COMMAND_INVALID_INPUT",
    message,
    undefined,
    cause,
  );
}

function compareUtf16(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalJson(
  value: unknown,
  ancestors = new WeakSet<object>(),
): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalidJson("JSON numbers must be finite");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw invalidJson(
      "JSON values cannot contain undefined, bigint, functions, or symbols",
    );
  }
  if (ancestors.has(value)) {
    throw invalidJson("JSON values cannot contain cycles");
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw invalidJson("JSON arrays must use the built-in Array prototype");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const allowedKeys = new Set<PropertyKey>(["length"]);
    for (let index = 0; index < value.length; index += 1) {
      const key = String(index);
      allowedKeys.add(key);
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        throw invalidJson("JSON arrays must be dense data-property arrays");
      }
    }
    if (keys.some((key) => !allowedKeys.has(key))) {
      throw invalidJson("JSON arrays cannot contain custom properties");
    }
    const encoded = value.map((entry) => canonicalJson(entry, ancestors));
    ancestors.delete(value);
    return `[${encoded.join(",")}]`;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidJson("JSON objects must have a plain or null prototype");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key === "symbol")) {
    throw invalidJson("JSON objects cannot contain symbol properties");
  }
  const stringKeys = keys as string[];
  for (const key of stringKeys) {
    const descriptor = descriptors[key];
    if (!("value" in descriptor) || !descriptor.enumerable) {
      throw invalidJson(
        "JSON objects must contain only enumerable data properties",
      );
    }
  }
  stringKeys.sort(compareUtf16);
  const encoded = stringKeys.map((key) => {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) {
      throw invalidJson("JSON object descriptor disappeared during encoding");
    }
    return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, ancestors)}`;
  });
  ancestors.delete(value);
  return `{${encoded.join(",")}}`;
}

function serializeJson(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch (error) {
    // error-policy:J3 Unexpected reflection failures are invalid input, never raw boundary errors.
    if (error instanceof ElizaError) throw error;
    throw invalidJson("JSON value could not be inspected safely", error);
  }
}

function validateCommand(
  authority: SyntheticEnvironmentLeaseAuthority,
  command: SyntheticWorldCommand,
): { payloadJson: string; payloadHash: string } {
  if (
    command.version !== SYNTHETIC_WORLD_COMMAND_VERSION ||
    !isSyntheticEnvironmentNamespace(command.namespace) ||
    !Number.isSafeInteger(command.generation) ||
    command.generation < 1 ||
    !IDENTIFIER_PATTERN.test(command.commandId) ||
    !IDENTIFIER_PATTERN.test(command.type)
  ) {
    throw commandError(
      "SYNTHETIC_COMMAND_INVALID_INPUT",
      "Command version, namespace, generation, ID, or type is invalid",
    );
  }
  if (
    command.namespace !== authority.namespace ||
    command.generation !== authority.generation
  ) {
    throw commandError(
      "SYNTHETIC_COMMAND_GENERATION_MISMATCH",
      "Command namespace and generation must match its lease authority",
      {
        namespace: command.namespace,
        generation: command.generation,
        authorityGeneration: authority.generation,
      },
    );
  }
  const payloadJson = serializeJson(command.payload);
  return {
    payloadJson,
    payloadHash: createHash("sha256").update(payloadJson).digest("hex"),
  };
}

function ensureSchema(database: Database): void {
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

function selectRow(
  database: Database,
  namespace: string,
  commandId: string,
): CommandRow | null {
  return database
    .query<CommandRow, [string, string]>(
      "SELECT * FROM synthetic_world_commands WHERE namespace = ? AND command_id = ?",
    )
    .get(namespace, commandId);
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function parseJson(value: string, field: "payload" | "result"): SyntheticJson {
  try {
    const parsed: unknown = JSON.parse(value);
    if (serializeJson(parsed) !== value) {
      throw new Error("stored JSON is not canonical");
    }
    return parsed as SyntheticJson;
  } catch (error) {
    // error-policy:J3 Corrupt journal JSON is translated to an explicit storage failure.
    throw commandError(
      "SYNTHETIC_COMMAND_STORAGE_FAILURE",
      `Stored command ${field} JSON is corrupt or non-canonical`,
      undefined,
      error,
    );
  }
}

function toRecord(row: CommandRow): SyntheticCommandRecord {
  return {
    version: SYNTHETIC_WORLD_COMMAND_VERSION,
    namespace: row.namespace,
    commandId: row.command_id,
    generation: row.generation,
    type: row.command_type,
    payloadHash: row.payload_hash,
    payload: parseJson(row.payload_json, "payload"),
    phase: row.phase,
    outcome: row.outcome,
    result:
      row.result_json === null ? null : parseJson(row.result_json, "result"),
    error:
      row.error_code === null || row.error_message === null
        ? null
        : { code: row.error_code, message: row.error_message },
    executionToken: row.execution_token,
    createdAt: iso(row.created_at_ms),
    heartbeatAt: iso(row.heartbeat_at_ms),
    updatedAt: iso(row.updated_at_ms),
    revision: row.revision,
  };
}

function assertSamePayload(
  row: CommandRow,
  command: SyntheticWorldCommand,
  payloadHash: string,
): void {
  if (row.command_type !== command.type || row.payload_hash !== payloadHash) {
    throw commandError(
      "SYNTHETIC_COMMAND_ID_CONFLICT",
      "Command ID was already used with a different type or payload",
      { namespace: command.namespace, commandId: command.commandId },
    );
  }
}

interface ClaimResult {
  replay: CommandRow | null;
  executionToken: string | null;
}

/** Local SW-1 adapter composed over a lease store backed by the same database. */
export class SqliteSyntheticCommandJournal {
  constructor(
    private readonly leaseStore: SyntheticEnvironmentLeaseStore<Database>,
  ) {}

  async execute(
    authority: SyntheticEnvironmentLeaseAuthority,
    command: SyntheticWorldCommand,
    mutate: (database: Database) => SyntheticJson,
    options: SyntheticCommandExecutionOptions = {},
  ): Promise<SyntheticCommandExecution> {
    const { payloadJson, payloadHash } = validateCommand(authority, command);
    const now = Date.now();
    const executionToken = randomUUID();
    const claim = await this.leaseStore.withActiveGeneration(
      authority,
      (database): ClaimResult => {
        ensureSchema(database);
        const existing = selectRow(
          database,
          command.namespace,
          command.commandId,
        );
        if (existing !== null) {
          assertSamePayload(existing, command, payloadHash);
          if (existing.generation > authority.generation) {
            throw commandError(
              "SYNTHETIC_COMMAND_STORAGE_FAILURE",
              "Command generation is newer than the active lease generation",
              {
                namespace: command.namespace,
                commandId: command.commandId,
                commandGeneration: existing.generation,
                authorityGeneration: authority.generation,
              },
            );
          }
          if (existing.phase === "SUCCEEDED" && existing.result_json !== null) {
            return { replay: existing, executionToken: null };
          }
          if (existing.phase === "FAILED") {
            if (
              existing.error_code === null ||
              existing.error_message === null
            ) {
              throw commandError(
                "SYNTHETIC_COMMAND_STORAGE_FAILURE",
                "Failed command is missing its stored error",
              );
            }
            throw commandError(existing.error_code, existing.error_message, {
              namespace: command.namespace,
              commandId: command.commandId,
            });
          }
          if (existing.phase === "DIRTY") {
            throw commandError(
              "SYNTHETIC_COMMAND_DIRTY",
              "Command has an unknown outcome and cannot be replayed",
              { namespace: command.namespace, commandId: command.commandId },
            );
          }
          if (existing.execution_token !== null) {
            throw commandError(
              "SYNTHETIC_COMMAND_IN_PROGRESS",
              "Command is already owned by another execution",
              { namespace: command.namespace, commandId: command.commandId },
            );
          }
          const claimed = database.run(
            `UPDATE synthetic_world_commands
             SET generation = ?, execution_token = ?, heartbeat_at_ms = ?, updated_at_ms = ?, revision = revision + 1
             WHERE namespace = ? AND command_id = ? AND phase = 'OWNED' AND execution_token IS NULL`,
            [
              authority.generation,
              executionToken,
              now,
              now,
              command.namespace,
              command.commandId,
            ],
          );
          if (claimed.changes !== 1) {
            throw commandError(
              "SYNTHETIC_COMMAND_OWNERSHIP_LOST",
              "Command ownership claim did not update exactly one record",
              { namespace: command.namespace, commandId: command.commandId },
            );
          }
          return { replay: null, executionToken };
        }
        const inserted = database.run(
          `INSERT INTO synthetic_world_commands (
            namespace, command_id, generation, command_type, payload_hash,
            payload_json, phase, outcome, result_json, error_code, error_message, execution_token,
            created_at_ms, heartbeat_at_ms, updated_at_ms, revision
          ) VALUES (?, ?, ?, ?, ?, ?, 'OWNED', 'PENDING', NULL, NULL, NULL, ?, ?, ?, ?, 1)`,
          [
            command.namespace,
            command.commandId,
            authority.generation,
            command.type,
            payloadHash,
            payloadJson,
            executionToken,
            now,
            now,
            now,
          ],
        );
        if (inserted.changes !== 1) {
          throw commandError(
            "SYNTHETIC_COMMAND_STORAGE_FAILURE",
            "Command creation did not insert exactly one record",
            { namespace: command.namespace, commandId: command.commandId },
          );
        }
        return { replay: null, executionToken };
      },
    );
    if (claim.value.replay !== null) {
      const result = claim.value.replay.result_json;
      if (result === null) {
        throw commandError(
          "SYNTHETIC_COMMAND_STORAGE_FAILURE",
          "Succeeded command is missing its result",
        );
      }
      return {
        record: toRecord(claim.value.replay),
        result: parseJson(result, "result"),
        replayed: true,
      };
    }
    await options.onCheckpoint?.({
      phase: "OWNED",
      commandId: command.commandId,
      executionToken,
    });
    await this.transition(
      authority,
      command.commandId,
      executionToken,
      "OWNED",
      "EXECUTING",
    );
    await options.onCheckpoint?.({
      phase: "EXECUTING",
      commandId: command.commandId,
      executionToken,
    });

    let result: SyntheticJson;
    try {
      const committed = await this.leaseStore.withActiveGeneration(
        authority,
        (database): SyntheticJson => {
          ensureSchema(database);
          const row = selectRow(database, command.namespace, command.commandId);
          this.assertExecution(
            row,
            executionToken,
            "EXECUTING",
            command.commandId,
          );
          const mutationResult = mutate(database);
          const resultJson = serializeJson(mutationResult);
          const changedAt = Date.now();
          database.run(
            `UPDATE synthetic_world_commands
             SET phase = 'COMMITTED', result_json = ?, heartbeat_at_ms = ?, updated_at_ms = ?, revision = revision + 1
             WHERE namespace = ? AND command_id = ? AND execution_token = ? AND phase = 'EXECUTING'`,
            [
              resultJson,
              changedAt,
              changedAt,
              command.namespace,
              command.commandId,
              executionToken,
            ],
          );
          return mutationResult;
        },
      );
      result = committed.value;
    } catch (error) {
      // error-policy:J2 The guarded transaction rolled back, so persist and rethrow a known failure.
      const failureCode =
        error instanceof ElizaError
          ? error.code
          : "SYNTHETIC_COMMAND_EXECUTION_FAILED";
      const failureMessage =
        error instanceof Error ? error.message : "Command mutation threw";
      try {
        await this.markFailed(
          authority,
          command.commandId,
          executionToken,
          failureCode,
          failureMessage,
        );
      } catch (classificationError) {
        // error-policy:J2 Lease loss while recording known failure is attached to the surfaced failure.
        throw commandError(
          "SYNTHETIC_COMMAND_FAILURE_CLASSIFICATION_FAILED",
          "Mutation rolled back but the journal could not persist its failure",
          { namespace: command.namespace, commandId: command.commandId },
          { mutationError: error, classificationError },
        );
      }
      throw commandError(
        failureCode,
        failureMessage,
        { namespace: command.namespace, commandId: command.commandId },
        error,
      );
    }

    await options.onCheckpoint?.({
      phase: "COMMITTED",
      commandId: command.commandId,
      executionToken,
    });
    const final = await this.transition(
      authority,
      command.commandId,
      executionToken,
      "COMMITTED",
      "SUCCEEDED",
    );
    return { record: final, result, replayed: false };
  }

  async heartbeat(
    input: SyntheticCommandHeartbeat,
  ): Promise<SyntheticCommandRecord> {
    const guarded = await this.leaseStore.withActiveGeneration(
      input.authority,
      (database) => {
        ensureSchema(database);
        const now = Date.now();
        const result = database.run(
          `UPDATE synthetic_world_commands
           SET heartbeat_at_ms = ?, updated_at_ms = ?, revision = revision + 1
           WHERE namespace = ? AND command_id = ? AND execution_token = ? AND phase IN ('OWNED', 'EXECUTING', 'COMMITTED')`,
          [
            now,
            now,
            input.authority.namespace,
            input.commandId,
            input.executionToken,
          ],
        );
        if (result.changes !== 1) {
          throw commandError(
            "SYNTHETIC_COMMAND_OWNERSHIP_LOST",
            "Command heartbeat token is stale or the command is no longer active",
          );
        }
        return toRecord(
          selectRow(
            database,
            input.authority.namespace,
            input.commandId,
          ) as CommandRow,
        );
      },
    );
    return guarded.value;
  }

  async inspect(
    authority: SyntheticEnvironmentLeaseAuthority,
    commandId: string,
  ): Promise<SyntheticCommandRecord | null> {
    const guarded = await this.leaseStore.withActiveGeneration(
      authority,
      (database) => {
        ensureSchema(database);
        const row = selectRow(database, authority.namespace, commandId);
        return row === null ? null : toRecord(row);
      },
    );
    return guarded.value;
  }

  async recover(
    authority: SyntheticEnvironmentLeaseAuthority,
  ): Promise<SyntheticCommandRecovery> {
    const guarded = await this.leaseStore.withActiveGeneration(
      authority,
      (database): SyntheticCommandRecovery => {
        ensureSchema(database);
        const rows = database
          .query<CommandRow, [string]>(
            "SELECT * FROM synthetic_world_commands WHERE namespace = ? ORDER BY command_id",
          )
          .all(authority.namespace);
        const retryableCommandIds: string[] = [];
        const failedCommandIds: string[] = [];
        const dirtyCommandIds: string[] = [];
        const activeCommandIds: string[] = [];
        const now = Date.now();
        for (const row of rows) {
          if (
            row.phase === "SUCCEEDED" ||
            row.phase === "FAILED" ||
            row.phase === "DIRTY"
          ) {
            continue;
          }
          if (row.generation > authority.generation) {
            throw commandError(
              "SYNTHETIC_COMMAND_STORAGE_FAILURE",
              "Command generation is newer than the active lease generation",
              {
                namespace: authority.namespace,
                commandId: row.command_id,
                commandGeneration: row.generation,
                authorityGeneration: authority.generation,
              },
            );
          }
          if (row.generation === authority.generation) {
            activeCommandIds.push(row.command_id);
            continue;
          }
          if (row.phase === "OWNED") {
            const result = database.run(
              `UPDATE synthetic_world_commands
               SET generation = ?, execution_token = NULL, heartbeat_at_ms = ?, updated_at_ms = ?, revision = revision + 1
               WHERE namespace = ? AND command_id = ? AND generation = ? AND phase = 'OWNED'`,
              [
                authority.generation,
                now,
                now,
                authority.namespace,
                row.command_id,
                row.generation,
              ],
            );
            this.assertRecoveryUpdate(result.changes, row.command_id);
            retryableCommandIds.push(row.command_id);
            continue;
          }
          if (row.phase === "EXECUTING") {
            const result = database.run(
              `UPDATE synthetic_world_commands
               SET generation = ?, phase = 'FAILED', outcome = 'KNOWN_FAILURE', execution_token = NULL,
                   error_code = 'SYNTHETIC_COMMAND_ABORTED_BEFORE_COMMIT',
                   error_message = 'Prior process stopped before its atomic mutation committed',
                   heartbeat_at_ms = ?, updated_at_ms = ?, revision = revision + 1
               WHERE namespace = ? AND command_id = ? AND generation = ? AND phase = 'EXECUTING'`,
              [
                authority.generation,
                now,
                now,
                authority.namespace,
                row.command_id,
                row.generation,
              ],
            );
            this.assertRecoveryUpdate(result.changes, row.command_id);
            failedCommandIds.push(row.command_id);
            continue;
          }
          this.markDirty(database, authority, row, now);
          dirtyCommandIds.push(row.command_id);
        }
        return {
          retryableCommandIds,
          failedCommandIds,
          dirtyCommandIds,
          activeCommandIds,
        };
      },
    );
    return guarded.value;
  }

  private async transition(
    authority: SyntheticEnvironmentLeaseAuthority,
    commandId: string,
    executionToken: string,
    from: SyntheticCommandPhase,
    to: SyntheticCommandPhase,
  ): Promise<SyntheticCommandRecord> {
    const guarded = await this.leaseStore.withActiveGeneration(
      authority,
      (database) => {
        ensureSchema(database);
        const row = selectRow(database, authority.namespace, commandId);
        this.assertExecution(row, executionToken, from, commandId);
        const now = Date.now();
        const outcome = to === "SUCCEEDED" ? "KNOWN_SUCCESS" : "PENDING";
        const token = to === "SUCCEEDED" ? null : executionToken;
        const transitioned = database.run(
          `UPDATE synthetic_world_commands
           SET phase = ?, outcome = ?, execution_token = ?, heartbeat_at_ms = ?, updated_at_ms = ?, revision = revision + 1
           WHERE namespace = ? AND command_id = ? AND execution_token = ? AND phase = ?`,
          [
            to,
            outcome,
            token,
            now,
            now,
            authority.namespace,
            commandId,
            executionToken,
            from,
          ],
        );
        if (transitioned.changes !== 1) {
          throw commandError(
            "SYNTHETIC_COMMAND_OWNERSHIP_LOST",
            "Command transition did not update exactly one record",
            { namespace: authority.namespace, commandId },
          );
        }
        return toRecord(
          selectRow(database, authority.namespace, commandId) as CommandRow,
        );
      },
    );
    return guarded.value;
  }

  private async markFailed(
    authority: SyntheticEnvironmentLeaseAuthority,
    commandId: string,
    executionToken: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    await this.leaseStore.withActiveGeneration(authority, (database) => {
      ensureSchema(database);
      const now = Date.now();
      const result = database.run(
        `UPDATE synthetic_world_commands
         SET phase = 'FAILED', outcome = 'KNOWN_FAILURE', execution_token = NULL,
             error_code = ?, error_message = ?,
             heartbeat_at_ms = ?, updated_at_ms = ?, revision = revision + 1
         WHERE namespace = ? AND command_id = ? AND execution_token = ? AND phase = 'EXECUTING'`,
        [
          errorCode,
          errorMessage,
          now,
          now,
          authority.namespace,
          commandId,
          executionToken,
        ],
      );
      if (result.changes !== 1) {
        throw commandError(
          "SYNTHETIC_COMMAND_OWNERSHIP_LOST",
          "Failed command could not be durably classified",
          { namespace: authority.namespace, commandId },
        );
      }
    });
  }

  private markDirty(
    database: Database,
    authority: SyntheticEnvironmentLeaseAuthority,
    row: CommandRow,
    now: number,
  ): void {
    const result = database.run(
      `UPDATE synthetic_world_commands
       SET generation = ?, phase = 'DIRTY', outcome = 'UNKNOWN', execution_token = NULL,
           error_code = 'SYNTHETIC_COMMAND_RECOVERED_AMBIGUOUS',
           error_message = 'Prior mutation committed but its response was not durably acknowledged',
           heartbeat_at_ms = ?, updated_at_ms = ?, revision = revision + 1
       WHERE namespace = ? AND command_id = ? AND generation = ? AND phase = 'COMMITTED'`,
      [
        authority.generation,
        now,
        now,
        authority.namespace,
        row.command_id,
        row.generation,
      ],
    );
    this.assertRecoveryUpdate(result.changes, row.command_id);
  }

  private assertRecoveryUpdate(changes: number, commandId: string): void {
    if (changes !== 1) {
      throw commandError(
        "SYNTHETIC_COMMAND_STORAGE_FAILURE",
        "Recovery did not update exactly one command record",
        { commandId, changes },
      );
    }
  }

  private assertExecution(
    row: CommandRow | null,
    executionToken: string,
    phase: SyntheticCommandPhase,
    commandId: string,
  ): asserts row is CommandRow {
    if (
      row === null ||
      row.execution_token !== executionToken ||
      row.phase !== phase
    ) {
      throw commandError(
        "SYNTHETIC_COMMAND_OWNERSHIP_LOST",
        "Command execution token or phase no longer owns the journal record",
        { commandId, expectedPhase: phase },
      );
    }
  }
}
