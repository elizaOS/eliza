import type { IAgentRuntime, UUID } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { InferSelectModel } from "drizzle-orm";
import { and, desc, eq, isNull, not, or, type SQL } from "drizzle-orm";
import { todosTable, todoTagsTable } from "../schema";

// Type inferred from the todos table schema
type TodoRow = InferSelectModel<typeof todosTable>;

// Helper function to get typed database instance
// The runtime.db is typed loosely by the core package, but we need to use drizzle methods
function getDb(runtime: IAgentRuntime) {
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle DB instance typing is runtime-dependent
  return runtime.db as any;
}

/**
 * Core todo data structure
 */
export interface TodoData {
  id: UUID;
  agentId: UUID;
  worldId: UUID;
  roomId: UUID;
  entityId: UUID;
  name: string;
  description?: string | null;
  type: "daily" | "one-off" | "aspirational";
  priority?: number | null;
  isUrgent: boolean;
  isCompleted: boolean;
  dueDate?: Date | null;
  completedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
  tags?: string[];
}

/**
 * Manages todo data and database operations
 */
export class TodoDataService {
  protected runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  /**
   * Create a new todo
   */
  async createTodo(data: {
    agentId: UUID;
    worldId: UUID;
    roomId: UUID;
    entityId: UUID;
    name: string;
    description?: string;
    type: "daily" | "one-off" | "aspirational";
    priority?: number;
    isUrgent?: boolean;
    dueDate?: Date;
    metadata?: Record<string, unknown>;
    tags?: string[];
  }): Promise<UUID> {
    const db = getDb(this.runtime);

    // Create the todo
    const [todo] = await db
      .insert(todosTable)
      .values({
        agentId: data.agentId,
        worldId: data.worldId,
        roomId: data.roomId,
        entityId: data.entityId,
        name: data.name,
        description: data.description,
        type: data.type,
        priority: data.priority,
        isUrgent: data.isUrgent || false,
        dueDate: data.dueDate,
        metadata: data.metadata || {},
      })
      .returning();

    if (!todo) {
      throw new Error("Failed to create todo");
    }

    // Add tags if provided
    if (data.tags && data.tags.length > 0) {
      await db.insert(todoTagsTable).values(
        data.tags.map((tag) => ({
          todoId: todo.id,
          tag,
        }))
      );
    }

    logger.info(`Created todo: ${todo.id} - ${todo.name}`);
    return todo.id;
  }

  /**
   * Get a single todo by ID
   */
  async getTodo(todoId: UUID): Promise<TodoData | null> {
    const db = getDb(this.runtime);

    const todos = await db.select().from(todosTable).where(eq(todosTable.id, todoId));
    const todo = todos[0];

    if (!todo) {
      return null;
    }

    // Fetch tags
    const tags = await db
      .select({ tag: todoTagsTable.tag })
      .from(todoTagsTable)
      .where(eq(todoTagsTable.todoId, todoId));

    return {
      ...(todo as TodoRow),
      tags: tags.map((t: { tag: string }) => t.tag),
    } as TodoData;
  }

  /**
   * Get todos with optional filters
   */
  async getTodos(filters?: {
    agentId?: UUID;
    worldId?: UUID;
    roomId?: UUID;
    entityId?: UUID;
    type?: "daily" | "one-off" | "aspirational";
    isCompleted?: boolean;
    tags?: string[];
    limit?: number;
  }): Promise<TodoData[]> {
    const db = getDb(this.runtime);

    // Apply filters
    const conditions: SQL[] = [];
    if (filters?.agentId) conditions.push(eq(todosTable.agentId, filters.agentId));
    if (filters?.worldId) conditions.push(eq(todosTable.worldId, filters.worldId));
    if (filters?.roomId) conditions.push(eq(todosTable.roomId, filters.roomId));
    if (filters?.entityId) conditions.push(eq(todosTable.entityId, filters.entityId));
    if (filters?.type) conditions.push(eq(todosTable.type, filters.type));
    if (filters?.isCompleted !== undefined)
      conditions.push(eq(todosTable.isCompleted, filters.isCompleted));

    let query = db.select().from(todosTable);

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    query = query.orderBy(desc(todosTable.createdAt));

    const todos: TodoRow[] = filters?.limit ? await query.limit(filters.limit) : await query;

    // Fetch tags for each todo
    const todosWithTags = await Promise.all(
      todos.map(async (todo: TodoRow) => {
        const tags = await db
          .select({ tag: todoTagsTable.tag })
          .from(todoTagsTable)
          .where(eq(todoTagsTable.todoId, todo.id));

        return {
          ...todo,
          tags: tags.map((t: { tag: string }) => t.tag),
        } as TodoData;
      })
    );

    // Filter by tags if specified
    if (filters?.tags && filters.tags.length > 0) {
      return todosWithTags.filter((todo: TodoData) =>
        filters.tags?.some((tag) => todo.tags?.includes(tag))
      );
    }

    return todosWithTags;
  }

