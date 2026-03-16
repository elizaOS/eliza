import {
  type Task,
  type TaskMetadata,
  type UUID,
} from "@elizaos/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import { taskTable } from "../tables";
import type { DrizzleDatabase } from "../types";


/**
 * Retrieves tasks based on specified parameters.
 * MySQL: uses JSON_CONTAINS for tag filtering instead of PG's @> operator.
 */
export async function getTasks(
  db: DrizzleDatabase,
  params: {
    roomId?: UUID;
    tags?: string[];
    entityId?: UUID;
    agentIds: UUID[];
    limit?: number;
    offset?: number;
  }
): Promise<Task[]> {
  if (params.agentIds.length === 0) return [];

  // BUG FIX: entityId was accepted but never applied as a WHERE filter.
  let query = db
    .select()
    .from(taskTable)
    .where(
      and(
        inArray(taskTable.agentId, params.agentIds),
        ...(params.roomId ? [eq(taskTable.roomId, params.roomId)] : []),
        ...(params.entityId ? [eq(taskTable.entityId, params.entityId)] : []),
        ...(params.tags && params.tags.length > 0
          ? [
              // MySQL: use JSON_CONTAINS to check if tags JSON array contains all specified tags
              sql`JSON_CONTAINS(${taskTable.tags}, ${JSON.stringify(params.tags)})`,
            ]
          : [])
      )
    );

  // WHY: Apply pagination to limit result size. Previously returned ALL matching tasks.
  if (params.limit) {
    query = query.limit(params.limit) as typeof query;
  }
  if (params.offset) {
    query = query.offset(params.offset) as typeof query;
  }

  const result = await query;

  return result.map((row) => ({
    id: row.id as UUID,
    name: row.name,
    description: row.description ?? "",
    roomId: row.roomId as UUID,
    worldId: row.worldId as UUID,
    tags: row.tags || [],
    metadata: row.metadata as TaskMetadata,
  }));
}

/**
 * Retrieves tasks by name.
 */
export async function getTasksByName(
  db: DrizzleDatabase,
  agentId: UUID,
  name: string
): Promise<Task[]> {
  const result = await db
    .select()
    .from(taskTable)
    .where(and(eq(taskTable.name, name), eq(taskTable.agentId, agentId)));

  return result.map((row) => ({
    id: row.id as UUID,
    name: row.name,
    description: row.description ?? "",
    roomId: row.roomId as UUID,
    worldId: row.worldId as UUID,
    tags: row.tags || [],
    metadata: (row.metadata || {}) as TaskMetadata,
  }));
}



// Batch task operations

/**
 * Creates multiple tasks in the database.
 */
export async function createTasks(db: DrizzleDatabase, agentId: UUID, tasks: Task[]): Promise<UUID[]> {
  if (tasks.length === 0) return [];

  const now = new Date();
  const values = tasks.map((task) => {
    if (!task.worldId) {
      throw new Error("worldId is required");
    }
    return {
      id: task.id as UUID,
      name: task.name,
      description: task.description,
      roomId: task.roomId as UUID,
      worldId: task.worldId as UUID,
      tags: task.tags,
      metadata: task.metadata || {},
      createdAt: now,
      updatedAt: now,
      agentId: agentId as UUID,
    };
  });

  const result = await db.insert(taskTable).values(values);
  return tasks.map((task) => task.id);
}

/**
 * Retrieves multiple tasks by their IDs.
 */
export async function getTasksByIds(
  db: DrizzleDatabase,
  agentId: UUID,
  taskIds: UUID[]
): Promise<Task[]> {
  if (taskIds.length === 0) return [];

  const result = await db
    .select()
    .from(taskTable)
    .where(and(inArray(taskTable.id, taskIds), eq(taskTable.agentId, agentId)));

  return result.map((row) => ({
    id: row.id as UUID,
    name: row.name,
    description: row.description ?? "",
    roomId: row.roomId as UUID,
    worldId: row.worldId as UUID,
    tags: row.tags || [],
    metadata: (row.metadata || {}) as TaskMetadata,
  }));
}

