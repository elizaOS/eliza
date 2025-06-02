import { getSchemaFactory } from './factory';
import { messageServerTable } from './messageServer';
import { primaryKey } from 'drizzle-orm/pg-core';

const factory = getSchemaFactory();

export const serverAgentsTable = (factory.table as any)(
  'server_agents',
  {
    serverId: factory
      .text('server_id')
      .notNull()
      .references(() => messageServerTable.id, { onDelete: 'cascade' }),
    agentId: factory.text('agent_id').notNull(), // This is the agent's UUID
  },
  (table) => ({
    pk: primaryKey({ columns: [table.serverId, table.agentId] }),
  })
);
