/**
 * Coordinates idempotent synthetic commands over a lease-fenced transaction
 * and a storage-neutral compare-and-set journal repository.
 */

import { createHash, randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core/errors";
import type {
  SyntheticEnvironmentLeaseAuthority,
  SyntheticEnvironmentLeaseStore,
} from "@elizaos/shared/contracts/synthetic-environment-lease";
import { isSyntheticEnvironmentNamespace } from "@elizaos/shared/contracts/synthetic-environment-lease";
import type {
  SyntheticCommandJournalExpected,
  SyntheticCommandJournalIdentity,
  SyntheticCommandJournalPatch,
  SyntheticCommandJournalRepository,
  SyntheticCommandJournalRow,
} from "./journal-repository";
import type {
  SyntheticCommandExecution,
  SyntheticCommandExecutionOptions,
  SyntheticCommandHeartbeat,
  SyntheticCommandPhase,
  SyntheticCommandRecord,
  SyntheticCommandRecovery,
  SyntheticJson,
  SyntheticWorldCommand,
} from "./types";
import { SYNTHETIC_WORLD_COMMAND_VERSION } from "./types";

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,127}$/;

function commandError(
  code: string,
  message: string,
  context?: SyntheticCommandJournalIdentity | Record<string, string | number>,
  cause?: unknown,
): ElizaError {
  return new ElizaError(message, {
    code,
    severity: "fatal",
    context: context === undefined ? undefined : { ...context },
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
    if (!Number.isFinite(value))
      throw invalidJson("JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw invalidJson(
      "JSON values cannot contain undefined, bigint, functions, or symbols",
    );
  }
  if (ancestors.has(value))
    throw invalidJson("JSON values cannot contain cycles");
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
  stringKeys.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
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

function parseJson(value: string, field: "payload" | "result"): SyntheticJson {
  try {
    const parsed: unknown = JSON.parse(value);
    if (serializeJson(parsed) !== value)
      throw new Error("stored JSON is not canonical");
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

function toRecord(row: SyntheticCommandJournalRow): SyntheticCommandRecord {
  return {
    version: SYNTHETIC_WORLD_COMMAND_VERSION,
    namespace: row.namespace,
    commandId: row.commandId,
    generation: row.generation,
    type: row.commandType,
    payloadHash: row.payloadHash,
    payload: parseJson(row.payloadJson, "payload"),
    phase: row.phase,
    outcome: row.outcome,
    result:
      row.resultJson === null ? null : parseJson(row.resultJson, "result"),
    error:
      row.errorCode === null || row.errorMessage === null
        ? null
        : { code: row.errorCode, message: row.errorMessage },
    executionToken: row.executionToken,
    createdAt: new Date(row.createdAtMs).toISOString(),
    heartbeatAt: new Date(row.heartbeatAtMs).toISOString(),
    updatedAt: new Date(row.updatedAtMs).toISOString(),
    revision: row.revision,
  };
}

function expected(
  row: SyntheticCommandJournalRow,
): SyntheticCommandJournalExpected {
  return {
    generation: row.generation,
    phase: row.phase,
    executionToken: row.executionToken,
    revision: row.revision,
  };
}

function identity(
  namespace: string,
  commandId: string,
): SyntheticCommandJournalIdentity {
  return { namespace, commandId };
}

interface ClaimResult {
  replay: SyntheticCommandJournalRow | null;
  executionToken: string | null;
}

/** Durable command engine shared by SQLite and production database adapters. */
export class LeaseFencedSyntheticCommandJournal<TContext> {
  constructor(
    private readonly leaseStore: SyntheticEnvironmentLeaseStore<TContext>,
    private readonly repository: SyntheticCommandJournalRepository<TContext>,
  ) {}

  async execute(
    authority: SyntheticEnvironmentLeaseAuthority,
    command: SyntheticWorldCommand,
    mutate: (context: TContext) => SyntheticJson | Promise<SyntheticJson>,
    options: SyntheticCommandExecutionOptions = {},
  ): Promise<SyntheticCommandExecution> {
    const { payloadJson, payloadHash } = validateCommand(authority, command);
    const executionToken = randomUUID();
    const claim = await this.leaseStore.withActiveGeneration(
      authority,
      async (context) => {
        await this.repository.initialize(context);
        const now = await this.repository.now(context);
        const rowIdentity = identity(command.namespace, command.commandId);
        const existing = await this.repository.find(context, rowIdentity);
        if (existing !== null) {
          this.assertSamePayload(existing, command, payloadHash);
          this.assertNotFuture(existing, authority);
          if (existing.phase === "SUCCEEDED" && existing.resultJson !== null) {
            return {
              replay: existing,
              executionToken: null,
            } satisfies ClaimResult;
          }
          if (existing.phase === "FAILED") {
            if (existing.errorCode === null || existing.errorMessage === null) {
              throw commandError(
                "SYNTHETIC_COMMAND_STORAGE_FAILURE",
                "Failed command is missing its stored error",
              );
            }
            throw commandError(
              existing.errorCode,
              existing.errorMessage,
              rowIdentity,
            );
          }
          if (existing.phase === "DIRTY") {
            throw commandError(
              "SYNTHETIC_COMMAND_DIRTY",
              "Command has an unknown outcome and cannot be replayed",
              rowIdentity,
            );
          }
          if (existing.executionToken !== null) {
            throw commandError(
              "SYNTHETIC_COMMAND_IN_PROGRESS",
              "Command is already owned by another execution",
              rowIdentity,
            );
          }
          const changes = await this.repository.compareAndSet(
            context,
            rowIdentity,
            expected(existing),
            {
              generation: authority.generation,
              executionToken,
              heartbeatAtMs: now,
              updatedAtMs: now,
              revision: existing.revision + 1,
            },
          );
          this.assertChanges(
            changes,
            "SYNTHETIC_COMMAND_OWNERSHIP_LOST",
            "Command ownership claim did not update exactly one record",
            rowIdentity,
          );
          return { replay: null, executionToken } satisfies ClaimResult;
        }
        const inserted = await this.repository.insert(context, {
          ...rowIdentity,
          generation: authority.generation,
          commandType: command.type,
          payloadHash,
          payloadJson,
          phase: "OWNED",
          outcome: "PENDING",
          resultJson: null,
          errorCode: null,
          errorMessage: null,
          executionToken,
          createdAtMs: now,
          heartbeatAtMs: now,
          updatedAtMs: now,
          revision: 1,
        });
        this.assertChanges(
          inserted,
          "SYNTHETIC_COMMAND_STORAGE_FAILURE",
          "Command creation did not insert exactly one record",
          rowIdentity,
        );
        return { replay: null, executionToken } satisfies ClaimResult;
      },
    );

    if (claim.value.replay !== null) {
      const resultJson = claim.value.replay.resultJson;
      if (resultJson === null) {
        throw commandError(
          "SYNTHETIC_COMMAND_STORAGE_FAILURE",
          "Succeeded command is missing its result",
        );
      }
      return {
        record: toRecord(claim.value.replay),
        result: parseJson(resultJson, "result"),
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
        async (context) => {
          await this.repository.initialize(context);
          const rowIdentity = identity(command.namespace, command.commandId);
          const row = await this.repository.find(context, rowIdentity);
          this.assertExecution(
            row,
            executionToken,
            "EXECUTING",
            command.commandId,
          );
          const mutationResult = await mutate(context);
          const resultJson = serializeJson(mutationResult);
          const changedAt = await this.repository.now(context);
          const changes = await this.repository.compareAndSet(
            context,
            rowIdentity,
            expected(row),
            {
              phase: "COMMITTED",
              resultJson,
              heartbeatAtMs: changedAt,
              updatedAtMs: changedAt,
              revision: row.revision + 1,
            },
          );
          this.assertChanges(
            changes,
            "SYNTHETIC_COMMAND_OWNERSHIP_LOST",
            "Command transition did not update exactly one record",
            rowIdentity,
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
          identity(command.namespace, command.commandId),
          { mutationError: error, classificationError },
        );
      }
      throw commandError(
        failureCode,
        failureMessage,
        identity(command.namespace, command.commandId),
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
      async (context) => {
        await this.repository.initialize(context);
        const rowIdentity = identity(
          input.authority.namespace,
          input.commandId,
        );
        const row = await this.repository.find(context, rowIdentity);
        if (
          row === null ||
          row.executionToken !== input.executionToken ||
          !(
            ["OWNED", "EXECUTING", "COMMITTED"] as SyntheticCommandPhase[]
          ).includes(row.phase)
        ) {
          throw commandError(
            "SYNTHETIC_COMMAND_OWNERSHIP_LOST",
            "Command heartbeat token is stale or the command is no longer active",
          );
        }
        const now = await this.repository.now(context);
        const changes = await this.repository.compareAndSet(
          context,
          rowIdentity,
          expected(row),
          {
            heartbeatAtMs: now,
            updatedAtMs: now,
            revision: row.revision + 1,
          },
        );
        this.assertChanges(
          changes,
          "SYNTHETIC_COMMAND_OWNERSHIP_LOST",
          "Command heartbeat token is stale or the command is no longer active",
          rowIdentity,
        );
        return toRecord(await this.requireRow(context, rowIdentity));
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
      async (context) => {
        await this.repository.initialize(context);
        const row = await this.repository.find(
          context,
          identity(authority.namespace, commandId),
        );
        if (row === null) return null;
        this.assertNotFuture(row, authority);
        return toRecord(row);
      },
    );
    return guarded.value;
  }

  async recover(
    authority: SyntheticEnvironmentLeaseAuthority,
  ): Promise<SyntheticCommandRecovery> {
    const guarded = await this.leaseStore.withActiveGeneration(
      authority,
      async (context) => {
        await this.repository.initialize(context);
        const rows = await this.repository.list(context, authority.namespace);
        rows.sort((left, right) =>
          left.commandId < right.commandId
            ? -1
            : left.commandId > right.commandId
              ? 1
              : 0,
        );
        const recovery: SyntheticCommandRecovery = {
          retryableCommandIds: [],
          failedCommandIds: [],
          dirtyCommandIds: [],
          activeCommandIds: [],
        };
        const now = await this.repository.now(context);
        for (const row of rows) {
          this.assertNotFuture(row, authority);
          if (["SUCCEEDED", "FAILED", "DIRTY"].includes(row.phase)) continue;
          if (row.generation === authority.generation) {
            recovery.activeCommandIds.push(row.commandId);
            continue;
          }
          let patch: SyntheticCommandJournalPatch;
          if (row.phase === "OWNED") {
            patch = {
              generation: authority.generation,
              executionToken: null,
              heartbeatAtMs: now,
              updatedAtMs: now,
              revision: row.revision + 1,
            };
            recovery.retryableCommandIds.push(row.commandId);
          } else if (row.phase === "EXECUTING") {
            patch = {
              generation: authority.generation,
              phase: "FAILED",
              outcome: "KNOWN_FAILURE",
              executionToken: null,
              errorCode: "SYNTHETIC_COMMAND_ABORTED_BEFORE_COMMIT",
              errorMessage:
                "Prior process stopped before its atomic mutation committed",
              heartbeatAtMs: now,
              updatedAtMs: now,
              revision: row.revision + 1,
            };
            recovery.failedCommandIds.push(row.commandId);
          } else {
            patch = {
              generation: authority.generation,
              phase: "DIRTY",
              outcome: "UNKNOWN",
              executionToken: null,
              errorCode: "SYNTHETIC_COMMAND_RECOVERED_AMBIGUOUS",
              errorMessage:
                "Prior mutation committed but its response was not durably acknowledged",
              heartbeatAtMs: now,
              updatedAtMs: now,
              revision: row.revision + 1,
            };
            recovery.dirtyCommandIds.push(row.commandId);
          }
          const changes = await this.repository.compareAndSet(
            context,
            identity(row.namespace, row.commandId),
            expected(row),
            patch,
          );
          this.assertChanges(
            changes,
            "SYNTHETIC_COMMAND_STORAGE_FAILURE",
            "Recovery did not update exactly one command record",
            { commandId: row.commandId },
          );
        }
        return recovery;
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
      async (context) => {
        await this.repository.initialize(context);
        const rowIdentity = identity(authority.namespace, commandId);
        const row = await this.repository.find(context, rowIdentity);
        this.assertExecution(row, executionToken, from, commandId);
        const now = await this.repository.now(context);
        const changes = await this.repository.compareAndSet(
          context,
          rowIdentity,
          expected(row),
          {
            phase: to,
            outcome: to === "SUCCEEDED" ? "KNOWN_SUCCESS" : "PENDING",
            executionToken: to === "SUCCEEDED" ? null : executionToken,
            heartbeatAtMs: now,
            updatedAtMs: now,
            revision: row.revision + 1,
          },
        );
        this.assertChanges(
          changes,
          "SYNTHETIC_COMMAND_OWNERSHIP_LOST",
          "Command transition did not update exactly one record",
          rowIdentity,
        );
        return toRecord(await this.requireRow(context, rowIdentity));
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
    await this.leaseStore.withActiveGeneration(authority, async (context) => {
      await this.repository.initialize(context);
      const rowIdentity = identity(authority.namespace, commandId);
      const row = await this.repository.find(context, rowIdentity);
      this.assertExecution(row, executionToken, "EXECUTING", commandId);
      const now = await this.repository.now(context);
      const changes = await this.repository.compareAndSet(
        context,
        rowIdentity,
        expected(row),
        {
          phase: "FAILED",
          outcome: "KNOWN_FAILURE",
          executionToken: null,
          errorCode,
          errorMessage,
          heartbeatAtMs: now,
          updatedAtMs: now,
          revision: row.revision + 1,
        },
      );
      this.assertChanges(
        changes,
        "SYNTHETIC_COMMAND_OWNERSHIP_LOST",
        "Failed command could not be durably classified",
        rowIdentity,
      );
    });
  }

  private async requireRow(
    context: TContext,
    rowIdentity: SyntheticCommandJournalIdentity,
  ): Promise<SyntheticCommandJournalRow> {
    const row = await this.repository.find(context, rowIdentity);
    if (row === null) {
      throw commandError(
        "SYNTHETIC_COMMAND_STORAGE_FAILURE",
        "Command record disappeared after an exact journal update",
        rowIdentity,
      );
    }
    return row;
  }

  private assertSamePayload(
    row: SyntheticCommandJournalRow,
    command: SyntheticWorldCommand,
    payloadHash: string,
  ): void {
    if (row.commandType !== command.type || row.payloadHash !== payloadHash) {
      throw commandError(
        "SYNTHETIC_COMMAND_ID_CONFLICT",
        "Command ID was already used with a different type or payload",
        identity(command.namespace, command.commandId),
      );
    }
  }

  private assertNotFuture(
    row: SyntheticCommandJournalRow,
    authority: SyntheticEnvironmentLeaseAuthority,
  ): void {
    if (row.generation > authority.generation) {
      throw commandError(
        "SYNTHETIC_COMMAND_STORAGE_FAILURE",
        "Command generation is newer than the active lease generation",
        {
          namespace: authority.namespace,
          commandId: row.commandId,
          commandGeneration: row.generation,
          authorityGeneration: authority.generation,
        },
      );
    }
  }

  private assertChanges(
    changes: number,
    code: string,
    message: string,
    context: SyntheticCommandJournalIdentity | Record<string, string | number>,
  ): void {
    if (changes !== 1)
      throw commandError(code, message, { ...context, changes });
  }

  private assertExecution(
    row: SyntheticCommandJournalRow | null,
    executionToken: string,
    phase: SyntheticCommandPhase,
    commandId: string,
  ): asserts row is SyntheticCommandJournalRow {
    if (
      row === null ||
      row.executionToken !== executionToken ||
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
