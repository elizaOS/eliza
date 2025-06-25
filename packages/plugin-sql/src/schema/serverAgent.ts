import { pgTable, uuid, primaryKey, text } from 'drizzle-orm/pg-core';
import { messageServerTable } from './messageServer';
import { agentTable } from './agent';

export const serverAgentsTable = pgTable(
  'server_agents',
  {
    serverId: text('server_id')
      .notNull()
      .references(() => messageServerTable.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agentTable.id, { onDelete: 'cascade' }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.serverId, table.agentId] }),
  })
);
