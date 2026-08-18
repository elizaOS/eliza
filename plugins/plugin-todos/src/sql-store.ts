/**
 * Canonical Postgres implementation of the tenant-scoped TodoStore contract.
 * Both Worker and container hosts inject their own Drizzle connection so all
 * persistence, hierarchy, and concurrency rules remain identical.
 */
import { ElizaError, type UUID, validateUuid } from "@elizaos/core/edge";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import {
  type TodoMutationRow,
  type TodoRow,
  todoMutationsTable,
  todosTable,
} from "./db/schema.js";
import {
  type CreateTodoInput,
  findDuplicateTodoId,
  isValidTodoListLimit,
  TODO_DUPLICATE_ID_ERROR_CODE,
  TODO_IDEMPOTENCY_CONFLICT_ERROR_CODE,
  TODO_INVALID_PARENT_ERROR_CODE,
  TODO_LIST_LIMIT_ERROR_CODE,
  TODO_PARENT_CYCLE_ERROR_CODE,
  TODO_SCOPE_CONVERGENCE_ERROR_CODE,
  type TodoCutoverState,
  type TodoFilter,
  type TodoMutation,
  type TodoMutationExecution,
  type TodoMutationImportInput,
  type TodoMutationImportResult,
  type TodoMutationInput,
  type TodoMutationRecord,
  type TodoMutationRecordWire,
  type TodoMutationResult,
  type TodoScope,
  type TodoScopeConvergenceInput,
  type TodoStore,
  type UpdateTodoInput,
  type WriteTodoListInput,
} from "./store.js";
import {
  TODO_STATUSES,
  TODOS_LOG_PREFIX,
  type Todo,
  type TodoStatus,
} from "./types.js";

interface TodoHierarchyRow {
  id: string;
  parentTodoId: string | null;
}

type TodoTransaction<TSchema extends Record<string, unknown>> = Parameters<
  Parameters<NodePgDatabase<TSchema>["transaction"]>[0]
>[0];

interface SerializedTodo {
  id: string;
  entityId: string;
  agentId: string;
  roomId: string | null;
  worldId: string | null;
  content: string;
  activeForm: string;
  status: TodoStatus;
  parentTodoId: string | null;
  parentTrajectoryStepId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

type SerializedTodoMutationResult =
  | { action: "create"; todo: SerializedTodo }
  | {
      action: "update" | "complete" | "cancel";
      todo: SerializedTodo | null;
    }
  | { action: "delete"; deleted: SerializedTodo | null }
  | {
      action: "write";
      before: SerializedTodo[];
      after: SerializedTodo[];
    }
  | { action: "clear"; count: number };

interface TodoMutationWire {
  version: 1;
  result: SerializedTodoMutationResult;
}

const TODO_MUTATION_RECORD_ERROR_CODE = "TODO_INVALID_MUTATION_RECORD";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new ElizaError(`${TODOS_LOG_PREFIX} invalid persisted ${field}`, {
    code: TODO_MUTATION_RECORD_ERROR_CODE,
    context: { field },
  });
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredString(value, field);
}

function persistedDate(value: unknown, field: string): Date {
  const parsed = new Date(requiredString(value, field));
  if (Number.isNaN(parsed.getTime())) {
    throw new ElizaError(`${TODOS_LOG_PREFIX} invalid persisted ${field}`, {
      code: TODO_MUTATION_RECORD_ERROR_CODE,
      context: { field },
    });
  }
  return parsed;
}

function serializeTodo(todo: Todo): SerializedTodo {
  return {
    ...todo,
    createdAt: todo.createdAt.toISOString(),
    updatedAt: todo.updatedAt.toISOString(),
    completedAt: todo.completedAt?.toISOString() ?? null,
  };
}

function deserializeTodo(value: unknown): Todo {
  const candidate = record(value);
  if (!candidate) {
    throw new ElizaError(`${TODOS_LOG_PREFIX} invalid persisted Todo`, {
      code: TODO_MUTATION_RECORD_ERROR_CODE,
    });
  }
  const status = requiredString(candidate.status, "todo.status");
  if (!(TODO_STATUSES as readonly string[]).includes(status)) {
    throw new ElizaError(`${TODOS_LOG_PREFIX} invalid persisted todo.status`, {
      code: TODO_MUTATION_RECORD_ERROR_CODE,
      context: { status },
    });
  }
  const metadata = record(candidate.metadata);
  if (!metadata) {
    throw new ElizaError(
      `${TODOS_LOG_PREFIX} invalid persisted todo.metadata`,
      {
        code: TODO_MUTATION_RECORD_ERROR_CODE,
      },
    );
  }
  return {
    id: requiredString(candidate.id, "todo.id"),
    entityId: requiredString(candidate.entityId, "todo.entityId"),
    agentId: requiredString(candidate.agentId, "todo.agentId"),
    roomId: nullableString(candidate.roomId, "todo.roomId"),
    worldId: nullableString(candidate.worldId, "todo.worldId"),
    content: requiredString(candidate.content, "todo.content"),
    activeForm: requiredString(candidate.activeForm, "todo.activeForm"),
    status: status as TodoStatus,
    parentTodoId: nullableString(candidate.parentTodoId, "todo.parentTodoId"),
    parentTrajectoryStepId: nullableString(
      candidate.parentTrajectoryStepId,
      "todo.parentTrajectoryStepId",
    ),
    metadata,
    createdAt: persistedDate(candidate.createdAt, "todo.createdAt"),
    updatedAt: persistedDate(candidate.updatedAt, "todo.updatedAt"),
    completedAt:
      candidate.completedAt === null
        ? null
        : persistedDate(candidate.completedAt, "todo.completedAt"),
  };
}

function serializeMutationResult(result: TodoMutationResult): TodoMutationWire {
  switch (result.action) {
    case "create":
      return {
        version: 1,
        result: { ...result, todo: serializeTodo(result.todo) },
      };
    case "update":
    case "complete":
    case "cancel":
      return {
        version: 1,
        result: {
          ...result,
          todo: result.todo ? serializeTodo(result.todo) : null,
        },
      };
    case "delete":
      return {
        version: 1,
        result: {
          ...result,
          deleted: result.deleted ? serializeTodo(result.deleted) : null,
        },
      };
    case "write":
      return {
        version: 1,
        result: {
          ...result,
          before: result.before.map(serializeTodo),
          after: result.after.map(serializeTodo),
        },
      };
    case "clear":
      return { version: 1, result };
  }
}

