import { pgTable, uuid, primaryKey } from 'drizzle-orm/pg-core';
import { messageServerTable } from './messageServer';
import { agentTable } from './agent';

export const messageServerAgentsTable = pgTable(
  'message_server_agents',
  {
    messageServerId: uuid('message_server_id')
      .notNull()
      .references(() => messageServerTable.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agentTable.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.messageServerId, table.agentId] })]
);
