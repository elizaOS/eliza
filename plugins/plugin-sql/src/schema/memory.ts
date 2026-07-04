/**
 * Core memory table: every message, fact, document, or fragment an agent
 * stores, keyed by `type` and free-form `content`/`metadata` JSON. Cascade
 * deletes with its room, entity, or agent. Partial expression indexes and
 * CHECK constraints on `metadata->>'type'` enforce shape invariants for the
 * `fragment` and `document` metadata kinds without a dedicated column per
 * kind. Relations are defined in `embedding.ts` to avoid a circular import.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agentTable } from "./agent";
import { entityTable } from "./entity";
import { roomTable } from "./room";

export const memoryTable = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().notNull(),
    type: text("type").notNull(),
    createdAt: timestamp("created_at").default(sql`now()`).notNull(),
    content: jsonb("content").notNull(),
    entityId: uuid("entity_id").references(() => entityTable.id, {
      onDelete: "cascade",
    }),
    agentId: uuid("agent_id")
      .references(() => agentTable.id, {
        onDelete: "cascade",
      })
      .notNull(),
    roomId: uuid("room_id").references(() => roomTable.id, {
      onDelete: "cascade",
    }),
    worldId: uuid("world_id"),
    unique: boolean("unique").default(true).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
  },
  (table) => [
    index("idx_memories_type_room").on(table.type, table.roomId),
    index("idx_memories_world_id").on(table.worldId),
    foreignKey({
      name: "fk_room",
      columns: [table.roomId],
      foreignColumns: [roomTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_user",
      columns: [table.entityId],
      foreignColumns: [entityTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_agent",
      columns: [table.agentId],
      foreignColumns: [agentTable.id],
    }).onDelete("cascade"),
    index("idx_memories_metadata_type").on(sql`((metadata->>'type'))`),
    index("idx_memories_document_id").on(sql`((metadata->>'documentId'))`),
    index("idx_fragments_order").on(
      sql`((metadata->>'documentId'))`,
      sql`((metadata->>'position'))`
    ),
    check(
      "fragment_metadata_check",
      sql`
            CASE 
                WHEN metadata->>'type' = 'fragment' THEN
                    metadata ? 'documentId' AND 
                    metadata ? 'position'
                ELSE true
            END
        `
    ),
    check(
      "document_metadata_check",
      sql`
            CASE 
                WHEN metadata->>'type' = 'document' THEN
                    metadata ? 'timestamp'
                ELSE true
            END
        `
    ),
  ]
);
