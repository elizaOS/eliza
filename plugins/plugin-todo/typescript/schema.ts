import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const todosTable = pgTable(
  "todos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull(),
    worldId: uuid("world_id").notNull(),
    roomId: uuid("room_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    type: text("type").notNull(),
    priority: integer("priority").default(4),
    isUrgent: boolean("is_urgent").default(false),
    isCompleted: boolean("is_completed").default(false),
    dueDate: timestamp("due_date"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at").default(sql`now()`).notNull(),
    metadata: jsonb("metadata").default("{}").notNull(),
  },
  (table) => ({
    agentIdIndex: index("idx_todos_agent").on(table.agentId),
    worldIdIndex: index("idx_todos_world").on(table.worldId),
    roomIdIndex: index("idx_todos_room").on(table.roomId),
    entityIdIndex: index("idx_todos_entity").on(table.entityId),
    typeIndex: index("idx_todos_type").on(table.type),
    completedIndex: index("idx_todos_completed").on(table.isCompleted),
    dueDateIndex: index("idx_todos_due_date").on(table.dueDate),
    createdAtIndex: index("idx_todos_created_at").on(table.createdAt),
  })
);

export const todoTagsTable = pgTable(
  "todo_tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    todoId: uuid("todo_id")
      .references(() => todosTable.id, {
        onDelete: "cascade",
      })
      .notNull(),
    tag: text("tag").notNull(),
    createdAt: timestamp("created_at").default(sql`now()`).notNull(),
  },
  (table) => ({
    todoIdIndex: index("idx_todo_tags_todo").on(table.todoId),
    tagIndex: index("idx_todo_tags_tag").on(table.tag),
    uniqueTodoTag: uniqueIndex("unique_todo_tag").on(table.todoId, table.tag),
  })
);

export const todosRelations = relations(todosTable, ({ many }) => ({
  tags: many(todoTagsTable),
}));

export const todoTagsRelations = relations(todoTagsTable, ({ one }) => ({
  todo: one(todosTable, {
    fields: [todoTagsTable.todoId],
    references: [todosTable.id],
  }),
}));

export const todoSchema = {
  todosTable,
  todoTagsTable,
  tables: {
    todos: todosTable,
    todoTags: todoTagsTable,
  },
};

export default todoSchema;
