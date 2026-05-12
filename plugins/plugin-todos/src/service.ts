import { type IAgentRuntime, logger, Service, type UUID } from "@elizaos/core";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { type TodoRow, todosTable } from "./db/schema.js";
import {
  TODOS_LOG_PREFIX,
  TODOS_SERVICE_TYPE,
  type Todo,
  type TodoStatus,
} from "./types.js";

export interface TodoFilter {
  entityId: string;
  agentId?: string;
  roomId?: string | null;
  status?: TodoStatus | TodoStatus[];
  includeCompleted?: boolean;
  limit?: number;
}

export interface CreateTodoInput {
  entityId: string;
  agentId: string;
  roomId?: string | null;
  worldId?: string | null;
  content: string;
  activeForm?: string;
  status?: TodoStatus;
  parentTodoId?: string | null;
  parentTrajectoryStepId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface UpdateTodoInput {
  content?: string;
  activeForm?: string;
  status?: TodoStatus;
  parentTodoId?: string | null;
  metadata?: Record<string, unknown>;
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

export class TodosService extends Service {
  static override readonly serviceType = TODOS_SERVICE_TYPE;

  override capabilityDescription =
    "User-scoped todo CRUD. Persistent (drizzle/postgres), keyed by (agentId, entityId).";

  private getDb(): NodePgDatabase {
    const db = this.runtime.db as NodePgDatabase | undefined;
    if (!db) {
      throw new Error(
        `${TODOS_LOG_PREFIX} runtime.db is not available — @elizaos/plugin-sql must be installed and initialized.`,
      );
    }
    return db;
  }

  static async start(runtime: IAgentRuntime): Promise<TodosService> {
    logger.info(`${TODOS_LOG_PREFIX} starting TodosService`);
    return new TodosService(runtime);
  }

  override async stop(): Promise<void> {
    logger.info(`${TODOS_LOG_PREFIX} stopping TodosService`);
  }

  async create(input: CreateTodoInput): Promise<Todo> {
    const db = this.getDb();
    const [row] = await db
      .insert(todosTable)
      .values({
        agentId: input.agentId as UUID,
        entityId: input.entityId as UUID,
        roomId: (input.roomId ?? null) as UUID | null,
        worldId: (input.worldId ?? null) as UUID | null,
        content: input.content,
        activeForm: input.activeForm ?? input.content,
        status: input.status ?? "pending",
        parentTodoId: (input.parentTodoId ?? null) as UUID | null,
        parentTrajectoryStepId: input.parentTrajectoryStepId ?? null,
        metadata: input.metadata ?? {},
      })
      .returning();
    if (!row) throw new Error(`${TODOS_LOG_PREFIX} insert returned no row`);
    return rowToTodo(row);
  }

  async get(id: string): Promise<Todo | null> {
    const db = this.getDb();
    const [row] = await db
      .select()
      .from(todosTable)
      .where(eq(todosTable.id, id as UUID))
      .limit(1);
    return row ? rowToTodo(row) : null;
  }

  async list(filter: TodoFilter): Promise<Todo[]> {
    const db = this.getDb();
    const conditions = [eq(todosTable.entityId, filter.entityId as UUID)];
    if (filter.agentId) {
      conditions.push(eq(todosTable.agentId, filter.agentId as UUID));
    }
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
    const query = db
      .select()
      .from(todosTable)
      .where(and(...conditions))
      .orderBy(desc(todosTable.updatedAt));
    const rows = filter.limit ? await query.limit(filter.limit) : await query;
    return rows.map(rowToTodo);
  }

  async update(id: string, patch: UpdateTodoInput): Promise<Todo | null> {
    const db = this.getDb();
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.content !== undefined) set.content = patch.content;
    if (patch.activeForm !== undefined) set.activeForm = patch.activeForm;
    if (patch.status !== undefined) {
      set.status = patch.status;
      set.completedAt = patch.status === "completed" ? new Date() : null;
    }
    if (patch.parentTodoId !== undefined) set.parentTodoId = patch.parentTodoId;
    if (patch.metadata !== undefined) set.metadata = patch.metadata;
    const [row] = await db
      .update(todosTable)
      .set(set)
      .where(eq(todosTable.id, id as UUID))
      .returning();
    return row ? rowToTodo(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    const db = this.getDb();
    const rows = await db
      .delete(todosTable)
      .where(eq(todosTable.id, id as UUID))
      .returning({ id: todosTable.id });
    return rows.length > 0;
  }

  /**
   * Bulk-replace the user's todo list for a given (entityId, roomId) scope.
   * Mirrors Claude Code's TodoWrite contract: the caller passes the full
   * desired list, and the store reconciles. Existing rows are matched by id;
   * absent rows are deleted; new rows are inserted.
   */
  async writeList(args: {
    entityId: string;
    agentId: string;
    roomId: string | null;
    worldId: string | null;
    parentTrajectoryStepId: string | null;
    todos: Array<{
      id?: string;
      content: string;
      status: TodoStatus;
      activeForm?: string;
    }>;
  }): Promise<{ before: Todo[]; after: Todo[] }> {
    const db = this.getDb();
    const before = await this.list({
      entityId: args.entityId,
      agentId: args.agentId,
      roomId: args.roomId ?? undefined,
    });
    const beforeById = new Map(before.map((t) => [t.id, t]));

    const keepIds = new Set<string>();
    const after: Todo[] = [];
    for (const item of args.todos) {
      const existing = item.id ? beforeById.get(item.id) : undefined;
      if (existing) {
        keepIds.add(existing.id);
        const needsUpdate =
          existing.content !== item.content ||
          existing.status !== item.status ||
          existing.activeForm !== (item.activeForm ?? item.content);
        if (needsUpdate) {
          const updated = await this.update(existing.id, {
            content: item.content,
            activeForm: item.activeForm ?? item.content,
            status: item.status,
          });
          if (updated) after.push(updated);
        } else {
          after.push(existing);
        }
      } else {
        const created = await this.create({
          entityId: args.entityId,
          agentId: args.agentId,
          roomId: args.roomId,
          worldId: args.worldId,
          content: item.content,
          activeForm: item.activeForm ?? item.content,
          status: item.status,
          parentTrajectoryStepId: args.parentTrajectoryStepId,
        });
        keepIds.add(created.id);
        after.push(created);
      }
    }

    const toDelete = before
      .filter((t) => !keepIds.has(t.id))
      .map((t) => t.id as UUID);
    if (toDelete.length > 0) {
      await db.delete(todosTable).where(inArray(todosTable.id, toDelete));
    }

    return { before, after };
  }

  async clear(filter: {
    entityId: string;
    agentId?: string;
    roomId?: string | null;
  }): Promise<number> {
    const db = this.getDb();
    const conditions = [eq(todosTable.entityId, filter.entityId as UUID)];
    if (filter.agentId) {
      conditions.push(eq(todosTable.agentId, filter.agentId as UUID));
    }
    if (filter.roomId) {
      conditions.push(eq(todosTable.roomId, filter.roomId as UUID));
    }
    const rows = await db
      .delete(todosTable)
      .where(and(...conditions))
      .returning({ id: todosTable.id });
    return rows.length;
  }
}

export function getTodosService(runtime: IAgentRuntime): TodosService {
  const service = runtime.getService<TodosService>(TODOS_SERVICE_TYPE);
  if (!service) {
    throw new Error(
      `${TODOS_LOG_PREFIX} TodosService is not registered — ensure @elizaos/plugin-todos is enabled.`,
    );
  }
  return service;
}