function deserializeTodoArray(value: unknown, field: string): Todo[] {
  if (!Array.isArray(value)) {
    throw new ElizaError(`${TODOS_LOG_PREFIX} invalid persisted ${field}`, {
      code: TODO_MUTATION_RECORD_ERROR_CODE,
      context: { field },
    });
  }
  return value.map(deserializeTodo);
}

function deserializeMutationResult(
  operation: TodoMutation["action"],
  value: unknown,
): TodoMutationResult {
  const wire = record(value);
  const result = record(wire?.result);
  if (wire?.version !== 1 || result?.action !== operation) {
    throw new ElizaError(
      `${TODOS_LOG_PREFIX} invalid persisted mutation result`,
      {
        code: TODO_MUTATION_RECORD_ERROR_CODE,
        context: { operation },
      },
    );
  }
  switch (operation) {
    case "create":
      return { action: operation, todo: deserializeTodo(result.todo) };
    case "update":
    case "complete":
    case "cancel":
      return {
        action: operation,
        todo: result.todo === null ? null : deserializeTodo(result.todo),
      };
    case "delete":
      return {
        action: operation,
        deleted:
          result.deleted === null ? null : deserializeTodo(result.deleted),
      };
    case "write":
      return {
        action: operation,
        before: deserializeTodoArray(result.before, "write.before"),
        after: deserializeTodoArray(result.after, "write.after"),
      };
    case "clear": {
      const count = result.count;
      if (
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count < 0
      ) {
        throw new ElizaError(
          `${TODOS_LOG_PREFIX} invalid persisted clear.count`,
          { code: TODO_MUTATION_RECORD_ERROR_CODE },
        );
      }
      return { action: operation, count };
    }
  }
}

function canonicalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ElizaError(
        `${TODOS_LOG_PREFIX} mutation contains non-finite number`,
        {
          code: TODO_MUTATION_RECORD_ERROR_CODE,
        },
      );
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  const candidate = record(value);
  if (!candidate) {
    throw new ElizaError(
      `${TODOS_LOG_PREFIX} mutation is not JSON-compatible`,
      {
        code: TODO_MUTATION_RECORD_ERROR_CODE,
      },
    );
  }
  return Object.fromEntries(
    Object.entries(candidate)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function semanticMutationRequest(mutation: TodoMutation): unknown {
  switch (mutation.action) {
    case "create":
      return {
        action: mutation.action,
        input: {
          content: mutation.input.content,
          activeForm: mutation.input.activeForm ?? mutation.input.content,
          status: mutation.input.status ?? "pending",
          parentTodoId: mutation.input.parentTodoId ?? null,
          metadata: mutation.input.metadata ?? {},
        },
      };
    case "write":
      return {
        action: mutation.action,
        todos: mutation.input.todos.map((todo) => ({
          ...todo,
          activeForm: todo.activeForm ?? todo.content,
        })),
      };
    case "clear":
      return { action: mutation.action };
    default:
      return mutation;
  }
}

async function mutationRequestDigest(mutation: TodoMutation): Promise<string> {
  return sha256(
    JSON.stringify({
      version: 1,
      mutation: canonicalize(semanticMutationRequest(mutation)),
    }),
  );
}

function mutationApplied(result: TodoMutationResult): boolean {
  switch (result.action) {
    case "create":
      return true;
    case "update":
    case "complete":
    case "cancel":
      return result.todo !== null;
    case "delete":
      return result.deleted !== null;
    case "write":
      return !sameTodoListState(result.before, result.after);
    case "clear":
      return result.count > 0;
  }
}

function sameTodoListState(before: Todo[], after: Todo[]): boolean {
  if (before.length !== after.length) return false;
  const beforeById = new Map(before.map((todo) => [todo.id, todo]));
  return after.every((todo) => {
    const previous = beforeById.get(todo.id);
    return (
      previous !== undefined &&
      previous.content === todo.content &&
      previous.activeForm === todo.activeForm &&
      previous.status === todo.status &&
      previous.parentTodoId === todo.parentTodoId &&
      previous.roomId === todo.roomId &&
      previous.worldId === todo.worldId
    );
  });
}

function mutationOperation(value: string): TodoMutation["action"] {
  if (
    value === "create" ||
    value === "update" ||
    value === "complete" ||
    value === "cancel" ||
    value === "delete" ||
    value === "write" ||
    value === "clear"
  ) {
    return value;
  }
  throw new ElizaError(`${TODOS_LOG_PREFIX} invalid persisted operation`, {
    code: TODO_MUTATION_RECORD_ERROR_CODE,
    context: { operation: value },
  });
}

/** Serialize one durable mutation record for Shared-to-Dedicated transfer. */
export function serializeTodoMutationRecord(
  record: TodoMutationRecord,
): TodoMutationRecordWire {
  return {
    version: 1,
    mutationId: record.mutationId,
    idempotencyKey: record.idempotencyKey,
    requestDigest: record.requestDigest,
    operation: record.operation,
    applied: record.applied,
    resultJson: serializeMutationResult(record.result),
    committedAt: record.committedAt.toISOString(),
  };
}

/** Validate and hydrate one transferred mutation record for a known scope. */
export function deserializeTodoMutationRecord(
  wireValue: unknown,
  scope: TodoScope,
): TodoMutationRecord {
  const wire = record(wireValue);
  if (wire?.version !== 1) {
    throw new ElizaError(`${TODOS_LOG_PREFIX} invalid mutation wire version`, {
      code: TODO_MUTATION_RECORD_ERROR_CODE,
    });
  }
  const mutationId = requiredString(wire.mutationId, "mutationId");
  if (validateUuid(mutationId) === null) {
    throw new ElizaError(`${TODOS_LOG_PREFIX} invalid mutationId`, {
      code: TODO_MUTATION_RECORD_ERROR_CODE,
    });
  }
  const requestDigest = requiredString(wire.requestDigest, "requestDigest");
  if (!/^[a-f0-9]{64}$/.test(requestDigest)) {
    throw new ElizaError(`${TODOS_LOG_PREFIX} invalid requestDigest`, {
      code: TODO_MUTATION_RECORD_ERROR_CODE,
    });
  }
  const operation = mutationOperation(
    requiredString(wire.operation, "operation"),
  );
  if (typeof wire.applied !== "boolean") {
    throw new ElizaError(`${TODOS_LOG_PREFIX} invalid applied flag`, {
      code: TODO_MUTATION_RECORD_ERROR_CODE,
    });
  }
  return {
    mutationId,
    scope,
    idempotencyKey: requiredString(wire.idempotencyKey, "idempotencyKey"),
    requestDigest,
    operation,
    applied: wire.applied,
    result: deserializeMutationResult(operation, wire.resultJson),
    committedAt: persistedDate(wire.committedAt, "committedAt"),
  };
}

function rowToMutationRecord(row: TodoMutationRow): TodoMutationRecord {
  return deserializeTodoMutationRecord(
    {
      version: 1,
      mutationId: row.mutationId,
      idempotencyKey: row.idempotencyKey,
      requestDigest: row.requestDigest,
      operation: row.operation,
      applied: row.applied,
      resultJson: row.resultJson,
      committedAt: row.committedAt.toISOString(),
    },
    { agentId: row.agentId, entityId: row.entityId },
  );
}

function remapNullableId(
  id: string | null,
  idMap: Readonly<Record<string, string | null>> | undefined,
): string | null {
  if (id === null || !idMap || !Object.hasOwn(idMap, id)) return id;
  return idMap[id] ?? null;
}

function remapNullableTodoId(
  id: string | null,
  idMap: Readonly<Record<string, string>> | undefined,
): string | null {
  return id === null ? null : (idMap?.[id] ?? id);
}

type TodoStateRemap = Pick<
  TodoMutationImportInput,
  "targetScope" | "todoIdMap" | "roomIdMap" | "worldIdMap"
>;

function remapTodo(todo: Todo, input: TodoStateRemap): Todo {
  return {
    ...todo,
    id: input.todoIdMap?.[todo.id] ?? todo.id,
    agentId: input.targetScope.agentId,
    entityId: input.targetScope.entityId,
    roomId: remapNullableId(todo.roomId, input.roomIdMap),
    worldId: remapNullableId(todo.worldId, input.worldIdMap),
    parentTodoId: remapNullableTodoId(todo.parentTodoId, input.todoIdMap),
  };
}

function remapMutationResult(
  result: TodoMutationResult,
  input: TodoStateRemap,
): TodoMutationResult {
  switch (result.action) {
    case "create":
      return { action: result.action, todo: remapTodo(result.todo, input) };
    case "update":
    case "complete":
    case "cancel":
      return {
        action: result.action,
        todo: result.todo ? remapTodo(result.todo, input) : null,
      };
    case "delete":
      return {
        action: result.action,
        deleted: result.deleted ? remapTodo(result.deleted, input) : null,
      };
    case "write":
      return {
        action: result.action,
        before: result.before.map((todo) => remapTodo(todo, input)),
        after: result.after.map((todo) => remapTodo(todo, input)),
      };
    case "clear":
      return result;
  }
}

function idempotencyConflict(
  scope: TodoScope,
  idempotencyKey: string,
): ElizaError {
  return new ElizaError(
    `${TODOS_LOG_PREFIX} idempotency key was reused for a different mutation`,
    {
      code: TODO_IDEMPOTENCY_CONFLICT_ERROR_CODE,
      context: { ...scope, idempotencyKey },
    },
  );
}

function assertValidIdempotencyKey(idempotencyKey: string): void {
  if (idempotencyKey.trim().length === 0 || idempotencyKey.length > 1024) {
    throw new ElizaError(`${TODOS_LOG_PREFIX} invalid idempotency key`, {
      code: TODO_MUTATION_RECORD_ERROR_CODE,
      context: { length: idempotencyKey.length },
    });
  }
}

async function lockTodoScope<TSchema extends Record<string, unknown>>(
  tx: TodoTransaction<TSchema>,
  scope: TodoScope,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${scopeLockKey(scope)}))`,
  );
}

async function lockTodoScopes<TSchema extends Record<string, unknown>>(
  tx: TodoTransaction<TSchema>,
  scopes: readonly TodoScope[],
): Promise<void> {
  const ordered = [
    ...new Map(scopes.map((scope) => [scopeLockKey(scope), scope])),
  ]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, scope]) => scope);
  for (const scope of ordered) await lockTodoScope(tx, scope);
}

function todoScopeConvergenceError(
  message: string,
  context: Record<string, unknown>,
): ElizaError {
  return new ElizaError(`${TODOS_LOG_PREFIX} ${message}`, {
    code: TODO_SCOPE_CONVERGENCE_ERROR_CODE,
    context,
  });
}

function todoMutationResultTodos(result: TodoMutationResult): Todo[] {
  switch (result.action) {
    case "create":
      return [result.todo];
    case "update":
    case "complete":
    case "cancel":
      return result.todo ? [result.todo] : [];
    case "delete":
      return result.deleted ? [result.deleted] : [];
    case "write":
      return [...result.before, ...result.after];
    case "clear":
      return [];
  }
}

function assertMutationResultScope(
  mutation: TodoMutationRecord,
  sourceScope: TodoScope,
): void {
  for (const todo of todoMutationResultTodos(mutation.result)) {
    if (
      todo.agentId !== sourceScope.agentId ||
      todo.entityId !== sourceScope.entityId
    ) {
      throw todoScopeConvergenceError(
        "mutation result is outside its persisted source scope",
        {
          mutationId: mutation.mutationId,
          todoId: todo.id,
          sourceAgentId: sourceScope.agentId,
          sourceEntityId: sourceScope.entityId,
          resultAgentId: todo.agentId,
          resultEntityId: todo.entityId,
        },
      );
    }
  }
}

/**
 * Atomically move Todo state and replay authority between two identity scopes.
 * The caller owns the surrounding identity transaction, so any validation or
 * remapping failure rolls both the storage move and identity merge back.
 */
export async function convergeTodoScopesInTransaction<
  TSchema extends Record<string, unknown>,
>(
  tx: TodoTransaction<TSchema>,
  input: TodoScopeConvergenceInput,
): Promise<void> {
  if (
    input.sourceScope.agentId === input.targetScope.agentId &&
    input.sourceScope.entityId === input.targetScope.entityId
  ) {
    throw todoScopeConvergenceError("source and target scopes are identical", {
      agentId: input.sourceScope.agentId,
      entityId: input.sourceScope.entityId,
    });
  }

  await lockTodoScopes(tx, [input.sourceScope, input.targetScope]);
  const sourceTodoRows = await tx
    .select()
    .from(todosTable)
    .where(
      and(
        eq(todosTable.agentId, input.sourceScope.agentId as UUID),
        eq(todosTable.entityId, input.sourceScope.entityId as UUID),
      ),
    )
    .orderBy(asc(todosTable.id));
  const sourceMutationRows = await tx
    .select()
    .from(todoMutationsTable)
    .where(
      and(
        eq(todoMutationsTable.agentId, input.sourceScope.agentId as UUID),
        eq(todoMutationsTable.entityId, input.sourceScope.entityId as UUID),
      ),
    )
    .orderBy(asc(todoMutationsTable.mutationId));
  if (sourceTodoRows.length === 0 && sourceMutationRows.length === 0) {
    return;
  }

  const sourceTodos = sourceTodoRows.map((row) => {
    if (
      !record(row.metadata) ||
      !(TODO_STATUSES as readonly string[]).includes(row.status)
    ) {
      throw todoScopeConvergenceError("source Todo row is invalid", {
        todoId: row.id,
      });
    }
    return rowToTodo(row);
  });
  assertTodoHierarchy(
    sourceTodos.map(({ id, parentTodoId }) => ({ id, parentTodoId })),
  );
  const targetHierarchy = await tx
    .select({ id: todosTable.id, parentTodoId: todosTable.parentTodoId })
    .from(todosTable)
    .where(
      and(
        eq(todosTable.agentId, input.targetScope.agentId as UUID),
        eq(todosTable.entityId, input.targetScope.entityId as UUID),
      ),
    );
  assertTodoHierarchy([
    ...targetHierarchy,
    ...sourceTodos.map(({ id, parentTodoId }) => ({ id, parentTodoId })),
  ]);

  const sourceMutations = sourceMutationRows.map(rowToMutationRecord);
  for (const mutation of sourceMutations) {
    assertMutationResultScope(mutation, input.sourceScope);
  }
  if (sourceMutations.length > 0) {
    const [conflict] = await tx
      .select({
        mutationId: todoMutationsTable.mutationId,
        idempotencyKey: todoMutationsTable.idempotencyKey,
      })
      .from(todoMutationsTable)
      .where(
        and(
          eq(todoMutationsTable.agentId, input.targetScope.agentId as UUID),
          eq(todoMutationsTable.entityId, input.targetScope.entityId as UUID),
          inArray(
            todoMutationsTable.idempotencyKey,
            sourceMutations.map((mutation) => mutation.idempotencyKey),
          ),
        ),
      )
      .orderBy(asc(todoMutationsTable.idempotencyKey))
      .limit(1);
    if (conflict) {
      throw idempotencyConflict(input.targetScope, conflict.idempotencyKey);
    }
  }

  const remapInput: TodoStateRemap = {
    targetScope: input.targetScope,
    ...(input.roomIdMap ? { roomIdMap: input.roomIdMap } : {}),
    ...(input.worldIdMap ? { worldIdMap: input.worldIdMap } : {}),
  };
  for (const todo of sourceTodos) {
    const remapped = remapTodo(todo, remapInput);
    const moved = await tx
      .update(todosTable)
      .set({
        agentId: input.targetScope.agentId as UUID,
        entityId: input.targetScope.entityId as UUID,
        roomId: remapped.roomId as UUID | null,
        worldId: remapped.worldId as UUID | null,
      })
      .where(
        and(
          eq(todosTable.id, todo.id as UUID),
          eq(todosTable.agentId, input.sourceScope.agentId as UUID),
          eq(todosTable.entityId, input.sourceScope.entityId as UUID),
        ),
      )
      .returning({ id: todosTable.id });
    if (moved.length !== 1) {
      throw todoScopeConvergenceError("Todo row changed during convergence", {
        todoId: todo.id,
      });
    }
  }
  for (const mutation of sourceMutations) {
    const moved = await tx
      .update(todoMutationsTable)
      .set({
        agentId: input.targetScope.agentId as UUID,
        entityId: input.targetScope.entityId as UUID,
        resultJson: serializeMutationResult(
          remapMutationResult(mutation.result, remapInput),
        ),
      })
      .where(
        and(
          eq(todoMutationsTable.mutationId, mutation.mutationId as UUID),
          eq(todoMutationsTable.agentId, input.sourceScope.agentId as UUID),
          eq(todoMutationsTable.entityId, input.sourceScope.entityId as UUID),
        ),
      )
      .returning({ mutationId: todoMutationsTable.mutationId });
    if (moved.length !== 1) {
      throw todoScopeConvergenceError(
        "mutation row changed during convergence",
        { mutationId: mutation.mutationId },
      );
    }
  }
}

/** Import mutation replay authority inside the caller's existing SQL transaction. */
export async function importTodoMutationRecordsInTransaction<
  TSchema extends Record<string, unknown>,
>(
  tx: TodoTransaction<TSchema>,
  input: TodoMutationImportInput,
): Promise<TodoMutationImportResult> {
  await lockTodoScope(tx, input.targetScope);
  let imported = 0;
  let skipped = 0;
  for (const source of input.records) {
    assertValidIdempotencyKey(source.idempotencyKey);
    if (source.result.action !== source.operation) {
      throw new ElizaError(
        `${TODOS_LOG_PREFIX} mutation result does not match its operation`,
        {
          code: TODO_MUTATION_RECORD_ERROR_CODE,
          context: { mutationId: source.mutationId },
        },
      );
    }
    const result = remapMutationResult(source.result, input);
    const resultJson = serializeMutationResult(result);
    const [existing] = await tx
      .select()
      .from(todoMutationsTable)
      .where(
        and(
          eq(todoMutationsTable.agentId, input.targetScope.agentId as UUID),
          eq(todoMutationsTable.entityId, input.targetScope.entityId as UUID),
          eq(todoMutationsTable.idempotencyKey, source.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing) {
      if (
        existing.mutationId !== source.mutationId ||
        existing.agentId !== input.targetScope.agentId ||
        existing.entityId !== input.targetScope.entityId ||
        existing.operation !== source.operation ||
        existing.requestDigest !== source.requestDigest ||
        existing.applied !== source.applied ||
        existing.committedAt.getTime() !== source.committedAt.getTime() ||
        JSON.stringify(canonicalize(existing.resultJson)) !==
          JSON.stringify(canonicalize(resultJson))
      ) {
        throw idempotencyConflict(input.targetScope, source.idempotencyKey);
      }
      skipped += 1;
      continue;
    }
    await tx.insert(todoMutationsTable).values({
      mutationId: source.mutationId as UUID,
      agentId: input.targetScope.agentId as UUID,
      entityId: input.targetScope.entityId as UUID,
      idempotencyKey: source.idempotencyKey,
      operation: source.operation,
      requestDigest: source.requestDigest,
      resultJson,
      applied: source.applied,
      committedAt: source.committedAt,
    });
    imported += 1;
  }
  return { imported, skipped };
}

function assertTodoHierarchy(rows: TodoHierarchyRow[]): void {
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    if (!row.parentTodoId) continue;
    if (!byId.has(row.parentTodoId)) {
      throw new ElizaError(
        `${TODOS_LOG_PREFIX} parent todo is outside the current agent/user scope`,
        {
          code: TODO_INVALID_PARENT_ERROR_CODE,
          context: { todoId: row.id, parentTodoId: row.parentTodoId },
        },
      );
    }
    const visited = new Set<string>([row.id]);
    let cursor: TodoHierarchyRow | undefined = row;
    while (cursor?.parentTodoId) {
      if (visited.has(cursor.parentTodoId)) {
        throw new ElizaError(
          `${TODOS_LOG_PREFIX} todo hierarchy contains a cycle`,
          {
            code: TODO_PARENT_CYCLE_ERROR_CODE,
            context: { todoId: row.id, parentTodoId: row.parentTodoId },
          },
        );
      }
      visited.add(cursor.parentTodoId);
      cursor = byId.get(cursor.parentTodoId);
    }
  }
}

function scopeLockKey(scope: TodoScope): string {
  return `todos:${scope.agentId}:${scope.entityId}`;
}

function rowToTodo(row: TodoRow): Todo {
  const metadata =
    row.metadata &&
    typeof row.metadata === "object" &&
    !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    entityId: row.entityId,
    agentId: row.agentId,
    roomId: row.roomId ?? null,
    worldId: row.worldId ?? null,
    content: row.content,
    activeForm: row.activeForm,
    status: row.status as TodoStatus,
    parentTodoId: row.parentTodoId ?? null,
    parentTrajectoryStepId: row.parentTrajectoryStepId ?? null,
    metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt ?? null,
  };
}

class SqlTodoStore<TSchema extends Record<string, unknown>>
  implements TodoStore
{
  constructor(private readonly db: NodePgDatabase<TSchema>) {}

  private async lockScope(
    tx: TodoTransaction<TSchema>,
    scope: TodoScope,
  ): Promise<void> {
    await lockTodoScope(tx, scope);
  }

  private async createInTransaction(
    tx: TodoTransaction<TSchema>,
    input: CreateTodoInput,
  ): Promise<Todo> {
    const hierarchy = await tx
      .select({ id: todosTable.id, parentTodoId: todosTable.parentTodoId })
      .from(todosTable)
      .where(
        and(
          eq(todosTable.agentId, input.agentId as UUID),
          eq(todosTable.entityId, input.entityId as UUID),
        ),
      );
    if (input.parentTodoId) {
      assertTodoHierarchy([
        ...hierarchy.map((row) => ({
          id: row.id,
          parentTodoId: row.parentTodoId,
        })),
        { id: "__new_todo__", parentTodoId: input.parentTodoId },
      ]);
    }
    const status = input.status ?? "pending";
    const [row] = await tx
      .insert(todosTable)
      .values({
        agentId: input.agentId as UUID,
        entityId: input.entityId as UUID,
        roomId: (input.roomId ?? null) as UUID | null,
        worldId: (input.worldId ?? null) as UUID | null,
        content: input.content,
        activeForm: input.activeForm ?? input.content,
        status,
        parentTodoId: (input.parentTodoId ?? null) as UUID | null,
        parentTrajectoryStepId: input.parentTrajectoryStepId ?? null,
        metadata: input.metadata ?? {},
        completedAt: status === "completed" ? new Date() : null,
      })
      .returning();
    if (!row) throw new Error(`${TODOS_LOG_PREFIX} insert returned no row`);
    return rowToTodo(row);
  }

  private async updateInTransaction(
    tx: TodoTransaction<TSchema>,
    scope: TodoScope,
    id: string,
    patch: UpdateTodoInput,
  ): Promise<Todo | null> {
    const hierarchy = await tx
      .select({
        id: todosTable.id,
        parentTodoId: todosTable.parentTodoId,
        status: todosTable.status,
      })
      .from(todosTable)
      .where(
        and(
          eq(todosTable.agentId, scope.agentId as UUID),
          eq(todosTable.entityId, scope.entityId as UUID),
        ),
      );
    const existing = hierarchy.find((row) => row.id === id);
    if (!existing) return null;
    if (patch.parentTodoId !== undefined) {
      assertTodoHierarchy(
        hierarchy.map((row) => ({
          id: row.id,
          parentTodoId:
            row.id === id ? (patch.parentTodoId ?? null) : row.parentTodoId,
        })),
      );
    }
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.content !== undefined) set.content = patch.content;
    if (patch.activeForm !== undefined) set.activeForm = patch.activeForm;
    if (patch.status !== undefined) {
      set.status = patch.status;
      if (patch.status === "completed" && existing.status !== "completed") {
        set.completedAt = new Date();
      } else if (patch.status !== "completed") {
        set.completedAt = null;
      }
    }
    if (patch.parentTodoId !== undefined) {
      set.parentTodoId = patch.parentTodoId;
    }
    if (patch.metadata !== undefined) set.metadata = patch.metadata;
    const [row] = await tx
      .update(todosTable)
      .set(set)
      .where(
        and(
          eq(todosTable.id, id as UUID),
          eq(todosTable.agentId, scope.agentId as UUID),
          eq(todosTable.entityId, scope.entityId as UUID),
        ),
      )
      .returning();
    return row ? rowToTodo(row) : null;
  }

  private async deleteInTransaction(
    tx: TodoTransaction<TSchema>,
    scope: TodoScope,
    id: string,
  ): Promise<Todo | null> {
    const [existing] = await tx
      .select()
      .from(todosTable)
      .where(
        and(
          eq(todosTable.id, id as UUID),
          eq(todosTable.agentId, scope.agentId as UUID),
          eq(todosTable.entityId, scope.entityId as UUID),
        ),
      )
      .limit(1);
    if (!existing) return null;
    await tx
      .update(todosTable)
      .set({ parentTodoId: null, updatedAt: new Date() })
      .where(
        and(
          eq(todosTable.agentId, scope.agentId as UUID),
          eq(todosTable.entityId, scope.entityId as UUID),
          eq(todosTable.parentTodoId, id as UUID),
        ),
      );
    const rows = await tx
      .delete(todosTable)
      .where(
        and(
          eq(todosTable.id, id as UUID),
          eq(todosTable.agentId, scope.agentId as UUID),
          eq(todosTable.entityId, scope.entityId as UUID),
        ),
      )
      .returning({ id: todosTable.id });
    if (rows.length !== 1) {
      throw new Error(`${TODOS_LOG_PREFIX} scoped delete returned no row`);
    }
    return rowToTodo(existing);
  }

  async create(input: CreateTodoInput): Promise<Todo> {
    return this.db.transaction(async (tx) => {
      const scope = { agentId: input.agentId, entityId: input.entityId };
      await this.lockScope(tx, scope);
      return this.createInTransaction(tx, input);
    });
  }

  async get(scope: TodoScope, id: string): Promise<Todo | null> {
    const [row] = await this.db
      .select()
      .from(todosTable)
      .where(
        and(
          eq(todosTable.id, id as UUID),
          eq(todosTable.agentId, scope.agentId as UUID),
          eq(todosTable.entityId, scope.entityId as UUID),
        ),
      )
      .limit(1);
    return row ? rowToTodo(row) : null;
  }

  async list(filter: TodoFilter): Promise<Todo[]> {
    let limit: number | undefined;
    if (Object.hasOwn(filter, "limit")) {
      const rawLimit = filter.limit;
      if (!isValidTodoListLimit(rawLimit)) {
        throw new ElizaError(
          `${TODOS_LOG_PREFIX} limit must be a positive safe integer`,
          {
            code: TODO_LIST_LIMIT_ERROR_CODE,
            context: { receivedType: typeof rawLimit },
          },
        );
      }
      limit = rawLimit;
    }

    const conditions = [
      eq(todosTable.entityId, filter.entityId as UUID),
      eq(todosTable.agentId, filter.agentId as UUID),
    ];
    if (filter.roomId !== undefined && filter.roomId !== null) {
      conditions.push(eq(todosTable.roomId, filter.roomId as UUID));
    }
    if (filter.status) {
      const statuses = Array.isArray(filter.status)
        ? filter.status
        : [filter.status];
      conditions.push(inArray(todosTable.status, statuses));
    } else if (filter.includeCompleted === false) {
      conditions.push(
        inArray(todosTable.status, ["pending", "in_progress"] as TodoStatus[]),
      );
    }

    const query = this.db
      .select()
      .from(todosTable)
      .where(and(...conditions))
      .orderBy(desc(todosTable.updatedAt));
    const rows = limit === undefined ? await query : await query.limit(limit);
    return rows.map(rowToTodo);
  }

  async update(
    scope: TodoScope,
    id: string,
    patch: UpdateTodoInput,
  ): Promise<Todo | null> {
    return this.db.transaction(async (tx) => {
      await this.lockScope(tx, scope);
      return this.updateInTransaction(tx, scope, id, patch);
    });
  }

  async delete(scope: TodoScope, id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await this.lockScope(tx, scope);
      return (await this.deleteInTransaction(tx, scope, id)) !== null;
    });
  }

  /**
   * Bulk-replace the user's entire todo list for a given (agentId, entityId)
   * scope. Mirrors Claude Code's TodoWrite contract: the caller passes the
   * full desired list, and the store reconciles. Existing rows are matched by
   * id; absent rows are deleted; new rows are inserted.
   *
   * The reconciled `before` set is keyed only on (agentId, entityId) — the same
   * cross-room scope every read path uses (the CURRENT_TODOS provider,
   * actionList, and list()), because todos persist across rooms for one user.
   * Narrowing `before` by roomId here would reconcile the planner's write
   * against a different set than it observed, re-creating todos it marked
   * complete in another room (duplicate) and resurrecting ones it omitted
   * (lost update). roomId/worldId are used only to seed newly created rows.
   */
  private async writeListInTransaction(
    tx: TodoTransaction<TSchema>,
    args: WriteTodoListInput,
  ): Promise<{ before: Todo[]; after: Todo[] }> {
    const duplicateId = findDuplicateTodoId(args.todos);
    if (duplicateId !== null) {
      throw new ElizaError(
        `${TODOS_LOG_PREFIX} todo list contains duplicate id`,
        {
          code: TODO_DUPLICATE_ID_ERROR_CODE,
          context: { todoId: duplicateId },
        },
      );
    }
    const beforeRows = await tx
      .select()
      .from(todosTable)
      .where(
        and(
          eq(todosTable.agentId, args.agentId as UUID),
          eq(todosTable.entityId, args.entityId as UUID),
        ),
      )
      .orderBy(desc(todosTable.updatedAt));
    const before = beforeRows.map(rowToTodo);
    const beforeById = new Map(before.map((todo) => [todo.id, todo]));
    const keepIds = new Set<string>();
    const after: Todo[] = [];

    for (const item of args.todos) {
      const existing = item.id ? beforeById.get(item.id) : undefined;
      if (existing) {
        keepIds.add(existing.id);
        const parentTodoId =
          item.parentTodoId === undefined
            ? existing.parentTodoId
            : item.parentTodoId;
        const needsUpdate =
          existing.content !== item.content ||
          existing.status !== item.status ||
          existing.activeForm !== (item.activeForm ?? item.content) ||
          existing.parentTodoId !== parentTodoId;
        if (!needsUpdate) {
          after.push(existing);
          continue;
        }
        const [updated] = await tx
          .update(todosTable)
          .set({
            content: item.content,
            activeForm: item.activeForm ?? item.content,
            status: item.status,
            ...(item.status !== existing.status
              ? {
                  completedAt: item.status === "completed" ? new Date() : null,
                }
              : {}),
            parentTodoId: parentTodoId as UUID | null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(todosTable.id, existing.id as UUID),
              eq(todosTable.agentId, args.agentId as UUID),
              eq(todosTable.entityId, args.entityId as UUID),
            ),
          )
          .returning();
        if (!updated) {
          throw new Error(`${TODOS_LOG_PREFIX} scoped update returned no row`);
        }
        after.push(rowToTodo(updated));
        continue;
      }

      const [created] = await tx
        .insert(todosTable)
        .values({
          entityId: args.entityId as UUID,
          agentId: args.agentId as UUID,
          roomId: args.roomId as UUID | null,
          worldId: args.worldId as UUID | null,
          content: item.content,
          activeForm: item.activeForm ?? item.content,
          status: item.status,
          parentTodoId: (item.parentTodoId ?? null) as UUID | null,
          parentTrajectoryStepId: args.parentTrajectoryStepId,
          completedAt: item.status === "completed" ? new Date() : null,
        })
        .returning();
      if (!created) {
        throw new Error(`${TODOS_LOG_PREFIX} scoped insert returned no row`);
      }
      keepIds.add(created.id);
      after.push(rowToTodo(created));
    }

    const toDelete = before
      .filter((todo) => !keepIds.has(todo.id))
      .map((todo) => todo.id as UUID);
    const deletedIds = new Set<string>(toDelete);
    const hierarchy = await tx
      .select({ id: todosTable.id, parentTodoId: todosTable.parentTodoId })
      .from(todosTable)
      .where(
        and(
          eq(todosTable.agentId, args.agentId as UUID),
          eq(todosTable.entityId, args.entityId as UUID),
        ),
      );
    assertTodoHierarchy(
      hierarchy
        .filter((todo) => !deletedIds.has(todo.id))
        .map((todo) => ({
          id: todo.id,
          parentTodoId:
            todo.parentTodoId && deletedIds.has(todo.parentTodoId)
              ? null
              : todo.parentTodoId,
        })),
    );
    if (toDelete.length > 0) {
      await tx
        .update(todosTable)
        .set({ parentTodoId: null, updatedAt: new Date() })
        .where(
          and(
            eq(todosTable.agentId, args.agentId as UUID),
            eq(todosTable.entityId, args.entityId as UUID),
            inArray(todosTable.parentTodoId, toDelete),
          ),
        );
      await tx
        .delete(todosTable)
        .where(
          and(
            eq(todosTable.agentId, args.agentId as UUID),
            eq(todosTable.entityId, args.entityId as UUID),
            inArray(todosTable.id, toDelete),
          ),
        );
    }
    if (after.length === 0) return { before, after };
    const finalRows = await tx
      .select()
      .from(todosTable)
      .where(
        and(
          eq(todosTable.agentId, args.agentId as UUID),
          eq(todosTable.entityId, args.entityId as UUID),
          inArray(
            todosTable.id,
            after.map((todo) => todo.id as UUID),
          ),
        ),
      );
    const finalById = new Map(
      finalRows.map((row) => {
        const todo = rowToTodo(row);
        return [todo.id, todo];
      }),
    );
    return {
      before,
      after: after.map((todo) => {
        const persisted = finalById.get(todo.id);
        if (!persisted) {
          throw new Error(`${TODOS_LOG_PREFIX} reconciled todo is missing`);
        }
        return persisted;
      }),
    };
  }

  async writeList(
    args: WriteTodoListInput,
  ): Promise<{ before: Todo[]; after: Todo[] }> {
    return this.db.transaction(async (tx) => {
      const scope = { agentId: args.agentId, entityId: args.entityId };
      await this.lockScope(tx, scope);
      return this.writeListInTransaction(tx, args);
    });
  }

  private async clearInTransaction(
    tx: TodoTransaction<TSchema>,
    filter: TodoScope & { roomId?: string | null },
  ): Promise<number> {
    const conditions = [
      eq(todosTable.entityId, filter.entityId as UUID),
      eq(todosTable.agentId, filter.agentId as UUID),
    ];
    if (filter.roomId !== undefined && filter.roomId !== null) {
      conditions.push(eq(todosTable.roomId, filter.roomId as UUID));
    }
    const targets = await tx
      .select({ id: todosTable.id })
      .from(todosTable)
      .where(and(...conditions));
    if (targets.length === 0) return 0;
    const targetIds = targets.map((target) => target.id);
    if (filter.roomId !== undefined && filter.roomId !== null) {
      await tx
        .update(todosTable)
        .set({ parentTodoId: null, updatedAt: new Date() })
        .where(
          and(
            eq(todosTable.agentId, filter.agentId as UUID),
            eq(todosTable.entityId, filter.entityId as UUID),
            inArray(todosTable.parentTodoId, targetIds),
          ),
        );
    }
    const rows = await tx
      .delete(todosTable)
      .where(
        and(
          eq(todosTable.agentId, filter.agentId as UUID),
          eq(todosTable.entityId, filter.entityId as UUID),
          inArray(todosTable.id, targetIds),
        ),
      )
      .returning({ id: todosTable.id });
    return rows.length;
  }

  async clear(filter: TodoScope & { roomId?: string | null }): Promise<number> {
    return this.db.transaction(async (tx) => {
      await this.lockScope(tx, filter);
      return this.clearInTransaction(tx, filter);
    });
  }

  async applyMutation(
    input: TodoMutationInput,
  ): Promise<TodoMutationExecution> {
    assertValidIdempotencyKey(input.idempotencyKey);
    const requestDigest = await mutationRequestDigest(input.mutation);
    return this.db.transaction(async (tx) => {
      await this.lockScope(tx, input.scope);
      const [existing] = await tx
        .select()
        .from(todoMutationsTable)
        .where(
          and(
            eq(todoMutationsTable.agentId, input.scope.agentId as UUID),
            eq(todoMutationsTable.entityId, input.scope.entityId as UUID),
            eq(todoMutationsTable.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (existing) {
        if (
          existing.operation !== input.mutation.action ||
          existing.requestDigest !== requestDigest
        ) {
          throw idempotencyConflict(input.scope, input.idempotencyKey);
        }
        const stored = rowToMutationRecord(existing);
        return {
          mutationId: stored.mutationId,
          idempotencyKey: stored.idempotencyKey,
          replayed: true,
          committedAt: stored.committedAt,
          applied: stored.applied,
          result: stored.result,
        };
      }

      let result: TodoMutationResult;
      switch (input.mutation.action) {
        case "create":
          result = {
            action: input.mutation.action,
            todo: await this.createInTransaction(tx, {
              ...input.mutation.input,
              ...input.scope,
            }),
          };
          break;
        case "update":
          result = {
            action: input.mutation.action,
            todo: await this.updateInTransaction(
              tx,
              input.scope,
              input.mutation.id,
              input.mutation.patch,
            ),
          };
          break;
        case "complete":
        case "cancel":
          result = {
            action: input.mutation.action,
            todo: await this.updateInTransaction(
              tx,
              input.scope,
              input.mutation.id,
              {
                status:
                  input.mutation.action === "complete"
                    ? "completed"
                    : "cancelled",
              },
            ),
          };
          break;
        case "delete":
          result = {
            action: input.mutation.action,
            deleted: await this.deleteInTransaction(
              tx,
              input.scope,
              input.mutation.id,
            ),
          };
          break;
        case "write": {
          const list = await this.writeListInTransaction(tx, {
            ...input.mutation.input,
            ...input.scope,
          });
          result = { action: input.mutation.action, ...list };
          break;
        }
        case "clear":
          result = {
            action: input.mutation.action,
            count: await this.clearInTransaction(tx, {
              ...input.scope,
              ...(input.mutation.roomId !== undefined
                ? { roomId: input.mutation.roomId }
                : {}),
            }),
          };
          break;
      }
      const applied = mutationApplied(result);
      const [inserted] = await tx
        .insert(todoMutationsTable)
        .values({
          agentId: input.scope.agentId as UUID,
          entityId: input.scope.entityId as UUID,
          idempotencyKey: input.idempotencyKey,
          operation: input.mutation.action,
          requestDigest,
          resultJson: serializeMutationResult(result),
          applied,
        })
        .returning();
      if (!inserted) {
        throw new Error(`${TODOS_LOG_PREFIX} mutation insert returned no row`);
      }
      return {
        mutationId: inserted.mutationId,
        idempotencyKey: inserted.idempotencyKey,
        replayed: false,
        committedAt: inserted.committedAt,
        applied: inserted.applied,
        result,
      };
    });
  }

  async listMutationRecords(scope: TodoScope): Promise<TodoMutationRecord[]> {
    const rows = await this.db
      .select()
      .from(todoMutationsTable)
      .where(
        and(
          eq(todoMutationsTable.agentId, scope.agentId as UUID),
          eq(todoMutationsTable.entityId, scope.entityId as UUID),
        ),
      )
      .orderBy(
        asc(todoMutationsTable.committedAt),
        asc(todoMutationsTable.mutationId),
      );
    return rows.map(rowToMutationRecord);
  }

  async readCutoverState(scope: TodoScope): Promise<TodoCutoverState> {
    return this.db.transaction(async (tx) => {
      await this.lockScope(tx, scope);
      const todoRows = await tx
        .select()
        .from(todosTable)
        .where(
          and(
            eq(todosTable.agentId, scope.agentId as UUID),
            eq(todosTable.entityId, scope.entityId as UUID),
          ),
        )
        .orderBy(asc(todosTable.createdAt), asc(todosTable.id));
      const mutationRows = await tx
        .select()
        .from(todoMutationsTable)
        .where(
          and(
            eq(todoMutationsTable.agentId, scope.agentId as UUID),
            eq(todoMutationsTable.entityId, scope.entityId as UUID),
          ),
        )
        .orderBy(
          asc(todoMutationsTable.committedAt),
          asc(todoMutationsTable.mutationId),
        );
      return {
        todos: todoRows.map(rowToTodo),
        mutations: mutationRows.map(rowToMutationRecord),
      };
    });
  }

  async importMutationRecords(
    input: TodoMutationImportInput,
  ): Promise<TodoMutationImportResult> {
    return this.db.transaction(async (tx) => {
      return importTodoMutationRecordsInTransaction(tx, input);
    });
  }
}

/** Build the canonical TodoStore over a Drizzle Postgres connection. */
export function createTodosSqlStore<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>,
): TodoStore {
  return new SqlTodoStore(db);
}

export {
  type CreateTodoInput,
  findDuplicateTodoId,
  isValidTodoListLimit,
  TODO_DUPLICATE_ID_ERROR_CODE,
  TODO_IDEMPOTENCY_CONFLICT_ERROR_CODE,
  TODO_INVALID_PARENT_ERROR_CODE,
  TODO_LIST_LIMIT_ERROR_CODE,
  TODO_PARENT_CYCLE_ERROR_CODE,
  TODO_SCOPE_CONVERGENCE_ERROR_CODE,
  type TodoCutoverState,
  type TodoFilter,
  type TodoMutation,
  type TodoMutationExecution,
  type TodoMutationImportInput,
  type TodoMutationImportResult,
  type TodoMutationInput,
  type TodoMutationRecord,
  type TodoMutationResult,
  type TodoScope,
  type TodoScopeConvergenceInput,
  type TodoStore,
  type UpdateTodoInput,
  type WriteTodoListInput,
} from "./store.js";
