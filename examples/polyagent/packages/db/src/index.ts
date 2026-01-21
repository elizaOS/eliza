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

import * as schema from "./schema";

// Re-export everything from schema
export * from "./schema";
export { schema };

// Re-export client types
export type { DrizzleClient, JsonValue, SQLValue } from "./client";
export { TableRepository } from "./client";
// Database runtime (connection management, `db`, JSON mode)
export * from "./db";
/**
 * Re-export unique relation types from model-types.
 *
 * Base types (User, Actor, etc.) are already exported from schema.
 */
export type {
  ActorRef,
  AgentGoalWithActions,
  BalanceTransactionWithUser,
  ChatWithParticipants,
  ChatWithParticipantsAndMessages,
  ChatWithRelations,
  ExternalAgentConnectionWithRegistry,
  MessageWithSender,
  ModerationEscrowWithRelations,
  NewOrganizationStateRow,
  // Deprecated types kept for backwards compatibility
  OrganizationStateRow,
  PostWithRelations,
  TradingFeeWithUser,
  UserWithAgentRelations,
  UserWithMetrics,
} from "./model-types";
// Re-export types
export * from "./types";

// ============================================================================
// Drizzle Query Operators
// ============================================================================

// Re-export snowflake utilities from @babylon/shared
export {
  generateSnowflakeId,
  isValidSnowflakeId,
  parseSnowflakeId,
  SnowflakeGenerator,
} from "@babylon/shared";
export type { SQL } from "drizzle-orm";
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
} from "drizzle-orm";
// Re-export database service
export {
  DatabaseService,
  type FeedPost,
  getDbInstance,
} from "./database-service";
// Re-export query helpers
export {
  $connect,
  $disconnect,
  $executeRaw,
  $queryRaw,
  isRetryableError,
  withRetry,
} from "./helpers";
// Re-export moderation filters
export * from "./moderation/filters";
// Re-export query monitor
export {
  type QueryMetrics,
  queryMonitor,
  type SlowQueryStats,
} from "./query-monitor";
export type { DatabaseErrorType } from "./types";
// Re-export error utilities
export { isUniqueConstraintError, toDatabaseErrorType } from "./types";
