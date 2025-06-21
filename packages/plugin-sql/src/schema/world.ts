import { getSchemaFactory } from './factory';
import { agentTable } from './agent';

/**
 * Lazy-loaded world table definition.
 * This function returns the world table schema when called,
 * ensuring the database type is set before schema creation.
 */
function createWorldTable() {
  const factory = getSchemaFactory();
  
  return factory.table('worlds', {
    id: (() => {
      const defaultUuid = factory.defaultRandomUuid();
      const column = factory.uuid('id').notNull().primaryKey();
      return defaultUuid ? column.default(defaultUuid) : column;
    })(),
    agentId: factory.uuid('agentId')
      .notNull()
      .references(() => agentTable.id, { onDelete: 'cascade' }),
    name: factory.text('name').notNull(),
    metadata: factory.json('metadata'),
    serverId: factory.text('serverId').notNull().default('local'),
    createdAt: factory.timestamp('createdAt')
      .default(factory.defaultTimestamp())
      .notNull(),
  });
}

// Cache the table once created
let _worldTable: any = null;

/**
 * Represents the world table in the database.
 * Uses lazy initialization to ensure proper database type configuration.
 */
export const worldTable = new Proxy({} as any, {
  get(target, prop, receiver) {
    if (!_worldTable) {
      _worldTable = createWorldTable();
    }
    return Reflect.get(_worldTable, prop, receiver);
  }
});
