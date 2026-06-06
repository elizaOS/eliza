import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Drizzle schema for the relationships knowledge graph.
 *
 * Backs the `@elizaos/plugin-relationships` plugin. The runtime registers
 * migrations from this schema via the plugin object's `schema` field.
 *
 * Tables:
 *   - `entities`      — nodes (person/org/place/project/concept)
 *   - `relationships` — typed edges between entities
 *
 * NOTE: This is a minimal scaffold. The full LifeOps EntityStore and
 * RelationshipStore (see `plugins/plugin-lifeops/src/lifeops/entities/store.ts`
 * and `plugins/plugin-lifeops/src/lifeops/relationships/store.ts`) carry
 * richer per-row state (identities array, attributes map, retired status,
 * sentiment trend, …). Migration of those columns lands in a follow-up.
 */
export const relationshipsSchema = pgSchema("app_relationships");

export const entitiesTable = relationshipsSchema.table(
  "entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    displayName: text("display_name").notNull(),
    attrs: jsonb("attrs").default("{}").notNull(),
    createdAt: timestamp("created_at").default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at").default(sql`now()`).notNull(),
  },
  (table) => ({
    kindIdx: index("idx_relationships_entities_kind").on(table.kind),
    displayNameIdx: index("idx_relationships_entities_display_name").on(
      table.displayName,
    ),
  }),
);

export const relationshipsTable = relationshipsSchema.table(
  "relationships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromEntityId: uuid("from_entity_id").notNull(),
    toEntityId: uuid("to_entity_id").notNull(),
    kind: text("kind").notNull(),
    attrs: jsonb("attrs").default("{}").notNull(),
    lastObservedAt: timestamp("last_observed_at"),
  },
  (table) => ({
    fromIdx: index("idx_relationships_from").on(table.fromEntityId),
    toIdx: index("idx_relationships_to").on(table.toEntityId),
    kindIdx: index("idx_relationships_kind").on(table.kind),
  }),
);

export type EntityRow = typeof entitiesTable.$inferSelect;
export type EntityInsert = typeof entitiesTable.$inferInsert;
export type RelationshipRow = typeof relationshipsTable.$inferSelect;
export type RelationshipInsert = typeof relationshipsTable.$inferInsert;
