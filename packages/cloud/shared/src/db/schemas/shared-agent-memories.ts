/**
 * Durable core-shape memory rows for container-free Shared (Tier-0) agents,
 * scoped per tenant. Mirrors the core `memories` row (id/agent/entity/room/
 * world, `type` table-name discriminator, jsonb content, nullable real[]
 * embedding + model tag, created_at) and adds the cloud multi-tenant ownership
 * columns `organization_id` + `user_id`, both NOT NULL — every read and write
 * against this table must pin them. The embedding stays `real[]` to match the
 * core row shape; semantic reads cast through pgvector (extension created in
 * migration 0000) at query time. Written only behind the
 * `SHARED_MEMORY_TABLES_ENABLED` flag by the shared-runtime turn commit.
 */
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, jsonb, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

export const sharedAgentMemories = pgTable(
  "shared_agent_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agent_id: uuid("agent_id").notNull(),
    entity_id: uuid("entity_id"),
    room_id: uuid("room_id"),
    world_id: uuid("world_id"),
    type: text("type").notNull(),
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    embedding: real("embedding").array(),
    embedding_model: text("embedding_model"),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    tenantRoomRecencyIdx: index("idx_shared_agent_memories_tenant_room_recency").on(
      table.organization_id,
      table.user_id,
      table.agent_id,
      table.room_id,
      table.created_at,
    ),
    tenantTypeIdx: index("idx_shared_agent_memories_tenant_type").on(
      table.organization_id,
      table.agent_id,
      table.type,
    ),
  }),
);

export type SharedAgentMemoryRow = InferSelectModel<typeof sharedAgentMemories>;
export type NewSharedAgentMemoryRow = InferInsertModel<typeof sharedAgentMemories>;
