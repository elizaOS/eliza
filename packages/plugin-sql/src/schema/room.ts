import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agentTable } from './agent';

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
export const roomTable = pgTable('rooms', {
  id: uuid('id')
    .notNull()
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  agentId: uuid('agentId').references(() => agentTable.id, {
    onDelete: 'cascade',
  }),
  source: text('source').notNull(),
  type: text('type').notNull(),
  serverId: text('serverId'),
  worldId: uuid('worldId'), // no guarantee that world exists, it is optional for now
  // .references(() => worldTable.id, {
  //   onDelete: 'cascade',
  // }),
  name: text('name'),
  metadata: jsonb('metadata'),
  channelId: text('channelId'),
  createdAt: timestamp('createdAt')
    .default(sql`now()`)
    .notNull(),
});
