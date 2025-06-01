import { pgTable, text, primaryKey } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { channelTable } from './channelTable';

// Assuming you might have a central user table in the future, or use agent IDs directly
// import { centralUserTable } from './centralUserTable';

export const channelParticipantsTable = pgTable(
  'channel_participants',
  {
    channelId: text('channel_id')
      .notNull()
      .references(() => channelTable.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(), // This is a central UUID (can be an agentId or a dedicated central user ID)
    // Add other participant-specific info if needed, e.g., role, joined_at
  },
  (table) => ({
    pk: primaryKey(table.channelId, table.userId),
  })
);

export const channelParticipantsRelations = relations(channelParticipantsTable, ({ one }) => ({
  channel: one(channelTable, {
    fields: [channelParticipantsTable.channelId],
    references: [channelTable.id],
  }),
  // user: one(centralUserTable, { // If you have a central user table
  //   fields: [channelParticipantsTable.userId],
  //   references: [centralUserTable.id],
  // }),
}));
