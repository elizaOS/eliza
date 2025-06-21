import { VECTOR_DIMS } from '@elizaos/core';
import { sql } from 'drizzle-orm';
import { memoryTable } from './memory';
import { getSchemaFactory } from './factory';

export const DIMENSION_MAP = {
  [VECTOR_DIMS.SMALL]: 'dim384',
  [VECTOR_DIMS.MEDIUM]: 'dim512',
  [VECTOR_DIMS.LARGE]: 'dim768',
  [VECTOR_DIMS.XL]: 'dim1024',
  [VECTOR_DIMS.XXL]: 'dim1536',
  [VECTOR_DIMS.XXXL]: 'dim3072',
} as const;

/**
 * Lazy-loaded embedding table definition.
 * This function returns the embedding table schema when called,
 * ensuring the database type is set before schema creation.
 */
function createEmbeddingTable() {
  const factory = getSchemaFactory();

  return factory.table(
    'embeddings',
    {
      id: (() => {
        const defaultUuid = factory.defaultRandomUuid();
        const column = factory.uuid('id').primaryKey().notNull();
        return defaultUuid ? column.default(defaultUuid) : column;
      })(),
      memoryId: factory.uuid('memory_id').references(() => memoryTable.id, { onDelete: 'cascade' }),
      createdAt: factory.timestamp('created_at').default(factory.defaultTimestamp()).notNull(),
      dim384: factory.vector('dim_384', VECTOR_DIMS.SMALL),
      dim512: factory.vector('dim_512', VECTOR_DIMS.MEDIUM),
      dim768: factory.vector('dim_768', VECTOR_DIMS.LARGE),
      dim1024: factory.vector('dim_1024', VECTOR_DIMS.XL),
      dim1536: factory.vector('dim_1536', VECTOR_DIMS.XXL),
      dim3072: factory.vector('dim_3072', VECTOR_DIMS.XXXL),
    },
    (table) => [
      factory.check('embedding_source_check', sql`"memory_id" IS NOT NULL`),
      factory.index('idx_embedding_memory').on(table.memoryId),
      factory
        .foreignKey({
          name: 'fk_embedding_memory',
          columns: [table.memoryId],
          foreignColumns: [memoryTable.id],
        })
        .onDelete('cascade'),
    ]
  );
}

// Cache the table once created
let _embeddingTable: any = null;

/**
 * Represents the embedding table in the database.
 * Uses lazy initialization to ensure proper database type configuration.
 */
export const embeddingTable = new Proxy({} as any, {
  get(target, prop, receiver) {
    if (!_embeddingTable) {
      _embeddingTable = createEmbeddingTable();
    }
    return Reflect.get(_embeddingTable, prop, receiver);
  },
});

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
