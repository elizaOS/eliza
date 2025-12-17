import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  vector,
  index,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { VECTOR_DIMS } from '@elizaos/core';

/**
 * Character Lore Table
 * Stores character-specific knowledge entries for RAG-based retrieval
 */
export const lorebookTable = pgTable('lorebook', {
  id: uuid('id').primaryKey(),
  agentId: uuid('agent_id').notNull(),
  loreKey: text('lore_key').notNull(),
  vectorText: text('vector_text').notNull(),
  content: text('content').notNull(),
  metadata: jsonb('metadata').default({}).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * Character Lore Embeddings Table
 * Stores vector embeddings for semantic search with dynamic dimension support
 */
export const lorebookEmbeddingsTable = pgTable(
  'lorebook_embeddings',
  {
    id: uuid('id').primaryKey(),
    loreId: uuid('lore_id')
      .notNull()
      .references(() => lorebookTable.id, { onDelete: 'cascade' }),
    dim384: vector('dim_384', { dimensions: VECTOR_DIMS.SMALL }),
    dim512: vector('dim_512', { dimensions: VECTOR_DIMS.MEDIUM }),
    dim768: vector('dim_768', { dimensions: VECTOR_DIMS.LARGE }),
    dim1024: vector('dim_1024', { dimensions: VECTOR_DIMS.XL }),
    dim1536: vector('dim_1536', { dimensions: VECTOR_DIMS.XXL }),
    dim3072: vector('dim_3072', { dimensions: VECTOR_DIMS.XXXL }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_lore_embedding_lore_id').on(table.loreId),
    foreignKey({
      name: 'fk_lore_embedding_lore',
      columns: [table.loreId],
      foreignColumns: [lorebookTable.id],
    }).onDelete('cascade'),
  ]
);

export const characterLoreSchema = {
  characterLore: lorebookTable,
  characterLoreEmbeddings: lorebookEmbeddingsTable,
};