  /**
   * Update a todo
   */
  async updateTodo(
    todoId: UUID,
    updates: {
      name?: string;
      description?: string;
      priority?: number;
      isUrgent?: boolean;
      isCompleted?: boolean;
      dueDate?: Date;
      completedAt?: Date;
      metadata?: Record<string, unknown>;
    }
  ): Promise<boolean> {
    const db = getDb(this.runtime);

    const updateData = {
      ...updates,
      updatedAt: new Date(),
    };

    await db.update(todosTable).set(updateData).where(eq(todosTable.id, todoId));

    return true;
  }

  /**
   * Delete a todo
   */
  async deleteTodo(todoId: UUID): Promise<boolean> {
    const db = getDb(this.runtime);

    await db.delete(todosTable).where(eq(todosTable.id, todoId));

    logger.info(`Deleted todo: ${todoId}`);
    return true;
  }

  /**
   * Add tags to a todo
   */
  async addTags(todoId: UUID, tags: string[]): Promise<boolean> {
    const db = getDb(this.runtime);

    // Filter out existing tags
    const existingTags = await db
      .select({ tag: todoTagsTable.tag })
      .from(todoTagsTable)
      .where(eq(todoTagsTable.todoId, todoId));

    const existingTagSet = new Set(existingTags.map((t: { tag: string }) => t.tag));
    const newTags = tags.filter((tag) => !existingTagSet.has(tag));

    if (newTags.length > 0) {
      await db.insert(todoTagsTable).values(
        newTags.map((tag) => ({
          todoId,
          tag,
        }))
      );
    }

    return true;
  }

  /**
   * Remove tags from a todo
   */
  async removeTags(todoId: UUID, tags: string[]): Promise<boolean> {
    const db = getDb(this.runtime);

    await db
      .delete(todoTagsTable)
      .where(
        and(eq(todoTagsTable.todoId, todoId), or(...tags.map((tag) => eq(todoTagsTable.tag, tag))))
      );

    return true;
  }

  /**
   * Get overdue tasks
   */
  async getOverdueTodos(filters?: {
    agentId?: UUID;
    worldId?: UUID;
    roomId?: UUID;
    entityId?: UUID;
  }): Promise<TodoData[]> {
    try {
      const db = getDb(this.runtime);

      const conditions: SQL[] = [
        eq(todosTable.isCompleted, false),
        not(isNull(todosTable.dueDate)),
      ];

      if (filters?.agentId) conditions.push(eq(todosTable.agentId, filters.agentId));
      if (filters?.worldId) conditions.push(eq(todosTable.worldId, filters.worldId));
      if (filters?.roomId) conditions.push(eq(todosTable.roomId, filters.roomId));
      if (filters?.entityId) conditions.push(eq(todosTable.entityId, filters.entityId));

      const todos = await db
        .select()
        .from(todosTable)
        .where(and(...conditions))
        .orderBy(todosTable.dueDate);

      // Filter overdue tasks in memory since SQL date comparison is complex
      const now = new Date();
      const overdueTodos = todos.filter((todo: TodoRow) => todo.dueDate && todo.dueDate < now);

      // Fetch tags
      const todosWithTags = await Promise.all(
        overdueTodos.map(async (todo: TodoRow) => {
          const tags = await db
            .select({ tag: todoTagsTable.tag })
            .from(todoTagsTable)
            .where(eq(todoTagsTable.todoId, todo.id));

          return {
            ...todo,
            tags: tags.map((t: { tag: string }) => t.tag),
          } as TodoData;
        })
      );

      return todosWithTags;
    } catch (error) {
      logger.error(
        "Error fetching overdue todos:",
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  /**
   * Reset daily todos for a new day
   */
  async resetDailyTodos(filters?: {
    agentId?: UUID;
    worldId?: UUID;
    roomId?: UUID;
    entityId?: UUID;
  }): Promise<number> {
    try {
      const db = getDb(this.runtime);

      const conditions: SQL[] = [eq(todosTable.type, "daily"), eq(todosTable.isCompleted, true)];

      if (filters?.agentId) conditions.push(eq(todosTable.agentId, filters.agentId));
      if (filters?.worldId) conditions.push(eq(todosTable.worldId, filters.worldId));
      if (filters?.roomId) conditions.push(eq(todosTable.roomId, filters.roomId));
      if (filters?.entityId) conditions.push(eq(todosTable.entityId, filters.entityId));

      // Reset daily todos
      const _result = await db
        .update(todosTable)
        .set({
          isCompleted: false,
          completedAt: null,
          metadata: {
            completedToday: false,
          },
          updatedAt: new Date(),
        })
        .where(and(...conditions));

      return 0; // Return count of reset todos
    } catch (error) {
      logger.error(
        "Error resetting daily todos:",
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }
}

/**
 * Create a new TodoDataService instance
 */
export function createTodoDataService(runtime: IAgentRuntime): TodoDataService {
  return new TodoDataService(runtime);
}
