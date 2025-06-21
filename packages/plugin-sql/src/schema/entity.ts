import { getSchemaFactory, createLazyTableProxy } from './factory';
import { agentTable } from './agent';

/**
 * Lazy-loaded entity table definition.
 * This function returns the entity table schema when called,
 * ensuring the database type is set before schema creation.
 */
function createEntityTable() {
  const factory = getSchemaFactory();

  return factory.table(
    'entities',
    {
      id: factory.uuid('id').notNull().primaryKey(),
      agentId: factory
        .uuid('agent_id')
        .notNull()
        .references(() => agentTable.id, {
          onDelete: 'cascade',
        }),
      createdAt: factory.timestamp('created_at').default(factory.defaultTimestamp()).notNull(),
      names: factory.textArray('names').default(factory.defaultTextArray()).notNull(),
      metadata: factory.json('metadata').default(factory.defaultJsonObject()).notNull(),
    },
    (table) => {
      // Use factory method for database-agnostic unique constraint
      return {
        idAgentIdUnique: factory.unique('id_agent_id_unique').on(table.id, table.agentId),
      };
    }
  );
}

/**
 * Represents an entity table in the database.
 * Includes columns for id, agentId, createdAt, names, and metadata.
 */
export const entityTable = createLazyTableProxy(createEntityTable);
