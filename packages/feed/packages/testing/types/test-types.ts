/**
 * Shared Type Definitions for Tests
 *
 * Production-ready types to replace all 'any' and 'unknown' usage
 */

import type { TrainedModel, TrainingBatch, Trajectory } from '@babylon/db';

// ============================================================================
// Actors Data Types
// ============================================================================

// Note: ActorData, Organization, and ActorsDatabase should be imported directly from @babylon/shared

// ============================================================================
// Database Mock Types
// ============================================================================

export type MockDbTrajectory = {
  count: () => Promise<number>;
  groupBy: () => Promise<Array<{ scenarioId: string; _count: number }>>;
  findMany: () => Promise<
    Array<Pick<Trajectory, 'trajectoryId' | 'stepsJson'>>
  >;
  updateMany: () => Promise<{ count: number }>;
};

export type MockDbTrainingBatch = {
  create: () => Promise<TrainingBatch>;
  findUnique: (args: {
    where: { batchId: string };
  }) => Promise<TrainingBatch | null>;
  findFirst: () => Promise<TrainingBatch | null>;
  count: () => Promise<number>;
};

export type MockDbTrainedModel = {
  findFirst: () => Promise<TrainedModel | null>;
  create: () => Promise<TrainedModel>;
  count: () => Promise<number>;
};

export type MockDbUser = {
  count: () => Promise<number>;
};

export type MockDatabase = {
  trajectory: MockDbTrajectory;
  trainingBatch: MockDbTrainingBatch;
  trainedModel: MockDbTrainedModel;
  user: MockDbUser;
  $queryRaw: () => Promise<Array<{ result: number }>>;
};

// ============================================================================
// Logger Mock Types
// ============================================================================

export type MockLogger = {
  info: () => void;
  warn: () => void;
  error: () => void;
};

// ============================================================================
// PostHog Types
// ============================================================================

export interface PostHogEvent {
  event: string;
  properties?: Record<string, string | number | boolean | null | undefined>;
}

export interface PostHogConfig {
  respect_dnt?: boolean;
  capture_exceptions?: boolean;
}

export interface PostHogInstance {
  capture: (
    event: string,
    properties?: Record<string, string | number | boolean | null | undefined>
  ) => void;
  config?: PostHogConfig;
}

export interface WindowWithPostHog extends Window {
  __postHogEvents?: PostHogEvent[];
  posthog?: PostHogInstance;
}

// ============================================================================
// MetaMask Types (for Synpress)
// ============================================================================

export interface MetaMask {
  connectToDapp: () => Promise<void>;
  confirmSignature: () => Promise<void>;
}

// ============================================================================
// API Response Types
// ============================================================================

// Note: ApiResponse is now exported from src/types/common.ts
// Import it from there: import type { ApiResponse } from '@/types/common';

export interface PerpetualsData {
  positions: Array<{
    id: string;
    ticker?: string;
    side: string;
    unrealizedPnL: number;
  }>;
  stats: {
    totalPositions: number;
    totalPnL: number;
    totalFunding: number;
  };
}

export interface PredictionsData {
  positions: Array<{
    id: string;
    side: string;
    unrealizedPnL: number;
  }>;
  stats: {
    totalPositions: number;
  };
}

export interface PositionsResponse {
  perpetuals: PerpetualsData;
  predictions: PredictionsData;
}

export type PartialPositionsResponse = {
  perpetuals?: PerpetualsData | null;
  predictions?: PredictionsData | undefined;
};

// ============================================================================
// Actors Index Types (deprecated - kept for backwards compatibility)
// Note: Data is now stored in TypeScript files, not JSON
// ============================================================================

/**
 * Reference to an actor file (deprecated, kept for compatibility)
 */
export interface ActorFileRef {
  id: string;
  file: string;
}

/**
 * Reference to an organization file (deprecated, kept for compatibility)
 */
export interface OrganizationFileRef {
  id: string;
  file: string;
}

/**
 * Structure of the actors index (deprecated, kept for compatibility)
 */
export interface ActorsIndexFile {
  actors: ActorFileRef[];
  organizations: OrganizationFileRef[];
}

// ============================================================================
// Agent Tick API Response Types
// ============================================================================

/**
 * Individual agent result from agent-tick endpoint
 */
export interface AgentTickResultItem {
  agentId: string;
  status: 'success' | 'skipped' | 'error';
  reason?: string;
  actionsExecuted?: number;
  error?: string;
}

