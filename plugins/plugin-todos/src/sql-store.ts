/**
 * Canonical Postgres implementation of the tenant-scoped TodoStore contract.
 * Both Worker and container hosts inject their own Drizzle connection so all
 * persistence, hierarchy, and concurrency rules remain identical.
 */
import { ElizaError, type UUID } from "@elizaos/core/edge";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { type TodoRow, todosTable } from "./db/schema.js";
import {
  type CreateTodoInput,
  isValidTodoListLimit,
  TODO_INVALID_PARENT_ERROR_CODE,
  TODO_LIST_LIMIT_ERROR_CODE,
  TODO_PARENT_CYCLE_ERROR_CODE,
  type TodoFilter,
  type TodoScope,
  type TodoStore,
  type UpdateTodoInput,
  type WriteTodoListInput,
} from "./store.js";
import { TODOS_LOG_PREFIX, type Todo, type TodoStatus } from "./types.js";

interface TodoHierarchyRow {
  id: string;
  parentTodoId: string | null;
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

class SqlTodoStore implements TodoStore {
  constructor(private readonly db: NodePgDatabase) {}

  async create(input: CreateTodoInput): Promise<Todo> {
    return this.db.transaction(async (tx) => {
      const scope = { agentId: input.agentId, entityId: input.entityId };
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${scopeLockKey(scope)}))`,
      );
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
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${scopeLockKey(scope)}))`,
      );
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
    });
  }

  async delete(scope: TodoScope, id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${scopeLockKey(scope)}))`,
      );
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
      return rows.length > 0;
    });
  }

  /**
   * Bulk-replace the user's todo list for a given (entityId, roomId) scope.
   * Mirrors Claude Code's TodoWrite contract: the caller passes the full
   * desired list, and the store reconciles. Existing rows are matched by id;
   * absent rows are deleted; new rows are inserted.
   */
  async writeList(
    args: WriteTodoListInput,
  ): Promise<{ before: Todo[]; after: Todo[] }> {
    return this.db.transaction(async (tx) => {
      const scope = { agentId: args.agentId, entityId: args.entityId };
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${scopeLockKey(scope)}))`,
      );
      const conditions = [
        eq(todosTable.agentId, args.agentId as UUID),
        eq(todosTable.entityId, args.entityId as UUID),
      ];
      if (args.roomId !== null) {
        conditions.push(eq(todosTable.roomId, args.roomId as UUID));
      }
      const beforeRows = await tx
        .select()
        .from(todosTable)
        .where(and(...conditions))
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
                    completedAt:
                      item.status === "completed" ? new Date() : null,
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
            throw new Error(
              `${TODOS_LOG_PREFIX} scoped update returned no row`,
            );
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
    });
  }

  async clear(filter: TodoScope & { roomId?: string | null }): Promise<number> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${scopeLockKey(filter)}))`,
      );
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
    });
  }
}

/** Build the canonical TodoStore over a Drizzle Postgres connection. */
export function createTodosSqlStore(db: NodePgDatabase): TodoStore {
  return new SqlTodoStore(db);
}

export {
  type CreateTodoInput,
  isValidTodoListLimit,
  TODO_INVALID_PARENT_ERROR_CODE,
  TODO_LIST_LIMIT_ERROR_CODE,
  TODO_PARENT_CYCLE_ERROR_CODE,
  type TodoFilter,
  type TodoScope,
  type TodoStore,
  type UpdateTodoInput,
  type WriteTodoListInput,
} from "./store.js";
