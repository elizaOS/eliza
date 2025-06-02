import { getSchemaFactory } from './factory';
import { channelTable } from './channel';
// For primaryKey, Drizzle's core function should be fine unless factory provides specific abstraction
import { primaryKey } from 'drizzle-orm/pg-core'; // Assuming pg-core version is okay for Pglite too for this basic func
// If not, import { primaryKey as pglitePrimaryKey } from 'drizzle-orm/pglite-core';

const factory = getSchemaFactory();

export const channelParticipantsTable = (factory.table as any)(
  'channel_participants',
  {
    channelId: factory
      .text('channel_id')
      .notNull()
      .references(() => channelTable.id, { onDelete: 'cascade' }),
    userId: factory.text('user_id').notNull(), // This is a central UUID (can be an agentId or a dedicated central user ID)
  },
  (table) => ({
    // primaryKey from drizzle-orm directly might be okay if its signature is general enough.
    // Or, the factory should provide `factory.primaryKey`
    pk: primaryKey({ columns: [table.channelId, table.userId] }),
  })
);
