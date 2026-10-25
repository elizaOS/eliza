/** Local dev recovery uses exact-child-exit authority supplied by the host. */
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import {
  type DevTrajectoryRecoveryOwner,
  type DevTrajectoryRecoveryStorageScope,
  parseDevTrajectoryRecoveryOwner,
  parseDevTrajectoryRecoveryParentMessage,
  sameDevTrajectoryRecoveryOwner,
  sameDevTrajectoryRecoveryScope,
} from "./dev-trajectory-recovery-protocol.ts";
import {
  asRecord,
  ensureTrajectoriesTable,
  executeRawSql,
  extractRequiredRows,
  parsePersistedMetadata,
  resolveTrajectoryLogger,
  sqlQuote,
} from "./trajectory-internals.ts";

export interface DevTrajectoryRecoveryRegistration {
  owner: DevTrajectoryRecoveryOwner;
  recoveryBatchId: string;
  owners: DevTrajectoryRecoveryOwner[];
}

export interface DevTrajectoryRecoveryTransport {
  registerOwner(
    owner: DevTrajectoryRecoveryOwner,
  ): Promise<DevTrajectoryRecoveryRegistration>;
  acknowledgeRecovery(recoveryBatchId: string): Promise<void>;
}

export type DevTrajectoryRecoveryPreparation =
  | "prepared"
  | "unsupported-storage";

interface ExecutionState {
  token: string;
  preparation: Promise<DevTrajectoryRecoveryPreparation>;
  adapter?: object;
  owner?: DevTrajectoryRecoveryOwner;
}

// Never exported through environment, settings, metadata supplied by callers,
// or an inherited process-global token. Each actual runtime gets its own owner.
const executionStates = new WeakMap<object, ExecutionState>();
const RECOVERY_PAGE_SIZE = 200;

function recoveryError(message: string): ElizaError {
  return new ElizaError(message, { code: "DEV_TRAJECTORY_RECOVERY_REJECTED" });
}

function runtimeAdapter(runtime: IAgentRuntime): Record<string, unknown> {
  const adapter = asRecord(
    (runtime as unknown as { adapter?: unknown }).adapter,
  );
  if (!adapter)
    throw recoveryError(
      "Dev trajectory recovery requires an initialized database adapter",
    );
  return adapter;
}

async function storageScope(
  runtime: IAgentRuntime,
  expectedAdapter: object,
): Promise<DevTrajectoryRecoveryStorageScope> {
  const adapter = runtimeAdapter(runtime);
  if (
    adapter !== expectedAdapter ||
    typeof adapter.getPgliteDataDir !== "function" ||
    typeof adapter.getConnection !== "function"
  ) {
    throw recoveryError(
      "Dev trajectory recovery requires the same file-backed PGlite adapter",
    );
  }
  // This initializes the actual manager rather than guessing from mutable env.
  await adapter.getConnection.call(adapter);
  const directory: unknown = adapter.getPgliteDataDir.call(adapter);
  if (
    typeof directory !== "string" ||
    !directory.trim() ||
    directory === ":memory:" ||
    directory.includes("://")
  ) {
    throw recoveryError(
      "Dev trajectory recovery requires persistent local PGlite storage",
    );
  }
  const realPath = await realpath(resolve(directory));
  const identity = await stat(realPath, { bigint: true });
  if (!identity.isDirectory())
    throw recoveryError("PGlite storage is not a directory");
  return {
    kind: "pglite",
    realPath,
    device: identity.dev.toString(),
    inode: identity.ino.toString(),
  };
}

async function assertScope(
  runtime: IAgentRuntime,
  state: ExecutionState,
): Promise<DevTrajectoryRecoveryOwner> {
  const owner = state.owner;
  if (!owner || !state.adapter)
    throw recoveryError("Dev trajectory execution registration is incomplete");
  const current: DevTrajectoryRecoveryOwner = {
    ...owner,
    agentId: runtime.agentId,
    runtimeInstanceId: runtime.runtimeInstanceId,
    storageScope: await storageScope(runtime, state.adapter),
  };
  if (!sameDevTrajectoryRecoveryOwner(owner, current))
    throw recoveryError(
      "Dev trajectory recovery storage or runtime scope changed",
    );
  return owner;
}

/** Internal bridge admission gate; ordinary unsupervised runtimes stay unchanged. */
export async function getDevTrajectoryExecutionOwnerId(
  runtime: IAgentRuntime,
): Promise<string | undefined> {
  const state = executionStates.get(runtime as object);
  if (!state) return undefined;
  if ((await state.preparation) === "unsupported-storage") return undefined;
  if (
    !state.owner ||
    runtimeAdapter(runtime) !== state.adapter ||
    runtime.agentId !== state.owner.agentId ||
    runtime.runtimeInstanceId !== state.owner.runtimeInstanceId
  ) {
    throw recoveryError(
      "Dev trajectory execution changed its registered runtime or adapter",
    );
  }
  return state.token;
}

/**
 * Called by the supervised dev host before publishing its replacement runtime.
 * The transport must offer only owners whose exact ChildProcess has exited.
 * Failure keeps this runtime fenced; the host disposes it before a fresh boot.
 */
export function prepareDevTrajectoryRecovery(
  runtime: IAgentRuntime,
  transport: DevTrajectoryRecoveryTransport,
): Promise<DevTrajectoryRecoveryPreparation> {
  const existing = executionStates.get(runtime as object);
  if (existing) return existing.preparation;
  const state: ExecutionState = {
    token: randomUUID(),
    preparation: Promise.resolve("unsupported-storage"),
  };
  executionStates.set(runtime as object, state);
  state.preparation = prepare(runtime, state, transport);
  return state.preparation;
}

