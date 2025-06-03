import { pgTable, text, primaryKey } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { messageServerTable } from './messageServer';

export const serverAgentsTable = pgTable(
  'server_agents',
  {
    serverId: text('server_id')
      .notNull()
      .references(() => messageServerTable.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(), // This is the agent's UUID
  },
  (table) => ({
    pk: primaryKey({ columns: [table.serverId, table.agentId] }),
  })
);
