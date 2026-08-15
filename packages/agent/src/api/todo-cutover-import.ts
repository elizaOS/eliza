/**
 * Transactional Shared Todo importer for a Dedicated agent's local database.
 * It writes only the plugin-todos schema, preserves target-native rows, and
 * verifies the materialized snapshot before the Cloud cutover may route users
 * away from Shared.
 */

import {
  type AgentRuntime,
  ElizaError,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import type { TodoInsert, TodoRow } from "@elizaos/plugin-todos/db/schema";
import {
  createSharedTodoCutoverSnapshot,
  type SharedTodoCutoverRecord,
  type SharedTodoCutoverSnapshot,
  TODO_CUTOVER_PROVENANCE_KEY,
  type TodoCutoverJsonValue,
} from "@elizaos/shared/todo-cutover";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

const TODO_IMPORT_PROVENANCE_VERSION = 1 as const;

interface TodoImportProvenance {
  [key: string]: TodoCutoverJsonValue;
  version: typeof TODO_IMPORT_PROVENANCE_VERSION;
  sourceAgentId: string;
  sourceTodoId: string;
  sourceRoomId: string | null;
  sourceWorldId: string | null;
  cutoverToken: string;
}

type DesiredTodoRow = TodoInsert & {
  id: UUID;
  agentId: UUID;
  entityId: UUID;
  roomId: UUID;
  worldId: null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

interface MaterializedSourceRecord {
  sourceId: string;
  roomId: string | null;
  worldId: string | null;
  content: string;
  activeForm: string;
  status: string;
  parentSourceId: string | null;
  parentTrajectoryStepId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface SharedTodoImportReceipt {
  sourceTodoCount: number;
  importedTodos: number;
  repairedTodos: number;
  skippedTodos: number;
  removedStaleTodos: number;
  sourceTodoDigest: string;
  targetTodoDigest: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTodoDatabase(
  value: unknown,
): value is NodePgDatabase<Record<string, unknown>> {
  return isRecord(value) && typeof value.transaction === "function";
}

function readProvenance(metadata: unknown): TodoImportProvenance | null {
  if (!isRecord(metadata)) return null;
  const raw = metadata[TODO_CUTOVER_PROVENANCE_KEY];
  if (raw === undefined) return null;
  if (
    !isRecord(raw) ||
    raw.version !== TODO_IMPORT_PROVENANCE_VERSION ||
    typeof raw.sourceAgentId !== "string" ||
    typeof raw.sourceTodoId !== "string" ||
    (raw.sourceRoomId !== null && typeof raw.sourceRoomId !== "string") ||
    (raw.sourceWorldId !== null && typeof raw.sourceWorldId !== "string") ||
    typeof raw.cutoverToken !== "string"
  ) {
    throw new ElizaError("Dedicated Todo import provenance is malformed", {
      code: "TODO_CUTOVER_PROVENANCE_INVALID",
    });
  }
  return {
    version: TODO_IMPORT_PROVENANCE_VERSION,
    sourceAgentId: raw.sourceAgentId,
    sourceTodoId: raw.sourceTodoId,
    sourceRoomId: raw.sourceRoomId,
    sourceWorldId: raw.sourceWorldId,
    cutoverToken: raw.cutoverToken,
  };
}

function targetTodoId(
  targetAgentId: UUID,
  targetEntityId: UUID,
  sourceAgentId: string,
  sourceTodoId: string,
): UUID {
  return stringToUuid(
    `shared-todo-cutover:${targetAgentId}:${targetEntityId}:${sourceAgentId}:${sourceTodoId}`,
  );
}

function provenanceFor(
  snapshot: SharedTodoCutoverSnapshot,
  todo: SharedTodoCutoverRecord,
  cutoverToken: string,
): TodoImportProvenance {
  return {
    version: TODO_IMPORT_PROVENANCE_VERSION,
    sourceAgentId: snapshot.sourceAgentId,
    sourceTodoId: todo.sourceId,
    sourceRoomId: todo.roomId,
    sourceWorldId: todo.worldId,
    cutoverToken,
  };
}

function metadataFor(
  snapshot: SharedTodoCutoverSnapshot,
  todo: SharedTodoCutoverRecord,
  cutoverToken: string,
): Record<string, TodoCutoverJsonValue> {
  return {
    ...todo.metadata,
    [TODO_CUTOVER_PROVENANCE_KEY]: provenanceFor(snapshot, todo, cutoverToken),
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

function sameTimestamp(left: Date | null, right: Date | null): boolean {
  return left?.getTime() === right?.getTime();
}

function rowMatches(row: TodoRow, desired: DesiredTodoRow): boolean {
  return (
    row.agentId === desired.agentId &&
    row.entityId === desired.entityId &&
    row.roomId === desired.roomId &&
    row.worldId === desired.worldId &&
    row.content === desired.content &&
    row.activeForm === desired.activeForm &&
    row.status === desired.status &&
    row.parentTodoId === desired.parentTodoId &&
    row.parentTrajectoryStepId === desired.parentTrajectoryStepId &&
    stableJson(row.metadata) === stableJson(desired.metadata) &&
    sameTimestamp(row.createdAt, desired.createdAt) &&
    sameTimestamp(row.updatedAt, desired.updatedAt) &&
    sameTimestamp(row.completedAt, desired.completedAt)
  );
}

function sourceRecordFromRow(row: TodoRow): MaterializedSourceRecord {
  const metadata = isRecord(row.metadata) ? { ...row.metadata } : {};
  const provenance = readProvenance(metadata);
  if (!provenance) {
    throw new ElizaError("Dedicated Todo import row is missing provenance", {
      code: "TODO_CUTOVER_PROVENANCE_MISSING",
      context: { todoId: row.id },
    });
  }
  delete metadata[TODO_CUTOVER_PROVENANCE_KEY];
  return {
    sourceId: provenance.sourceTodoId,
    roomId: provenance.sourceRoomId,
    worldId: provenance.sourceWorldId,
    content: row.content,
    activeForm: row.activeForm,
    status: row.status,
    parentSourceId: null,
    parentTrajectoryStepId: row.parentTrajectoryStepId,
    metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function materializeSourceRecords(
  rows: readonly TodoRow[],
): MaterializedSourceRecord[] {
  const sourceIdByTargetId = new Map<string, string>();
  for (const row of rows) {
    const provenance = readProvenance(row.metadata);
    if (!provenance) {
      throw new ElizaError("Dedicated Todo import row is missing provenance", {
        code: "TODO_CUTOVER_PROVENANCE_MISSING",
        context: { todoId: row.id },
      });
    }
    sourceIdByTargetId.set(row.id, provenance.sourceTodoId);
  }
  return rows.map((row) => {
    const record = sourceRecordFromRow(row);
    record.parentSourceId = row.parentTodoId
      ? (sourceIdByTargetId.get(row.parentTodoId) ?? null)
      : null;
    if (row.parentTodoId && !record.parentSourceId) {
      throw new ElizaError("Dedicated Todo import parent remap is incomplete", {
        code: "TODO_CUTOVER_PARENT_REMAP_INCOMPLETE",
        context: { todoId: row.id, parentTodoId: row.parentTodoId },
      });
    }
    return record;
  });
}

/**
 * Reconciles one verified snapshot under the same per-user advisory lock used
 * by plugin-todos CRUD. The transaction either leaves an exact digest-matching
 * imported set or rolls back without affecting the Shared route authority.
 */
export async function importSharedTodoCutover(input: {
  runtime: AgentRuntime;
  entityId: UUID;
  targetRoomId: UUID;
  cutoverToken: string;
  snapshot: SharedTodoCutoverSnapshot;
}): Promise<SharedTodoImportReceipt> {
  const db = input.runtime.db;
  if (!isTodoDatabase(db)) {
    throw new ElizaError(
      "Dedicated Todo import requires the local @elizaos/plugin-sql database",
      { code: "TODO_CUTOVER_DATABASE_UNAVAILABLE" },
    );
  }
  const { todosTable } = await import("@elizaos/plugin-todos/db/schema");
  const targetIds = new Map(
    input.snapshot.todos.map((todo) => [
      todo.sourceId,
      targetTodoId(
        input.runtime.agentId,
        input.entityId,
        input.snapshot.sourceAgentId,
        todo.sourceId,
      ),
    ]),
  );
  const sourceIdByTargetId = new Map(
    Array.from(targetIds, ([sourceId, targetId]) => [targetId, sourceId]),
  );
  const desiredRows = input.snapshot.todos.map((todo): DesiredTodoRow => {
    const id = targetIds.get(todo.sourceId);
    if (!id) {
      throw new ElizaError("Dedicated Todo import id mapping is incomplete", {
        code: "TODO_CUTOVER_ID_MAPPING_INCOMPLETE",
        context: { sourceTodoId: todo.sourceId },
      });
    }
    const parentTodoId = todo.parentSourceId
      ? targetIds.get(todo.parentSourceId)
      : null;
    if (todo.parentSourceId && !parentTodoId) {
      throw new ElizaError(
        "Dedicated Todo import parent id mapping is incomplete",
        {
          code: "TODO_CUTOVER_PARENT_MAPPING_INCOMPLETE",
          context: {
            sourceTodoId: todo.sourceId,
            parentSourceTodoId: todo.parentSourceId,
          },
        },
      );
    }
    return {
      id,
      agentId: input.runtime.agentId,
      entityId: input.entityId,
      roomId: input.targetRoomId,
      worldId: null,
      content: todo.content,
      activeForm: todo.activeForm,
      status: todo.status,
      parentTodoId,
      parentTrajectoryStepId: todo.parentTrajectoryStepId,
      metadata: metadataFor(input.snapshot, todo, input.cutoverToken),
      createdAt: new Date(todo.createdAt),
      updatedAt: new Date(todo.updatedAt),
      completedAt: todo.completedAt ? new Date(todo.completedAt) : null,
    };
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`todos:${input.runtime.agentId}:${input.entityId}`}))`,
    );
    const existingRows = await tx
      .select()
      .from(todosTable)
      .where(
        and(
          eq(todosTable.agentId, input.runtime.agentId),
          eq(todosTable.entityId, input.entityId),
        ),
      );
    const existingById = new Map(existingRows.map((row) => [row.id, row]));
    const desiredIds = new Set(desiredRows.map((row) => row.id));
    const staleIds: UUID[] = [];
    for (const row of existingRows) {
      const provenance = readProvenance(row.metadata);
      if (
        provenance?.sourceAgentId === input.snapshot.sourceAgentId &&
        !desiredIds.has(row.id)
      ) {
        staleIds.push(row.id);
      }
    }

    let importedTodos = 0;
    let repairedTodos = 0;
    let skippedTodos = 0;
    const rowsToWrite: DesiredTodoRow[] = [];
    for (const desired of desiredRows) {
      const existing = existingById.get(desired.id);
      if (!existing) {
        importedTodos += 1;
        rowsToWrite.push(desired);
        continue;
      }
      const provenance = readProvenance(existing.metadata);
      if (
        !provenance ||
        provenance.sourceAgentId !== input.snapshot.sourceAgentId ||
        provenance.sourceTodoId !== sourceIdByTargetId.get(desired.id)
      ) {
        throw new ElizaError(
          "Dedicated native Todo collides with a deterministic import id",
          {
            code: "TODO_CUTOVER_NATIVE_ID_COLLISION",
            context: { todoId: desired.id },
          },
        );
      }
      if (rowMatches(existing, desired)) {
        skippedTodos += 1;
      } else {
        repairedTodos += 1;
        rowsToWrite.push(desired);
      }
    }

    if (rowsToWrite.length > 0) {
      await tx
        .insert(todosTable)
        .values(rowsToWrite)
        .onConflictDoUpdate({
          target: todosTable.id,
          set: {
            agentId: sql`excluded.agent_id`,
            entityId: sql`excluded.entity_id`,
            roomId: sql`excluded.room_id`,
            worldId: sql`excluded.world_id`,
            content: sql`excluded.content`,
            activeForm: sql`excluded.active_form`,
            status: sql`excluded.status`,
            parentTodoId: sql`excluded.parent_todo_id`,
            parentTrajectoryStepId: sql`excluded.parent_trajectory_step_id`,
            metadata: sql`excluded.metadata`,
            createdAt: sql`excluded.created_at`,
            updatedAt: sql`excluded.updated_at`,
            completedAt: sql`excluded.completed_at`,
          },
        });
    }
    if (staleIds.length > 0) {
      await tx
        .update(todosTable)
        .set({ parentTodoId: null, updatedAt: new Date() })
        .where(
          and(
            eq(todosTable.agentId, input.runtime.agentId),
            eq(todosTable.entityId, input.entityId),
            inArray(todosTable.parentTodoId, staleIds),
          ),
        );
      await tx
        .delete(todosTable)
        .where(
          and(
            eq(todosTable.agentId, input.runtime.agentId),
            eq(todosTable.entityId, input.entityId),
            inArray(todosTable.id, staleIds),
          ),
        );
    }

    const targetRows =
      desiredIds.size === 0
        ? []
        : await tx
            .select()
            .from(todosTable)
            .where(
              and(
                eq(todosTable.agentId, input.runtime.agentId),
                eq(todosTable.entityId, input.entityId),
                inArray(todosTable.id, Array.from(desiredIds)),
              ),
            );
    if (targetRows.length !== input.snapshot.todos.length) {
      throw new ElizaError(
        "Dedicated Todo import did not materialize the exact source count",
        {
          code: "TODO_CUTOVER_TARGET_COUNT_MISMATCH",
          context: {
            expected: input.snapshot.todos.length,
            actual: targetRows.length,
          },
        },
      );
    }
    const materialized = await createSharedTodoCutoverSnapshot({
      sourceAgentId: input.snapshot.sourceAgentId,
      todos: materializeSourceRecords(targetRows),
    });
    if (materialized.digest !== input.snapshot.digest) {
      throw new ElizaError(
        "Dedicated Todo import digest does not match Shared",
        {
          code: "TODO_CUTOVER_TARGET_DIGEST_MISMATCH",
          context: {
            sourceDigest: input.snapshot.digest,
            targetDigest: materialized.digest,
          },
        },
      );
    }
    return {
      sourceTodoCount: input.snapshot.todos.length,
      importedTodos,
      repairedTodos,
      skippedTodos,
      removedStaleTodos: staleIds.length,
      sourceTodoDigest: input.snapshot.digest,
      targetTodoDigest: materialized.digest,
    };
  });
}
