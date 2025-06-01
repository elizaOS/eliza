import { pgTable, text, primaryKey } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { messageServerTable } from './serverTable';

export const serverAgentsTable = pgTable(
  'server_agents',
  {
    serverId: text('server_id')
      .notNull()
      .references(() => messageServerTable.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(), // This is the agent's UUID
    // Add other agent-specific info if needed, e.g., joined_at, permissions
  },
  (table) => ({
    pk: primaryKey(table.serverId, table.agentId),
  })
);

export const serverAgentsRelations = relations(serverAgentsTable, ({ one }) => ({
  server: one(messageServerTable, {
    fields: [serverAgentsTable.serverId],
    references: [messageServerTable.id],
  }),
  // Could add agent relation if we have a central agents table
}));
