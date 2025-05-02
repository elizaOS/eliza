import { sql } from 'drizzle-orm';
import { foreignKey, index, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { mysqlVectorNative } from './types';
import { VECTOR_DIMS } from '@elizaos/core';
import { memoryTable } from './memory';
import { numberTimestamp } from './types';
import { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import type { UUID } from '@elizaos/core';

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
 * Contains columns for ID, Memory ID, Creation Timestamp, and multiple vector dimensions
 * stored in JSON columns using a custom type for handling.
 */
export const embeddingTable = mysqlTable(
  'embeddings',
  {
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`(UUID())`)
      .notNull(),
    memoryId: varchar('memory_id', { length: 36 }).references(() => memoryTable.id),
    createdAt: numberTimestamp('created_at')
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    // Use the custom type for each dimension column
    dim384: mysqlVectorNative('dim_384', { dimensions: 384 }),
    dim512: mysqlVectorNative('dim_512', { dimensions: 512 }),
    dim768: mysqlVectorNative('dim_768', { dimensions: 768 }),
    dim1024: mysqlVectorNative('dim_1024', { dimensions: 1024 }),
    dim1536: mysqlVectorNative('dim_1536', { dimensions: 1536 }),
    dim3072: mysqlVectorNative('dim_3072', { dimensions: 3072 }),
  },
  (table) => [
    // MySQL doesn't support check constraints in the same way as PostgreSQL
    // We may need to enforce these constraints at the application level
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

// Inferred database model types from the embedding table schema
export type SelectEmbedding = InferSelectModel<typeof embeddingTable>;
export type InsertEmbedding = InferInsertModel<typeof embeddingTable>;

/**
 * Represents an embedding in the application
 */
export interface Embedding {
  id: UUID;
  memoryId: UUID;
  createdAt: number;
  dim384?: number[];
  dim512?: number[];
  dim768?: number[];
  dim1024?: number[];
  dim1536?: number[];
  dim3072?: number[];
}

/**
 * Maps a database embedding to the application embedding model
 */
export function mapToEmbedding(embeddingRow: SelectEmbedding): Embedding {
  return {
    id: embeddingRow.id as UUID,
    memoryId: embeddingRow.memoryId as UUID,
    createdAt: embeddingRow.createdAt,
    dim384: Array.isArray(embeddingRow.dim384) ? embeddingRow.dim384 : undefined,
    dim512: Array.isArray(embeddingRow.dim512) ? embeddingRow.dim512 : undefined,
    dim768: Array.isArray(embeddingRow.dim768) ? embeddingRow.dim768 : undefined,
    dim1024: Array.isArray(embeddingRow.dim1024) ? embeddingRow.dim1024 : undefined,
    dim1536: Array.isArray(embeddingRow.dim1536) ? embeddingRow.dim1536 : undefined,
    dim3072: Array.isArray(embeddingRow.dim3072) ? embeddingRow.dim3072 : undefined,
  };
}

/**
 * Maps an application embedding to its database representation
 */
export function mapToEmbeddingRow(embedding: Partial<Embedding>): InsertEmbedding {
  const result: Partial<InsertEmbedding> = {};

  if (embedding.id !== undefined) result.id = embedding.id;
  if (embedding.memoryId !== undefined) result.memoryId = embedding.memoryId;
  if (embedding.createdAt !== undefined) result.createdAt = embedding.createdAt;
  if (embedding.dim384 !== undefined) result.dim384 = embedding.dim384;
  if (embedding.dim512 !== undefined) result.dim512 = embedding.dim512;
  if (embedding.dim768 !== undefined) result.dim768 = embedding.dim768;
  if (embedding.dim1024 !== undefined) result.dim1024 = embedding.dim1024;
  if (embedding.dim1536 !== undefined) result.dim1536 = embedding.dim1536;
  if (embedding.dim3072 !== undefined) result.dim3072 = embedding.dim3072;

  return result as InsertEmbedding;
}
