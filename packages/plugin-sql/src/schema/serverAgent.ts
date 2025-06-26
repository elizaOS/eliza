import { pgTable, uuid, primaryKey } from 'drizzle-orm/pg-core';
import { messageServerTable } from './messageServer';
import { agentTable } from './agent';

export const serverAgentsTable = pgTable(
  'server_agents',
  {
    serverId: uuid('server_id')
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
