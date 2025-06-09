import { pgTable, text, primaryKey } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { messageServerTable } from './messageServer';

export const serverUserTable = pgTable(
  'server_users',
  {
    serverId: text('server_id')
      .notNull()
      .references(() => messageServerTable.id, { onDelete: 'cascade' }),
    userId: text('agent_id').notNull(), // This is the agent's UUID
  },
  (table) => ({
    pk: primaryKey({ columns: [table.serverId, table.userId] }),
  })
);