async function prepare(
  runtime: IAgentRuntime,
  state: ExecutionState,
  transport: DevTrajectoryRecoveryTransport,
): Promise<DevTrajectoryRecoveryPreparation> {
  const adapter = asRecord(
    (runtime as unknown as { adapter?: unknown }).adapter,
  );
  if (!adapter || typeof adapter.getPgliteDataDir !== "function")
    return "unsupported-storage";
  const directory: unknown = adapter.getPgliteDataDir.call(adapter);
  if (
    directory === null ||
    directory === undefined ||
    directory === "" ||
    directory === ":memory:" ||
    (typeof directory === "string" && directory.includes("://"))
  )
    return "unsupported-storage";
  // Once a persistent PGlite path is known, initialization or scope proof errors
  // are failures, never an excuse to publish an unprotected replacement.
  state.adapter = adapter;
  const candidate: DevTrajectoryRecoveryOwner = {
    agentId: runtime.agentId,
    runtimeInstanceId: runtime.runtimeInstanceId,
    runtimeExecutionOwnerId: state.token,
    storageScope: await storageScope(runtime, state.adapter),
  };
  const owner = parseDevTrajectoryRecoveryOwner(candidate);
  if (!owner)
    throw recoveryError("Dev trajectory execution identity is invalid");
  state.owner = Object.freeze({
    ...owner,
    storageScope: Object.freeze(owner.storageScope),
  });
  const logger = await resolveTrajectoryLogger(runtime);
  if (!(await ensureTrajectoriesTable(runtime)) || !logger) {
    throw recoveryError(
      "Dev trajectory recovery requires the database trajectory logger",
    );
  }
  // Dynamic import keeps the normal storage -> admission dependency acyclic.
  const {
    installDatabaseTrajectoryLogger,
    DatabaseTrajectoryLogger,
    settleExitedTrajectoryForDevRecovery,
  } = await import("./trajectory-storage.ts");
  if (!(logger instanceof DatabaseTrajectoryLogger))
    await installDatabaseTrajectoryLogger(runtime);
  const result = await transport.registerOwner({
    ...owner,
    storageScope: { ...owner.storageScope },
  });
  const registration = parseDevTrajectoryRecoveryParentMessage({
    ...result,
    type: "eliza:trajectory-recovery:registered",
    version: 1,
    requestId: "prepare",
  });
  if (
    registration?.type !== "eliza:trajectory-recovery:registered" ||
    !sameDevTrajectoryRecoveryOwner(owner, registration.owner)
  ) {
    throw recoveryError(
      "Supervisor did not acknowledge this trajectory execution owner",
    );
  }
  for (const deadOwner of registration.owners) {
    if (
      !sameDevTrajectoryRecoveryScope(owner, deadOwner) ||
      deadOwner.runtimeExecutionOwnerId === owner.runtimeExecutionOwnerId
    ) {
      throw recoveryError(
        "Supervisor offered a different or current trajectory execution scope",
      );
    }
  }
  await assertScope(runtime, state);
  for (const deadOwner of registration.owners) {
    let afterId: string | undefined;
    // An exact execution-owner filter is the recovery authority. No timestamps,
    // PID checks, history sweep, prompt replay, or user-content mutation.
    while (true) {
      await assertScope(runtime, state);
      const result = await executeRawSql(
        runtime,
        `SELECT id, metadata_json FROM trajectories
         WHERE agent_id = ${sqlQuote(deadOwner.agentId)} AND status = 'active'
         AND metadata_json::jsonb ->> 'runtimeInstanceId' = ${sqlQuote(deadOwner.runtimeInstanceId)}
         AND metadata_json::jsonb ->> 'runtimeExecutionOwnerId' = ${sqlQuote(deadOwner.runtimeExecutionOwnerId)}
         ${afterId === undefined ? "" : `AND id > ${sqlQuote(afterId)}`}
         ORDER BY id LIMIT ${RECOVERY_PAGE_SIZE}`,
      );
      const rows = extractRequiredRows(result, {
        operation: "recover exited trajectory execution",
      });
      if (rows.length === 0) break;
      if (rows.length > RECOVERY_PAGE_SIZE)
        throw recoveryError("Trajectory recovery page exceeds its bound");
      const previousCursor = afterId;
      for (const value of rows) {
        const row = asRecord(value);
        if (typeof row?.id !== "string" || !row.id)
          throw recoveryError("Trajectory recovery candidate is invalid");
        afterId = row.id;
        const metadata = parsePersistedMetadata(row.metadata_json, row.id);
        const rowToken = metadata.runtimeTrajectoryOwnerId;
        if (
          typeof rowToken !== "string" ||
          !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
            rowToken,
          )
        )
          throw recoveryError(
            "Owned recovery candidate has no valid row ownership token",
          );
        await settleExitedTrajectoryForDevRecovery(
          runtime,
          row.id,
          rowToken,
          deadOwner.runtimeExecutionOwnerId,
        );
      }
      if (afterId === previousCursor)
        throw recoveryError("Trajectory recovery page did not advance");
      if (rows.length < RECOVERY_PAGE_SIZE) break;
    }
  }
  await assertScope(runtime, state);
  // The supervisor keeps this batch if recovery or its acknowledgement fails;
  // an ensuing replacement safely retries the same already-terminal rows.
  await transport.acknowledgeRecovery(registration.recoveryBatchId);
  return "prepared";
}
