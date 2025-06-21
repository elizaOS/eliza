import { getSchemaFactory, createLazyTableProxy } from './factory';
import { agentTable } from './agent';
import { entityTable } from './entity';
import { roomTable } from './room';
import { worldTable } from './world';

/**
 * Lazy-loaded tasks table definition.
 * This function returns the tasks table schema when called,
 * ensuring the database type is set before schema creation.
 */
function createTasksTable() {
  const factory = getSchemaFactory();

  return factory.table('tasks', {
    id: factory.uuid('id').primaryKey().notNull(),
    name: factory.text('name').notNull(),
    createdAt: factory.timestamp('createdAt').default(factory.defaultTimestamp()).notNull(),
    updatedAt: factory.timestamp('updatedAt'),
    agentId: factory
      .uuid('agentId')
      .references(() => agentTable.id, { onDelete: 'cascade' })
      .notNull(),
    entityId: factory.uuid('entityId').references(() => entityTable.id, { onDelete: 'cascade' }),
    roomId: factory.uuid('roomId').references(() => roomTable.id, { onDelete: 'cascade' }),
    worldId: factory.uuid('worldId').references(() => worldTable.id, { onDelete: 'cascade' }),
    metadata: factory.json('metadata').default(factory.defaultJsonObject()).notNull(),
    description: factory.text('description').notNull(),
    tags: factory.textArray('tags').default(factory.defaultTextArray()).notNull(),
  });
}

/**
 * Represents the tasks table in the database.
 * Uses lazy initialization to ensure proper database type configuration.
 */
export const tasksTable = createLazyTableProxy(createTasksTable);
