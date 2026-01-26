import type { UUID } from '@elizaos/core';
import type { EmbeddingDimensionColumn } from '../schema/embedding';
import type { DrizzleDatabase } from '../types';

/**
 * Context passed to all stores for database operations.
 * Stores don't manage connections - they receive a context from the adapter.
 */
export interface StoreContext {
  /** Get the database instance (may be a transaction) */
  getDb: () => DrizzleDatabase;
  /** Execute operation with retry logic (context is for logging, ignored by adapter) */
  withRetry: <T>(operation: () => Promise<T>, context?: string) => Promise<T>;
  /** Execute operation within RLS isolation context */
  withIsolationContext: <T>(
    entityId: UUID | null,
    callback: (tx: DrizzleDatabase) => Promise<T>
  ) => Promise<T>;
  /** Current agent ID */
  agentId: UUID;
  /** Get current embedding dimension column (dynamic to reflect runtime changes) */
  getEmbeddingDimension: () => EmbeddingDimensionColumn;
}

/**
 * Base interface for all domain stores.
 */
export interface Store {
  readonly ctx: StoreContext;
}
