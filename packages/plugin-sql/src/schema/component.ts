import { getSchemaFactory, createLazyTableProxy } from './factory';
import { agentTable } from './agent';
import { entityTable } from './entity';
import { roomTable } from './room';
import { worldTable } from './world';

/**
 * Lazy-loaded component table definition.
 * This function returns the component table schema when called,
 * ensuring the database type is set before schema creation.
 */
function createComponentTable() {
  const factory = getSchemaFactory();

  return factory.table('components', {
    id: (() => {
      const defaultUuid = factory.defaultRandomUuid();
      const column = factory.uuid('id').primaryKey().notNull();
      return defaultUuid ? column.default(defaultUuid) : column;
    })(),

    // Foreign keys
    entityId: factory
      .uuid('entityId')
      .references(() => entityTable.id, { onDelete: 'cascade' })
      .notNull(),
    agentId: factory
      .uuid('agentId')
      .references(() => agentTable.id, { onDelete: 'cascade' })
      .notNull(),
    roomId: factory
      .uuid('roomId')
      .references(() => roomTable.id, { onDelete: 'cascade' })
      .notNull(),
    worldId: factory.uuid('worldId').references(() => worldTable.id, { onDelete: 'cascade' }),
    sourceEntityId: factory
      .uuid('sourceEntityId')
      .references(() => entityTable.id, { onDelete: 'cascade' }),

    // Data
    type: factory.text('type').notNull(),
    data: factory.json('data').default(factory.defaultJsonObject()),

    // Timestamps
    createdAt: factory.timestamp('createdAt').default(factory.defaultTimestamp()).notNull(),
  });
}

/**
 * Represents a component table in the database.
 * Uses lazy initialization to ensure proper database type configuration.
 */
export const componentTable = createLazyTableProxy(createComponentTable);
