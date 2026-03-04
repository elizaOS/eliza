import { type Task, type TaskMetadata, type UUID } from "@elizaos/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import { taskTable } from "../tables";
import type { DrizzleDatabase } from "../types";


/**
 * Asynchronously retrieves tasks based on specified parameters.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} agentId - The ID of the agent whose tasks to retrieve.
 * @param params Object containing optional roomId, tags, and entityId to filter tasks
 * @returns Promise resolving to an array of Task objects
 */
export async function getTasks(
  db: DrizzleDatabase,
  agentId: UUID,
  params: {
    roomId?: UUID;
    tags?: string[];
    entityId?: UUID;
    limit?: number;
    offset?: number;
  }
): Promise<Task[]> {
  // BUG FIX: entityId was accepted but never applied as a WHERE filter.
  let query = db
    .select()
    .from(taskTable)
    .where(
      and(
        eq(taskTable.agentId, agentId),
        ...(params.roomId ? [eq(taskTable.roomId, params.roomId)] : []),
        ...(params.entityId ? [eq(taskTable.entityId, params.entityId)] : []),
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
 * Asynchronously retrieves tasks by name for a specific agent.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} agentId - The ID of the agent whose tasks to retrieve.
 * @param {string} name - The name of the tasks to retrieve.
 * @returns Promise resolving to an array of Task objects
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
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} agentId - The ID of the agent creating the tasks.
 * @param {Task[]} tasks - Array of task objects to create.
 * @returns {Promise<UUID[]>} Promise resolving to an array of created task IDs.
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

  const result = await db.insert(taskTable).values(values).returning();
  // Note: casting to any ensures compatibility with the returned structure from the db query.
  return (result as any[]).map((r) => r.id as UUID);
}

/**
 * Retrieves multiple tasks by their IDs.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} agentId - The ID of the agent who owns the tasks.
 * @param {UUID[]} taskIds - Array of task IDs to retrieve.
 * @returns {Promise<Task[]>} Promise resolving to an array of Task objects.
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
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} agentId - The ID of the agent who owns the tasks.
 * @param {Array<{ id: UUID; task: Partial<Task> }>} updates - Array of update objects.
 * @returns {Promise<void>} Promise resolving when all updates are complete.
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
      (u) => sql`WHEN ${taskTable.id} = ${u.id} THEN ${u.task.roomId ?? null}::uuid`
    );
    setObj.roomId = sql`CASE ${sql.join(cases, sql` `)} ELSE ${taskTable.roomId} END`;
  }

  const worldItems = updates.filter((u) => u.task.worldId !== undefined);
  if (worldItems.length > 0) {
    const cases = worldItems.map(
      (u) => sql`WHEN ${taskTable.id} = ${u.id} THEN ${u.task.worldId ?? null}::uuid`
    );
    setObj.worldId = sql`CASE ${sql.join(cases, sql` `)} ELSE ${taskTable.worldId} END`;
  }

  const tagItems = updates.filter((u) => u.task.tags !== undefined);
  if (tagItems.length > 0) {
    const cases = tagItems.map((u) => {
      const arr = u.task.tags || [];
      const pgArr =
        "{" +
        arr
          .map((s) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"')
          .join(",") +
        "}";
      return sql`WHEN ${taskTable.id} = ${u.id} THEN ${pgArr}::text[]`;
    });
    setObj.tags = sql`CASE ${sql.join(cases, sql` `)} ELSE ${taskTable.tags} END`;
  }

  const metaItems = updates.filter((u) => u.task.metadata !== undefined);
  if (metaItems.length > 0) {
    const cases = metaItems.map(
      (u) =>
        sql`WHEN ${taskTable.id} = ${u.id} THEN ${JSON.stringify(u.task.metadata)}::jsonb`
    );
    setObj.metadata = sql`CASE ${sql.join(cases, sql` `)} ELSE ${taskTable.metadata} END`;
  }

  setObj.updatedAt = new Date();

  await db
    .update(taskTable)
    .set(setObj)
    .where(and(inArray(taskTable.id, ids), eq(taskTable.agentId, agentId)));
}

/**
 * Deletes multiple tasks from the database.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID[]} taskIds - Array of task IDs to delete.
 * @returns {Promise<void>} Promise resolving when all deletions are complete.
 */
export async function deleteTasks(db: DrizzleDatabase, taskIds: UUID[]): Promise<void> {
  if (taskIds.length === 0) return;

  await db.delete(taskTable).where(inArray(taskTable.id, taskIds));
}
