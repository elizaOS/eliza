import { getSchemaFactory } from './factory';
import { channelTable } from './channel';

/**
 * Lazy-loaded channel participants table definition.
 * This function returns the channel participants table schema when called,
 * ensuring the database type is set before schema creation.
 */
function createChannelParticipantsTable() {
  const factory = getSchemaFactory();
  
  return factory.table(
    'channel_participants',
    {
      channelId: factory.text('channel_id')
        .notNull()
        .references(() => channelTable.id, { onDelete: 'cascade' }),
      userId: factory.text('user_id').notNull(), // This is a central UUID (can be an agentId or a dedicated central user ID)
    },
    (table) => ({
      pk: factory.primaryKey({ columns: [table.channelId, table.userId] }),
    })
  );
}

// Cache the table once created
let _channelParticipantsTable: any = null;

/**
 * Represents the channel participants table in the database.
 * Uses lazy initialization to ensure proper database type configuration.
 */
export const channelParticipantsTable = new Proxy({} as any, {
  get(target, prop, receiver) {
    if (!_channelParticipantsTable) {
      _channelParticipantsTable = createChannelParticipantsTable();
    }
    return Reflect.get(_channelParticipantsTable, prop, receiver);
  }
});
