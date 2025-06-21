import { getSchemaFactory } from './factory';
import { agentTable } from './agent';
import { entityTable } from './entity';

/**
 * Lazy-loaded relationship table definition.
 * This function returns the relationship table schema when called,
 * ensuring the database type is set before schema creation.
 */
function createRelationshipTable() {
  const factory = getSchemaFactory();
  
  return factory.table(
    'relationships',
    {
      id: (() => {
        const defaultUuid = factory.defaultRandomUuid();
        const column = factory.uuid('id').notNull().primaryKey();
        return defaultUuid ? column.default(defaultUuid) : column;
      })(),
      createdAt: factory.timestamp('created_at', { withTimezone: true })
        .default(factory.defaultTimestamp())
        .notNull(),
      sourceEntityId: factory.uuid('sourceEntityId')
        .notNull()
        .references(() => entityTable.id, { onDelete: 'cascade' }),
      targetEntityId: factory.uuid('targetEntityId')
        .notNull()
        .references(() => entityTable.id, { onDelete: 'cascade' }),
      agentId: factory.uuid('agentId')
        .notNull()
        .references(() => agentTable.id, { onDelete: 'cascade' }),
      tags: factory.textArray('tags'),
      metadata: factory.json('metadata'),
    },
    (table) => [
      factory.index('idx_relationships_users').on(table.sourceEntityId, table.targetEntityId),
      factory.unique('unique_relationship').on(table.sourceEntityId, table.targetEntityId, table.agentId),
      factory.foreignKey({
        name: 'fk_user_a',
        columns: [table.sourceEntityId],
        foreignColumns: [entityTable.id],
      }).onDelete('cascade'),
      factory.foreignKey({
        name: 'fk_user_b',
        columns: [table.targetEntityId],
        foreignColumns: [entityTable.id],
      }).onDelete('cascade'),
    ]
  );
}

// Cache the table once created
let _relationshipTable: any = null;

/**
 * Defines the relationshipTable containing information about relationships between entities and agents.
 * Uses lazy initialization to ensure proper database type configuration.
 */
export const relationshipTable = new Proxy({} as any, {
  get(target, prop, receiver) {
    if (!_relationshipTable) {
      _relationshipTable = createRelationshipTable();
    }
    return Reflect.get(_relationshipTable, prop, receiver);
  }
});
