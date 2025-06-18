import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, timestamp, uuid, vector } from 'drizzle-orm/pg-core';
import { VECTOR_DIMS } from '@elizaos/core';
import { memoryTable } from './memory';

export const DIMENSION_MAP = {
  [VECTOR_DIMS.SMALL]: 'dim384',
  [VECTOR_DIMS.MEDIUM]: 'dim512',
  [VECTOR_DIMS.LARGE]: 'dim768',
  [VECTOR_DIMS.XL]: 'dim1024',
  [VECTOR_DIMS.XXL]: 'dim1536',
  [VECTOR_DIMS.XXXL]: 'dim3072',
} as const;

/**
 * Definition of the embeddings table in the database.
 * Contains columns for ID, Memory ID, Creation Timestamp, and multiple vector dimensions.
 */
export const embeddingTable = pgTable(
  'embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom().notNull(),
    memoryId: uuid('memory_id').references(() => memoryTable.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at')
      .default(sql`now()`)
      .notNull(),
    dim384: vector('dim_384', { dimensions: VECTOR_DIMS.SMALL }),
    dim512: vector('dim_512', { dimensions: VECTOR_DIMS.MEDIUM }),
    dim768: vector('dim_768', { dimensions: VECTOR_DIMS.LARGE }),
    dim1024: vector('dim_1024', { dimensions: VECTOR_DIMS.XL }),
    dim1536: vector('dim_1536', { dimensions: VECTOR_DIMS.XXL }),
    dim3072: vector('dim_3072', { dimensions: VECTOR_DIMS.XXXL }),
  },
  (table) => [
    check('embedding_source_check', sql`"memory_id" IS NOT NULL`),
    index('idx_embedding_memory').on(table.memoryId),
    foreignKey({
      name: 'fk_embedding_memory',
      columns: [table.memoryId],
      foreignColumns: [memoryTable.id],
    }).onDelete('cascade'),
  ]
);

/**
 * Defines the possible values for the Embedding Dimension Column.
 * It can be "dim384", "dim512", "dim768", "dim1024", "dim1536", or "dim3072".
 */
export type EmbeddingDimensionColumn =
  | 'dim384'
  | 'dim512'
  | 'dim768'
  | 'dim1024'
  | 'dim1536'
  | 'dim3072';

/**
 * Retrieve the type of a specific column in the EmbeddingTable based on the EmbeddingDimensionColumn key.
 */
export type EmbeddingTableColumn = (typeof embeddingTable._.columns)[EmbeddingDimensionColumn];
