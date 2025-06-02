import { sql } from 'drizzle-orm';
import { getSchemaFactory } from './factory';
import { memoryTable } from './memory';
import { numberTimestamp } from './types';
import { VECTOR_DIMS } from '@elizaos/core';
import {
  check as pgCheck,
  foreignKey as pgForeignKey,
  index as pgIndex,
} from 'drizzle-orm/pg-core';
import { index as sqliteIndex, foreignKey as sqliteForeignKey } from 'drizzle-orm/sqlite-core';

const factory = getSchemaFactory();
const tableCreator = factory.table as any;

export const DIMENSION_MAP = {
  [VECTOR_DIMS.SMALL]: 'dim_384',
  [VECTOR_DIMS.MEDIUM]: 'dim_512',
  [VECTOR_DIMS.LARGE]: 'dim_768',
  [VECTOR_DIMS.XL]: 'dim_1024',
  [VECTOR_DIMS.XXL]: 'dim_1536',
  [VECTOR_DIMS.XXXL]: 'dim_3072',
} as const;

/**
 * Definition of the embeddings table in the database.
 * Contains columns for ID, Memory ID, Creation Timestamp, and multiple vector dimensions.
 */
export const embeddingTable = tableCreator(
  'embeddings',
  {
    id: factory
      .uuid('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID())
      .notNull(),
    memoryId: factory.uuid('memory_id').references(() => memoryTable.id, { onDelete: 'cascade' }),
    createdAt: numberTimestamp('created_at').default(factory.defaultTimestamp()).notNull(),
    dim_384: factory.vector('dim_384', VECTOR_DIMS.SMALL),
    dim_512: factory.vector('dim_512', VECTOR_DIMS.MEDIUM),
    dim_768: factory.vector('dim_768', VECTOR_DIMS.LARGE),
    dim_1024: factory.vector('dim_1024', VECTOR_DIMS.XL),
    dim_1536: factory.vector('dim_1536', VECTOR_DIMS.XXL),
    dim_3072: factory.vector('dim_3072', VECTOR_DIMS.XXXL),
  },
  (table) => {
    const constraints: any = {};
    if (factory.dbType === 'postgres') {
      constraints.check = pgCheck('embedding_source_check_pg', sql`"memory_id" IS NOT NULL`);
      constraints.index = pgIndex('idx_embedding_memory_pg').on(table.memoryId);
    } else {
      constraints.index = sqliteIndex('idx_embedding_memory_sqlite').on(table.memoryId);
    }
    return constraints;
  }
);

export type EmbeddingDimensionKey = keyof typeof DIMENSION_MAP;
export type EmbeddingDimensionColumn = (typeof DIMENSION_MAP)[EmbeddingDimensionKey];

export type EmbeddingTableColumnType = (typeof embeddingTable._.columns)[EmbeddingDimensionColumn];
