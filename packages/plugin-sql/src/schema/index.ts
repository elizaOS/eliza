import { pgTable, uuid, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export { agentTable } from './agent';
export { cacheTable } from './cache';
export { componentTable } from './component';
export { embeddingTable } from './embedding';
export { entityTable } from './entity';
export { logTable } from './log';
export { memoryTable } from './memory';
export { participantTable } from './participant';
export { relationshipTable } from './relationship';
export { roomTable } from './room';
export { worldTable } from './world';
export const taskTable = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  roomId: uuid('room_id'),
  worldId: uuid('world_id'),
  entityId: uuid('entity_id'),
  agentId: uuid('agent_id').notNull(),
  tags: text('tags')
    .array()
    .default(sql`'{}'::text[]`),
  metadata: jsonb('metadata').default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});
