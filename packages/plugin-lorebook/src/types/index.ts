import type { UUID } from '@elizaos/core';

/**
 * Lore entry stored in database
 */
export interface StoredLoreEntry {
  id: UUID;
  agentId: UUID;
  loreKey: string;
  vectorText: string;
  content: string;
  metadata: Record<string, unknown>;
  embedding?: number[];
  similarity?: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Fusion strategy for hybrid search
 */
export type FusionStrategy = 'vector' | 'bm25' | 'hybrid-rrf' | 'hybrid-weighted';

/**
 * Lore retrieval options
 */
export interface LoreRetrievalOptions {
  /** Maximum number of lore entries to retrieve (default: 3-5) */
  topK?: number;

  /** Minimum cosine similarity threshold for vector search (default: 0.75) */
  similarityThreshold?: number;

  /** Whether to include metadata in results */
  includeMetadata?: boolean;

  /** Search fusion strategy (default: 'hybrid-rrf') */
  fusionStrategy?: FusionStrategy;

  /**
   * Alpha parameter for weighted fusion (0-1)
   * - 1.0 = pure vector search
   * - 0.0 = pure BM25
   * - 0.7 = recommended balance (default)
   */
  alpha?: number;

  /**
   * RRF k parameter (default: 60)
   * Controls rank decay. Higher values flatten the curve.
   */
  rrfK?: number;
}

/**
 * Embedding dimension column type mapping
 */
export type EmbeddingDimensionColumn =
  | 'dim384'
  | 'dim512'
  | 'dim768'
  | 'dim1024'
  | 'dim1536'
  | 'dim3072';

/**
 * Dimension map for dynamic embedding support
 */
export const LORE_DIMENSION_MAP: Record<number, EmbeddingDimensionColumn> = {
  384: 'dim384',
  512: 'dim512',
  768: 'dim768',
  1024: 'dim1024',
  1536: 'dim1536',
  3072: 'dim3072',
};
