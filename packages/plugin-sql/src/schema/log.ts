import { getSchemaFactory } from './factory';
import { entityTable } from './entity';
import { roomTable } from './room';

/**
 * Lazy-loaded log table definition.
 * This function returns the log table schema when called,
 * ensuring the database type is set before schema creation.
 */
function createLogTable() {
  const factory = getSchemaFactory();
  
  return factory.table(
    'logs',
    {
      id: (() => {
        const defaultUuid = factory.defaultRandomUuid();
        const column = factory.uuid('id').notNull();
        return defaultUuid ? column.default(defaultUuid) : column;
      })(),
      createdAt: factory.timestamp('created_at', { withTimezone: true })
        .default(factory.defaultTimestamp())
        .notNull(),
      entityId: factory.uuid('entityId')
        .notNull()
        .references(() => entityTable.id, { onDelete: 'cascade' }),
      body: factory.json('body').notNull(),
      type: factory.text('type').notNull(),
      roomId: factory.uuid('roomId')
        .notNull()
        .references(() => roomTable.id, { onDelete: 'cascade' }),
    },
    (table) => [
      factory.foreignKey({
        name: 'fk_room',
        columns: [table.roomId],
        foreignColumns: [roomTable.id],
      }).onDelete('cascade'),
      factory.foreignKey({
        name: 'fk_user',
        columns: [table.entityId],
        foreignColumns: [entityTable.id],
      }).onDelete('cascade'),
    ]
  );
}

// Cache the table once created
let _logTable: any = null;

/**
 * Represents a PostgreSQL table for storing logs.
 * Uses lazy initialization to ensure proper database type configuration.
 */
export const logTable = new Proxy({} as any, {
  get(target, prop, receiver) {
    if (!_logTable) {
      _logTable = createLogTable();
    }
    return Reflect.get(_logTable, prop, receiver);
  }
});
