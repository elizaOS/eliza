/**
 * Drizzle schema for @elizaos/plugin-todos: the `todos` table under
 * `pgSchema("todos")`, plus its row/insert types and lookup indexes. The runtime
 * registers migrations from this schema via the plugin's `schema` field.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const todosSchema = pgSchema("todos");

export const todosTable = todosSchema.table(
  "todos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    roomId: uuid("room_id"),
    worldId: uuid("world_id"),
    content: text("content").notNull(),
    activeForm: text("active_form").notNull(),
    status: text("status").notNull(),
    parentTodoId: uuid("parent_todo_id"),
    parentTrajectoryStepId: text("parent_trajectory_step_id"),
    metadata: jsonb("metadata").default("{}").notNull(),
    createdAt: timestamp("created_at").default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at").default(sql`now()`).notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => ({
    entityStatusIdx: index("idx_todos_entity_status").on(
      table.entityId,
      table.status,
    ),
    agentEntityIdx: index("idx_todos_agent_entity").on(
      table.agentId,
      table.entityId,
    ),
    roomIdx: index("idx_todos_room").on(table.roomId),
  }),
);

export const todoMutationsTable = todosSchema.table(
  "todo_mutations",
  {
    agentId: uuid("agent_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    mutationId: uuid("mutation_id").primaryKey().defaultRandom(),
    idempotencyKey: text("idempotency_key").notNull(),
    operation: text("operation").notNull(),
    requestDigest: text("request_digest").notNull(),
    resultJson: jsonb("result_json").notNull(),
    applied: boolean("applied").notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
  },
  (table) => ({
    scopeKeyUnique: unique(
      "todo_mutations_agent_entity_idempotency_key_unique",
    ).on(table.agentId, table.entityId, table.idempotencyKey),
    scopeCommitIdx: index("idx_todo_mutations_scope_commit").on(
      table.agentId,
      table.entityId,
      table.committedAt,
      table.mutationId,
    ),
  }),
);

export type TodoRow = typeof todosTable.$inferSelect;
export type TodoInsert = typeof todosTable.$inferInsert;
export type TodoMutationRow = typeof todoMutationsTable.$inferSelect;
export type TodoMutationInsert = typeof todoMutationsTable.$inferInsert;
