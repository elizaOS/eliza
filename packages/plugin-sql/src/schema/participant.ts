import { getSchemaFactory } from './factory';
import { agentTable } from './agent';
import { entityTable } from './entity';
import { roomTable } from './room';

/**
 * Lazy-loaded participant table definition.
 * This function returns the participant table schema when called,
 * ensuring the database type is set before schema creation.
 */
function createParticipantTable() {
  const factory = getSchemaFactory();
  
  return factory.table(
    'participants',
    {
      id: (() => {
        const defaultUuid = factory.defaultRandomUuid();
        const column = factory.uuid('id').notNull().primaryKey();
        return defaultUuid ? column.default(defaultUuid) : column;
      })(),
      createdAt: factory.timestamp('created_at', { withTimezone: true })
        .default(factory.defaultTimestamp())
        .notNull(),
      entityId: factory.uuid('entityId').references(() => entityTable.id, {
        onDelete: 'cascade',
      }),
      roomId: factory.uuid('roomId').references(() => roomTable.id, {
        onDelete: 'cascade',
      }),
      agentId: factory.uuid('agentId').references(() => agentTable.id, {
        onDelete: 'cascade',
      }),
      roomState: factory.text('roomState'),
    },
    (table) => [
      // factory.unique("participants_user_room_agent_unique").on(table.entityId, table.roomId, table.agentId),
      factory.index('idx_participants_user').on(table.entityId),
      factory.index('idx_participants_room').on(table.roomId),
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
let _participantTable: any = null;

/**
 * Defines the schema for the "participants" table in the database.
 * Uses lazy initialization to ensure proper database type configuration.
 */
export const participantTable = new Proxy({} as any, {
  get(target, prop, receiver) {
    if (!_participantTable) {
      _participantTable = createParticipantTable();
    }
    return Reflect.get(_participantTable, prop, receiver);
  }
});
