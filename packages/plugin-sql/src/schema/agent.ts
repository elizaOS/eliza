import type { MessageExample } from '@elizaos/core';
import { sql } from 'drizzle-orm';
import { getSchemaFactory } from './factory';
import { numberTimestamp } from './types';
import { unique as pgUnique } from 'drizzle-orm/pg-core';
import { uniqueIndex as sqliteUniqueIndex } from 'drizzle-orm/sqlite-core';

const factory = getSchemaFactory();

export const agentTable = (factory.table as any)(
  'agents',
  {
    id: factory
      .uuid('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    enabled: factory.boolean('enabled').default(true).notNull(),
    createdAt: numberTimestamp('createdAt').default(factory.defaultTimestamp()).notNull(),
    updatedAt: numberTimestamp('updatedAt').default(factory.defaultTimestamp()).notNull(),
    name: factory.text('name').notNull(),
    username: factory.text('username'),
    system: factory.text('system').default(''),
    bio: factory
      .json('bio')
      .$type<string | string[]>()
      .default(sql`'[]'`),
    messageExamples: factory
      .json('message_examples')
      .$type<MessageExample[][]>()
      .default(sql`'[]'`)
      .notNull(),
    postExamples: factory
      .json('post_examples')
      .$type<string[]>()
      .default(sql`'[]'`)
      .notNull(),
    topics: factory
      .json('topics')
      .$type<string[]>()
      .default(sql`'[]'`)
      .notNull(),
    adjectives: factory
      .json('adjectives')
      .$type<string[]>()
      .default(sql`'[]'`)
      .notNull(),
    knowledge: factory
      .json('knowledge')
      .$type<(string | { path: string; shared?: boolean })[]>()
      .default(sql`'[]'`)
      .notNull(),
    plugins: factory
      .json('plugins')
      .$type<string[]>()
      .default(sql`'[]'`)
      .notNull(),
    settings: factory
      .json('settings')
      .$type<{
        secrets?: { [key: string]: string | boolean | number };
        [key: string]: unknown;
      }>()
      .default(sql`'{}'`)
      .notNull(),
    style: factory
      .json('style')
      .$type<{
        all?: string[];
        chat?: string[];
        post?: string[];
      }>()
      .default(sql`'{}'`)
      .notNull(),
  },
  (table) => {
    if (factory.dbType === 'postgres') {
      return { nameUnique: pgUnique('name_unique').on(table.name) };
    } else {
      return { nameUniqueSqlite: sqliteUniqueIndex('sqlite_agent_name_unique_idx').on(table.name) };
    }
  }
);
