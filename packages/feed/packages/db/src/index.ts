/**
 * Drizzle ORM Database Client
 *
 * @description Complete database abstraction layer using Drizzle ORM.
 * Pure TypeScript solution that works on all platforms including Apple Silicon.
 *
 * Features:
 * - Connection pooling optimized for serverless
 * - Automatic retry with exponential backoff
 * - Row Level Security (RLS) context support
 * - Query monitoring and performance tracking
 * - Lazy initialization for Edge Runtime compatibility
 * - Familiar ORM-style API for findUnique, findMany, create, update, delete
 */

import * as schema from './schema';

// Re-export client types
export type { DrizzleClient, JsonValue, SQLValue } from './client';
export { TableRepository } from './client';
// Database runtime (connection management, `db`, JSON mode)
// We use both "export *" and explicit import-then-export for the same symbols.
// This dual approach is necessary because some runtimes (particularly Bun in CI)
// don't reliably resolve symbols from barrel files with only "export *".
// See: https://github.com/oven-sh/bun/issues/4552 (barrel file re-export issues)
export * from './db';
// Re-export everything from schema
export * from './schema';
export { schema };

// Import-then-export so runtimes (e.g. Bun in CI) resolve these reliably from the barrel
//
// MIGRATION GUIDE for deprecated functions:
// - onReadReplica(query) -> Use dbRead directly: dbRead.select()...
// - onReadReplicaClient  -> Use dbRead (it's the read replica client)
// These deprecated functions remain accessible via "export * from './db'" for backward
// compatibility but will be removed in a future major version.
import {
  asPublic,
  asSystem,
  asUser,
  db,
  dbRead,
  dbWrite,
  getJsonState,
  getJsonStoragePath,
  getStorageMode,
} from './db';

export * from './balance-transaction-classification';
/**
 * Re-export unique relation types from model-types.
 *
 * Base types (User, Actor, etc.) are already exported from schema.
 */
export type {
  ActorRef,
  ActorStateRow,
  AgentGoalWithActions,
  BalanceTransactionWithUser,
  ChatWithParticipants,
  ChatWithParticipantsAndMessages,
  ChatWithRelations,
  ExternalAgentConnectionWithRegistry,
  MessageWithSender,
  ModerationEscrowWithRelations,
  NewActorStateRow,
  PoolWithActorState,
  PostWithRelations,
  TradingFeeWithUser,
  UserWithAgentRelations,
  UserWithMetrics,
} from './model-types';
// Re-export types
export * from './types';
export {
  asPublic,
  asSystem,
  asUser,
  db,
  dbRead,
  dbWrite,
  getJsonState,
  getJsonStoragePath,
  getStorageMode,
};

// ============================================================================
// Drizzle Query Operators
// ============================================================================

// Re-export snowflake utilities from @feed/shared
export {
  generateSnowflakeId,
  isValidSnowflakeId,
  parseSnowflakeId,
  SnowflakeGenerator,
} from '@feed/shared';
export type { SQL } from 'drizzle-orm';
export {
  aliasedTable,
  and,
  asc,
  avg,
  between,
  count,
  desc,
  eq,
  exists,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  max,
  min,
  ne,
  not,
  notExists,
  notInArray,
  or,
  sql,
  sum,
} from 'drizzle-orm';

// Re-export database service (import-then-export for reliable resolution in Bun/CI)
import { DatabaseService, getDbInstance } from './database-service';

export type { FeedPost } from './database-service';
// Re-export query helpers
export {
  $connect,
  $disconnect,
  $executeRaw,
  $queryRaw,
  isRetryableError,
  withRetry,
} from './helpers';
// Re-export moderation filters
export * from './moderation/filters';
// Re-export query monitor
export {
  type QueryMetrics,
  queryMonitor,
  type SlowQueryStats,
} from './query-monitor';
export type { DatabaseErrorType } from './types';
// Re-export error utilities
export { isUniqueConstraintError, toDatabaseErrorType } from './types';
export { DatabaseService, getDbInstance };