/**
 * Full agent-tick API response
 */
export interface AgentTickResponse {
  success: boolean;
  eligible?: number;
  processed: number;
  skippedLocked: number;
  duration?: number;
  totalActions?: number;
  errors?: string[];
  results?: AgentTickResultItem[];
  skipped?: boolean;
  reason?: string;
}

// ============================================================================
// Agent Discovery Types (for E2E tests)
// ============================================================================

/**
 * Discovered agent from discovery endpoint
 */
export interface DiscoveredAgent {
  agentId: string;
  name: string;
  type: string;
  status: string;
  trustLevel: number;
  capabilities?: {
    actions?: string[];
    version?: string;
    skills?: string[];
    domains?: string[];
  };
  endpoint?: string;
  userId?: string | null;
}

// ============================================================================
// Mock Database Types (for unit tests)
// ============================================================================

/**
 * Standard database query result
 */
export interface FindUniqueArgs<T = Record<string, unknown>> {
  where: T;
  select?: Record<string, boolean>;
  include?: Record<string, boolean | object>;
}

/**
 * User find unique args (for user lookup by privyId)
 */
export interface UserFindUniqueArgs {
  where: {
    id?: string;
    privyId?: string;
    walletAddress?: string;
    username?: string;
  };
  select?: Record<string, boolean>;
  include?: Record<string, boolean | object>;
}

/**
 * Mock user database record
 */
export interface MockUserRecord {
  id: string;
  walletAddress: string;
  privyId?: string;
  username?: string;
  displayName?: string | null;
  isAgent?: boolean;
}

/**
 * Standard mock function result type
 */
export type MockFindUniqueResult<T> = T | null;

// ============================================================================
// Viem ABI Types (for contract tests)
// ============================================================================

/**
 * Parsed ABI entry (simplified for mock testing)
 */
export interface ParsedAbiEntry {
  type: string;
  original?: string[];
  name?: string;
  inputs?: Array<{ name: string; type: string }>;
  outputs?: Array<{ name: string; type: string }>;
  stateMutability?: string;
}

/**
 * Viem contract call arguments
 */
export interface ViemContractCallArgs {
  abi: ParsedAbiEntry[];
  address: `0x${string}`;
  functionName: string;
  args?: unknown[];
}

// ============================================================================
// LLM Client Mock Types
// ============================================================================

/**
 * JSON Schema property definition for mock LLM clients
 */
export interface MockJsonSchemaProperty {
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  items?: MockJsonSchemaProperty;
  properties?: Record<string, MockJsonSchemaProperty>;
}

/**
 * JSON Schema for mock LLM clients
 */
export interface MockJSONSchema {
  required?: string[];
  properties?: Record<string, MockJsonSchemaProperty>;
}

// ============================================================================
// Mock Database Client Types (for unit test setup)
// ============================================================================

/**
 * Standard result from a database aggregate operation
 */
export interface MockAggregateResult {
  _count: number;
  _sum: null;
  _avg: null;
  _min: null;
  _max: null;
}

/**
 * Standard mock model methods
 */
export interface MockModelMethods {
  findUnique: () => Promise<{ id: string } | null>;
  findMany: () => Promise<{ id: string }[]>;
  findFirst: () => Promise<{ id: string } | null>;
  count: () => Promise<number>;
  create: () => Promise<{ id: string }>;
  createMany: () => Promise<{ count: number }>;
  update: () => Promise<{ id: string }>;
  updateMany: () => Promise<{ count: number }>;
  upsert: () => Promise<{ id: string }>;
  delete: () => Promise<{ id: string }>;
  deleteMany: () => Promise<{ count: number }>;
  aggregate: () => Promise<MockAggregateResult>;
  groupBy: () => Promise<unknown[]>;
}

/**
 * Transaction callback function type
 * Uses a forward reference for the client type
 */
export type MockTransactionFn = (
  client: Record<string, unknown>
) => Promise<unknown>;

/**
 * Mock database client type for unit tests.
 * Uses Record<string, unknown> to allow dynamic model assignment.
 * Type safety is applied at usage sites through explicit typing.
 */
export type MockDatabaseClient = Record<string, unknown> & {
  $connect: () => Promise<void>;
  $disconnect: () => Promise<void>;
  $queryRaw: () => Promise<unknown[]>;
  $executeRaw: () => Promise<number>;
  $transaction: (fn: MockTransactionFn) => Promise<unknown>;
};
