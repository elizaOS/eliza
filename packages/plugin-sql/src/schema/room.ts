import { getSchemaFactory } from './factory';
import { agentTable } from './agent';

/**
 * Lazy-loaded room table definition.
 * This function returns the room table schema when called,
 * ensuring the database type is set before schema creation.
 */
function createRoomTable() {
  const factory = getSchemaFactory();
  
  return factory.table('rooms', {
    id: (() => {
      const defaultUuid = factory.defaultRandomUuid();
      const column = factory.uuid('id').notNull().primaryKey();
      return defaultUuid ? column.default(defaultUuid) : column;
    })(),
    agentId: factory.uuid('agentId').references(() => agentTable.id, {
      onDelete: 'cascade',
    }),
    source: factory.text('source').notNull(),
    type: factory.text('type').notNull(),
    serverId: factory.text('serverId'),
    worldId: factory.uuid('worldId'), // no guarantee that world exists, it is optional for now
    // .references(() => worldTable.id, {
    //   onDelete: 'cascade',
    // }),
    name: factory.text('name'),
    metadata: factory.json('metadata'),
    channelId: factory.text('channelId'),
    createdAt: factory.timestamp('createdAt')
      .default(factory.defaultTimestamp())
      .notNull(),
  });
}

// Cache the table once created
let _roomTable: any = null;

/**
 * Represents the room table in the database.
 * Uses lazy initialization to ensure proper database type configuration.
 */
export const roomTable = new Proxy({} as any, {
  get(target, prop, receiver) {
    if (!_roomTable) {
      _roomTable = createRoomTable();
    }
    return Reflect.get(_roomTable, prop, receiver);
  }
});
