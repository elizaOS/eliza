import type { Agent, UUID, MessageExample } from '@elizaos/core';
import { sql } from 'drizzle-orm';
import { boolean, json, mysqlTable, text, unique, varchar } from 'drizzle-orm/mysql-core';
import { numberTimestamp } from './types';

/**
 * Represents a table for storing agent data.
 */
export const agentTable = mysqlTable(
  'agents',
  {
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`(UUID())`),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: numberTimestamp('createdAt')
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),

    updatedAt: numberTimestamp('updatedAt')
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),

    // Character
    name: varchar('name', { length: 255 }),
    username: varchar('username', { length: 255 }),
    system: text('system'),
    bio: json('bio').$type<string | string[]>().notNull(),
    messageExamples: json('message_examples')
      .$type<MessageExample[][]>()
      .default(sql`('[]')`),
    postExamples: json('post_examples')
      .$type<string[]>()
      .default(sql`('[]')`),
    topics: json('topics')
      .$type<string[]>()
      .default(sql`('[]')`),
    adjectives: json('adjectives')
      .$type<string[]>()
      .default(sql`('[]')`),
    knowledge: json('knowledge')
      .$type<(string | { path: string; shared?: boolean })[]>()
      .default(sql`('[]')`),
    plugins: json('plugins')
      .$type<string[]>()
      .default(sql`('[]')`),
    settings: json('settings')
      .$type<{
        [key: string]: any | string | boolean | number;
      }>()
      .default(sql`('{}')`),
    style: json('style')
      .$type<{
        all?: string[];
        chat?: string[];
        post?: string[];
      }>()
      .default(sql`('{}')`),
  },
  (table) => [unique('name_unique').on(table.name)]
);

// Using modern type inference with $ prefix
export type SelectAgent = typeof agentTable.$inferSelect;
export type InsertAgent = typeof agentTable.$inferInsert;

// Type mapping utility to convert between Drizzle and Core types
export function mapToAgent(agentRow: SelectAgent): Agent {
  // Explicit mapping of properties ensures type safety
  return {
    id: agentRow.id as UUID, // Cast to ensure UUID type compatibility
    name: agentRow.name || '',
    username: agentRow.username || undefined,
    system: agentRow.system || undefined,
    bio: typeof agentRow.bio === 'string' || Array.isArray(agentRow.bio) ? agentRow.bio : '',
    messageExamples: Array.isArray(agentRow.messageExamples) ? agentRow.messageExamples : [],
    postExamples: Array.isArray(agentRow.postExamples) ? agentRow.postExamples : [],
    topics: Array.isArray(agentRow.topics) ? agentRow.topics : [],
    adjectives: Array.isArray(agentRow.adjectives) ? agentRow.adjectives : [],
    knowledge: Array.isArray(agentRow.knowledge) ? agentRow.knowledge : [],
    plugins: Array.isArray(agentRow.plugins) ? agentRow.plugins : [],
    settings:
      typeof agentRow.settings === 'object' && agentRow.settings !== null ? agentRow.settings : {},
    style: typeof agentRow.style === 'object' && agentRow.style !== null ? agentRow.style : {},
    enabled: Boolean(agentRow.enabled),
    createdAt: Number(agentRow.createdAt),
    updatedAt: Number(agentRow.updatedAt),
  };
}

export function mapToAgentRow(agent: Partial<Agent>): InsertAgent {
  // Return a properly typed object with only the properties
  // that are defined in the database schema
  const result: Partial<InsertAgent> = {};

  // Only copy properties that exist in the agent
  if (agent.id !== undefined) result.id = agent.id;
  if (agent.name !== undefined) result.name = agent.name;
  if (agent.username !== undefined) result.username = agent.username;
  if (agent.system !== undefined) result.system = agent.system;
  if (agent.bio !== undefined) result.bio = agent.bio;
  if (agent.messageExamples !== undefined) result.messageExamples = agent.messageExamples;
  if (agent.postExamples !== undefined) result.postExamples = agent.postExamples;
  if (agent.topics !== undefined) result.topics = agent.topics;
  if (agent.adjectives !== undefined) result.adjectives = agent.adjectives;
  if (agent.knowledge !== undefined)
    result.knowledge = agent.knowledge as (string | { path: string; shared?: boolean })[];
  if (agent.plugins !== undefined) result.plugins = agent.plugins;
  if (agent.settings !== undefined) result.settings = agent.settings;
  if (agent.style !== undefined) result.style = agent.style;
  if (agent.enabled !== undefined) result.enabled = agent.enabled;
  if (agent.createdAt !== undefined) result.createdAt = agent.createdAt;
  if (agent.updatedAt !== undefined) result.updatedAt = agent.updatedAt;

  return result as InsertAgent;
}
