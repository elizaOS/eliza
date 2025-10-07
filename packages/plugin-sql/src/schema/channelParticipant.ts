import { pgTable, text, primaryKey } from 'drizzle-orm/pg-core';
import { channelTable } from './channel';

export const channelParticipantsTable = pgTable(
  'channel_participants',
  {
    channelId: text('channel_id')
      .notNull()
      .references(() => channelTable.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(), // This is a central UUID (can be an agentId or a dedicated central user ID)
  },
  (table) => ({
    pk: primaryKey({ columns: [table.channelId, table.userId] }),
  })
);
