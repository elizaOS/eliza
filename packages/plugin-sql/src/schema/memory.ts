import { relations, sql } from 'drizzle-orm';
import { getSchemaFactory, createLazyTableProxy } from './factory';
import { agentTable } from './agent';
import { embeddingTable } from './embedding';
import { entityTable } from './entity';
import { roomTable } from './room';

/**
 * Lazy-loaded memory table definition.
 * This function returns the memory table schema when called,
 * ensuring the database type is set before schema creation.
 */
function createMemoryTable() {
  const factory = getSchemaFactory();

  return factory.table(
    'memories',
    {
      id: factory.uuid('id').primaryKey().notNull(),
      type: factory.text('type').notNull(),
      createdAt: factory.timestamp('createdAt').default(factory.defaultTimestamp()).notNull(),
      content: factory.json('content').notNull(),
      entityId: factory.uuid('entityId').references(() => entityTable.id, {
        onDelete: 'cascade',
      }),
      agentId: factory
        .uuid('agentId')
        .references(() => agentTable.id, {
          onDelete: 'cascade',
        })
        .notNull(),
      roomId: factory.uuid('roomId').references(() => roomTable.id, {
        onDelete: 'cascade',
      }),
      worldId: factory.uuid('worldId'),
      // .references(() => worldTable.id, {
      //   onDelete: 'set null',
      // }),
      unique: factory.boolean('unique').default(true).notNull(),
      metadata: factory.json('metadata').default(factory.defaultJsonObject()).notNull(),
    },
    (table) => {
      // Use factory methods for database-agnostic constraints
      return [
        factory.index('idx_memories_type_room').on(table.type, table.roomId),
        factory.index('idx_memories_world_id').on(table.worldId),
        factory
          .foreignKey({
            name: 'fk_room',
            columns: [table.roomId],
            foreignColumns: [roomTable.id],
          })
          .onDelete('cascade'),
        factory
          .foreignKey({
            name: 'fk_user',
            columns: [table.entityId],
            foreignColumns: [entityTable.id],
          })
          .onDelete('cascade'),
        factory
          .foreignKey({
            name: 'fk_agent',
            columns: [table.agentId],
            foreignColumns: [agentTable.id],
          })
          .onDelete('cascade'),
        // foreignKey({
        //   name: 'fk_world',
        //   columns: [table.worldId],
        //   foreignColumns: [worldTable.id],
        // }).onDelete('set null'),
        factory.index('idx_memories_metadata_type').on(sql`((metadata->>'type'))`),
        factory.index('idx_memories_document_id').on(sql`((metadata->>'documentId'))`),
        factory
          .index('idx_fragments_order')
          .on(sql`((metadata->>'documentId'))`, sql`((metadata->>'position'))`),
        factory.check(
          'fragment_metadata_check',
          sql`
                CASE 
                    WHEN metadata->>'type' = 'fragment' THEN
                        metadata ? 'documentId' AND 
                        metadata ? 'position'
                    ELSE true
                END
            `
        ),
        factory.check(
          'document_metadata_check',
          sql`
                CASE 
                    WHEN metadata->>'type' = 'document' THEN
                        metadata ? 'timestamp'
                    ELSE true
                END
            `
        ),
      ];
    }
  );
}

/**
 * Represents the memory table in the database.
 * Uses lazy initialization to ensure proper database type configuration.
 */
export const memoryTable = createLazyTableProxy(createMemoryTable);

export const memoryRelations = relations(memoryTable, ({ one }) => ({
  embedding: one(embeddingTable),
}));