/**
 * Updates multiple tasks in the database using a single CASE-based UPDATE.
 *
 * WHY single statement: eliminates N round-trips. For each column, a CASE
 * expression is only built when at least one update touches that column.
 * The ELSE clause preserves the original value for rows that don't update it.
 *
 * MySQL: tags as JSON array, metadata as JSON; UUIDs as strings.
 */
export async function updateTasks(
  db: DrizzleDatabase,
  agentId: UUID,
  updates: Array<{ id: UUID; task: Partial<Task> }>
): Promise<void> {
  if (updates.length === 0) return;

  const ids = updates.map((u) => u.id);
  const setObj: Record<string, unknown> = {};

  const nameItems = updates.filter((u) => u.task.name !== undefined);
  if (nameItems.length > 0) {
    const cases = nameItems.map(
      (u) => sql`WHEN ${taskTable.id} = ${u.id} THEN ${u.task.name}`
    );
    setObj.name = sql`CASE ${sql.join(cases, sql` `)} ELSE ${taskTable.name} END`;
  }

  const descItems = updates.filter((u) => u.task.description !== undefined);
  if (descItems.length > 0) {
    const cases = descItems.map(
      (u) => sql`WHEN ${taskTable.id} = ${u.id} THEN ${u.task.description ?? null}`
    );
    setObj.description = sql`CASE ${sql.join(cases, sql` `)} ELSE ${taskTable.description} END`;
  }

  const roomItems = updates.filter((u) => u.task.roomId !== undefined);
  if (roomItems.length > 0) {
    const cases = roomItems.map(
      (u) => sql`WHEN ${taskTable.id} = ${u.id} THEN ${u.task.roomId ?? null}`
    );
    setObj.roomId = sql`CASE ${sql.join(cases, sql` `)} ELSE ${taskTable.roomId} END`;
  }

  const worldItems = updates.filter((u) => u.task.worldId !== undefined);
  if (worldItems.length > 0) {
    const cases = worldItems.map(
      (u) => sql`WHEN ${taskTable.id} = ${u.id} THEN ${u.task.worldId ?? null}`
    );
    setObj.worldId = sql`CASE ${sql.join(cases, sql` `)} ELSE ${taskTable.worldId} END`;
  }

  const tagItems = updates.filter((u) => u.task.tags !== undefined);
  if (tagItems.length > 0) {
    const cases = tagItems.map((u) => {
      const arr = u.task.tags || [];
      return sql`WHEN ${taskTable.id} = ${u.id} THEN CAST(${JSON.stringify(arr)} AS JSON)`;
    });
    setObj.tags = sql`CASE ${sql.join(cases, sql` `)} ELSE ${taskTable.tags} END`;
  }

  const metaItems = updates.filter((u) => u.task.metadata !== undefined);
  if (metaItems.length > 0) {
    const cases = metaItems.map(
      (u) =>
        sql`WHEN ${taskTable.id} = ${u.id} THEN CAST(${JSON.stringify(u.task.metadata)} AS JSON)`
    );
    setObj.metadata = sql`CASE ${sql.join(cases, sql` `)} ELSE ${taskTable.metadata} END`;
  }

  const createdAtItems = updates.filter((u) => {
    const taskWithCreatedAt = u.task as { createdAt?: number | bigint | null };
    return taskWithCreatedAt.createdAt !== undefined && taskWithCreatedAt.createdAt !== null;
  });
  if (createdAtItems.length > 0) {
    const cases = createdAtItems.map((u) => {
      const taskWithCreatedAt = u.task as { createdAt?: number | bigint | null };
      const val = taskWithCreatedAt.createdAt!;
      const date = new Date(typeof val === "bigint" ? Number(val) : val);
      return sql`WHEN ${taskTable.id} = ${u.id} THEN ${date}`;
    });
    setObj.createdAt = sql`CASE ${sql.join(cases, sql` `)} ELSE ${taskTable.createdAt} END`;
  }

  setObj.updatedAt = new Date();

  await db
    .update(taskTable)
    .set(setObj)
    .where(and(inArray(taskTable.id, ids), eq(taskTable.agentId, agentId)));
}

/**
 * Deletes multiple tasks from the database.
 */
export async function deleteTasks(db: DrizzleDatabase, taskIds: UUID[]): Promise<void> {
  if (taskIds.length === 0) return;

  await db.delete(taskTable).where(inArray(taskTable.id, taskIds));
}
