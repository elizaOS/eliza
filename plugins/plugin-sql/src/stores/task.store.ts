import type { Task, TaskMetadata, UUID } from "@elizaos/core";
import { and, eq, sql } from "drizzle-orm";
import { taskTable } from "../schema/index";
import type { DrizzleDatabase } from "../types";
import type { Store, StoreContext } from "./types";

export class TaskStore implements Store {
  constructor(public readonly ctx: StoreContext) {}

  private get db(): DrizzleDatabase {
    return this.ctx.getDb();
  }

  async create(task: Task): Promise<UUID> {
    if (!task.worldId) throw new Error("worldId is required");

    return this.ctx.withRetry(async () => {
      const now = new Date();
      const metadata = task.metadata || {};

      const values = {
        id: task.id as UUID,
        name: task.name,
        description: task.description,
        roomId: task.roomId as UUID,
        worldId: task.worldId as UUID,
        tags: task.tags,
        metadata: metadata,
        createdAt: now,
        updatedAt: now,
        agentId: this.ctx.agentId as UUID,
      };

      const result = await this.db.insert(taskTable).values(values).returning();
      return result[0].id as UUID;
    }, "TaskStore.create");
  }

  async getAll(params: { roomId?: UUID; tags?: string[]; entityId?: UUID }): Promise<Task[]> {
    return this.ctx.withRetry(async () => {
      const result = await this.db
        .select()
        .from(taskTable)
        .where(
          and(
            eq(taskTable.agentId, this.ctx.agentId),
            ...(params.roomId ? [eq(taskTable.roomId, params.roomId)] : []),
            ...(params.tags && params.tags.length > 0
              ? [
                  sql`${taskTable.tags} @> ARRAY[${sql.join(
                    params.tags.map((t) => sql`${t}`),
                    sql`, `
                  )}]::text[]`,
                ]
              : [])
          )
        );

      return result.map((row) => ({
        id: row.id as UUID,
        name: row.name,
        description: row.description ?? "",
        roomId: row.roomId as UUID,
        worldId: row.worldId as UUID,
        tags: row.tags || [],
        metadata: row.metadata as TaskMetadata,
      }));
    }, "TaskStore.getAll");
  }

  async getByName(name: string): Promise<Task[]> {
    return this.ctx.withRetry(async () => {
      const result = await this.db
        .select()
        .from(taskTable)
        .where(and(eq(taskTable.name, name), eq(taskTable.agentId, this.ctx.agentId)));

      return result.map((row) => ({
        id: row.id as UUID,
        name: row.name,
        description: row.description ?? "",
        roomId: row.roomId as UUID,
        worldId: row.worldId as UUID,
        tags: row.tags || [],
        metadata: (row.metadata || {}) as TaskMetadata,
      }));
    }, "TaskStore.getByName");
  }

  async get(id: UUID): Promise<Task | null> {
    return this.ctx.withRetry(async () => {
      const result = await this.db
        .select()
        .from(taskTable)
        .where(and(eq(taskTable.id, id), eq(taskTable.agentId, this.ctx.agentId)))
        .limit(1);

      if (result.length === 0) return null;

      const row = result[0];
      return {
        id: row.id as UUID,
        name: row.name,
        description: row.description ?? "",
        roomId: row.roomId as UUID,
        worldId: row.worldId as UUID,
        tags: row.tags || [],
        metadata: (row.metadata || {}) as TaskMetadata,
      };
    }, "TaskStore.get");
  }

  async update(id: UUID, task: Partial<Task>): Promise<void> {
    return this.ctx.withRetry(async () => {
      const dbUpdateValues: Partial<typeof taskTable.$inferInsert> & { updatedAt: Date } = {
        updatedAt: new Date(),
      };

      if (task.name !== undefined) dbUpdateValues.name = task.name;
      if (task.description !== undefined) dbUpdateValues.description = task.description;
      if (task.roomId !== undefined) dbUpdateValues.roomId = task.roomId;
      if (task.worldId !== undefined) dbUpdateValues.worldId = task.worldId;
      if (task.tags !== undefined) dbUpdateValues.tags = task.tags;
      if (task.metadata !== undefined) dbUpdateValues.metadata = task.metadata;

      await this.db
        .update(taskTable)
        .set(dbUpdateValues)
        .where(and(eq(taskTable.id, id), eq(taskTable.agentId, this.ctx.agentId)));
    }, "TaskStore.update");
  }

  async delete(id: UUID): Promise<void> {
    return this.ctx.withRetry(async () => {
      await this.db
        .delete(taskTable)
        .where(and(eq(taskTable.id, id), eq(taskTable.agentId, this.ctx.agentId)));
    }, "TaskStore.delete");
  }
}
