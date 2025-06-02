import { sql } from 'drizzle-orm';
import { getSchemaFactory } from './factory';
import { agentTable } from './agent';
import { numberTimestamp } from './types';
import { worldTable } from './world'; // worldTable should now be factory-aware

const factory = getSchemaFactory();

/**
 * Defines a table schema for 'rooms' in the database.
 *
 * @typedef {object} RoomTable
 * @property {string} id - The unique identifier for the room.
 * @property {string} agentId - The UUID of the agent associated with the room.
 * @property {string} source - The source of the room.
 * @property {string} type - The type of the room.
 * @property {string} serverId - The server ID of the room.
 * @property {string} worldId - The UUID of the world associated with the room.
 * @property {string} name - The name of the room.
 * @property {object} metadata - Additional metadata for the room in JSON format.
 * @property {string} channelId - The channel ID of the room.
 * @property {number} createdAt - The timestamp of when the room was created.
 */
export const roomTable = (factory.table as any)('rooms', {
  id: factory
    .uuid('id')
    .notNull()
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  agentId: factory.uuid('agentId').references(() => agentTable.id, {
    onDelete: 'cascade',
  }),
  source: factory.text('source').notNull(),
  type: factory.text('type').notNull(),
  serverId: factory.text('serverId'),
  worldId: factory.uuid('worldId').references(() => worldTable.id, {
    onDelete: 'cascade',
  }),
  name: factory.text('name'),
  metadata: factory.json('metadata'),
  channelId: factory.text('channelId'),
  createdAt: numberTimestamp('createdAt')
    .notNull()
    .$defaultFn(() => Date.now()),
});
