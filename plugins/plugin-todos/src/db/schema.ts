import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
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
    createdAt: timestamp("created_at")
      .default(sql`now()`)
      .notNull(),
    updatedAt: timestamp("updated_at")
      .default(sql`now()`)
      .notNull(),
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

export type TodoRow = typeof todosTable.$inferSelect;
export type TodoInsert = typeof todosTable.$inferInsert;
