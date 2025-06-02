import { sql } from 'drizzle-orm';
import { getSchemaFactory } from './factory';
import { agentTable } from './agent';
import { entityTable } from './entity';
import { numberTimestamp } from './types';
import {
  unique as pgUnique,
  index as pgIndex,
  foreignKey as pgForeignKey,
} from 'drizzle-orm/pg-core';
import {
  uniqueIndex as sqliteUniqueIndex,
  index as sqliteIndex,
  foreignKey as sqliteForeignKey,
} from 'drizzle-orm/sqlite-core';

const factory = getSchemaFactory();

/**
 * Defines the relationshipTable containing information about relationships between entities and agents.
 * @type {import('knex').TableBuilder}
 */
export const relationshipTable = (factory.table as any)(
  'relationships',
  {
    id: factory
      .uuid('id')
      .notNull()
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    createdAt: numberTimestamp('createdAt')
      .notNull()
      .$defaultFn(() => Date.now()),
    sourceEntityId: factory
      .uuid('sourceEntityId')
      .notNull()
      .references(() => entityTable.id, { onDelete: 'cascade' }),
    targetEntityId: factory
      .uuid('targetEntityId')
      .notNull()
      .references(() => entityTable.id, { onDelete: 'cascade' }),
    agentId: factory
      .uuid('agentId')
      .notNull()
      .references(() => agentTable.id, { onDelete: 'cascade' }),
    tags: factory.textArray('tags'),
    metadata: factory.json('metadata'),
  },
  (table) => {
    const constraints: any = {};
    if (factory.dbType === 'postgres') {
      constraints.idx_relationships_users = pgIndex('idx_relationships_users').on(
        table.sourceEntityId,
        table.targetEntityId
      );
      constraints.unique_relationship = pgUnique('unique_relationship').on(
        table.sourceEntityId,
        table.targetEntityId,
        table.agentId
      );
      constraints.fk_user_a = pgForeignKey({
        name: 'fk_user_a',
        columns: [table.sourceEntityId],
        foreignColumns: [entityTable.id],
      }).onDelete('cascade');
      constraints.fk_user_b = pgForeignKey({
        name: 'fk_user_b',
        columns: [table.targetEntityId],
        foreignColumns: [entityTable.id],
      }).onDelete('cascade');
    } else {
      constraints.idx_relationships_users = sqliteIndex('idx_relationships_users_sqlite').on(
        table.sourceEntityId,
        table.targetEntityId
      );
      constraints.unique_relationship = sqliteUniqueIndex('unique_relationship_sqlite').on(
        table.sourceEntityId,
        table.targetEntityId,
        table.agentId
      );
    }
    return constraints;
  }
);
