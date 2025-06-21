import { getSchemaFactory, createLazyTableProxy } from './factory';
import { agentTable } from './agent';
import { messageServerTable } from './messageServer';

/**
 * Lazy-loaded channel table definition.
 * This function returns the channel table schema when called,
 * ensuring the database type is set before schema creation.
 */
function createChannelTable() {
  const factory = getSchemaFactory();

  return factory.table('channels', {
    id: factory.uuid('id').primaryKey().notNull(),
    agentId: factory
      .uuid('agent_id')
      .notNull()
      .references(() => agentTable.id, { onDelete: 'cascade' }),
    serverId: factory
      .uuid('server_id')
      .notNull()
      .references(() => messageServerTable.id, { onDelete: 'cascade' }),
    createdAt: factory.timestamp('created_at').notNull().default(factory.defaultTimestamp()),
    name: factory.text('name').notNull(),
    type: factory.text('type').notNull(),
    metadata: factory.json('metadata').default(factory.defaultJsonObject()).notNull(),
  });
}

/**
 * Represents a channel table in the database.
 * Uses lazy initialization to ensure proper database type configuration.
 */
export const channelTable = createLazyTableProxy(createChannelTable);
