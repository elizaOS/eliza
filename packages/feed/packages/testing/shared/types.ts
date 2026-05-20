/**
 * Shared Types for Test Files
 *
 * Centralized type definitions for all test files to ensure consistency
 * and eliminate use of 'any' types.
 */

import type { Database, JsonValue } from "@feed/db";
import type { Page, Route } from "@playwright/test";

/**
 * Experience record from queryExperiences
 */
export interface ExperienceRecord {
  id: string;
  type: string;
  outcome: string;
  context: string;
  action: string;
  result: string;
  learning: string;
  domain: string;
  tags: string[];
  confidence: number;
  importance: number;
  similarity?: number;
  timestamp?: Date;
}

/**
 * Market gainer/loser data for provider results
 */
export interface MarketMovement {
  id: string;
  ticker?: string;
  name?: string;
  price?: number;
  change?: number;
  changePercent?: number;
  volume?: number;
}

/**
 * Trajectory record from database
 */
export interface TrajectoryRecord {
  trajectoryId: string;
  agentId: string;
  status: string;
  createdAt: Date;
  updatedAt?: Date;
  stepCount?: number;
  totalReward?: number;
}

/**
 * LLM call aggregate result
 */
export interface LLMCallAggregate {
  _count: number;
  _avg?: { latencyMs: number | null };
  _sum?: { promptTokens: number | null; completionTokens: number | null };
}

/**
 * Simulation tick event
 */
export interface SimulationTick {
  tick: number;
  timestamp: number;
  events: Array<{ type: string; data: JsonValue }>;
}

/**
 * Simulation market state
 */
export interface SimulationMarket {
  id: string;
  question?: string;
  ticker?: string;
  price?: number;
  yesPrice?: number;
  noPrice?: number;
  volume?: number;
}

/**
 * Simulation agent state
 */
export interface SimulationAgent {
  id: string;
  balance: number;
  positions?: Array<{ marketId: string; size: number; side: string }>;
}

/**
 * Optimal action from ground truth
 */
export interface OptimalAction {
  tick: number;
  action: string;
  marketId?: string;
  expectedValue?: number;
}

/**
 * Price history entry
 */
export interface PriceHistoryEntry {
  timestamp: number;
  price: number;
  volume?: number;
}

/**
 * Trajectory state snapshot
 */
export interface TrajectoryState {
  tick: number;
  balance: number;
  positions: Array<{ marketId: string; size: number; pnl: number }>;
  timestamp: number;
}

/**
 * Trajectory action record
 */
export interface TrajectoryAction {
  tick: number;
  type: string;
  marketId?: string;
  amount?: number;
  side?: string;
  success: boolean;
}

/**
 * Trajectory reward record
 */
export interface TrajectoryReward {
  tick: number;
  reward: number;
  source: string;
}

/**
 * Playwright Page type (re-exported for convenience)
 */
export type TestPage = Page;

/**
 * Playwright Route type (re-exported for convenience)
 */
export type TestRoute = Route;

/**
 * Error with message property
 */
export interface ErrorWithMessage {
  message: string;
  code?: number | string;
  stack?: string;
  name?: string;
  cause?: Error | string;
}

/**
 * Check if error has message property
 */
export function isErrorWithMessage(error: unknown): error is ErrorWithMessage {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as ErrorWithMessage).message === "string"
  );
}

/**
 * A2A Client Error
 */
export interface A2AClientError extends Error {
  code?: number;
  data?: JsonValue;
}

/**
 * Test User type
 */
export interface TestUser {
  id: string;
  username: string;
  displayName: string;
  email?: string;
  walletAddress?: string;
  privyId?: string;
  bio?: string;
  reputationPoints?: number;
  virtualBalance?: number;
  isAgent?: boolean;
  isActor?: boolean;
  isAdmin?: boolean;
  isBanned?: boolean;
  isTest?: boolean;
  profileComplete?: boolean;
  hasUsername?: boolean;
  updatedAt?: Date;
  createdAt?: Date;
}

/**
 * Test Actor type
 */
export interface TestActor {
  id: string;
  name: string;
  realName?: string;
  username?: string;
  description?: string;
}

/**
 * Experience Service type
 */
export interface ExperienceService {
  recordExperience: (data: {
    type: string;
    outcome: string;
    context: string;
    action: string;
    result: string;
    learning: string;
    domain: string;
    tags: string[];
    confidence: number;
    importance: number;
  }) => Promise<{ id: string; learning: string }>;
  queryExperiences: (query: {
    query: string;
    limit: number;
  }) => Promise<ExperienceRecord[]>;
}

/**
 * Memory Service interface for agent memory operations
 */
export interface MemoryService {
  recall: (query: {
    query: string;
    limit: number;
  }) => Promise<Array<{ content: string; similarity: number }>>;
  store: (data: { content: string; type: string }) => Promise<{ id: string }>;
}

/**
 * Runtime Service type
 * Services that can be registered with the agent runtime
 */
export type RuntimeService = ExperienceService | MemoryService;

/**
 * Provider Result type
 * Note: Using Record<string, JsonValue> for data to avoid index signature conflicts
 */
export interface ProviderResult {
  text?: string;
  data?: Record<string, JsonValue>;
}

/**
 * Message content type for agent messages
 */
export interface MessageContent {
  text: string;
  attachments?: Array<{ type: string; url: string }>;
  metadata?: Record<string, JsonValue>;
}

/**
 * Message type for agent runtime
 */
export interface AgentMessage {
  userId: string;
  agentId: string;
  content: MessageContent;
  roomId?: string;
  timestamp?: number;
  messageId?: string;
}

/**
 * Trajectory query args
 */
export interface TrajectoryQueryArgs {
  where?: {
    agentId?: string;
    status?: string;
    trajectoryId?: string | { in: string[] };
  };
  orderBy?: { createdAt?: "asc" | "desc" };
  take?: number;
  skip?: number;
}

/**
 * LLM call log query args
 */
export interface LLMCallLogQueryArgs {
  where?: { trajectoryId?: string };
  _count?: boolean;
  _avg?: { latencyMs: boolean };
  _sum?: { promptTokens: boolean; completionTokens: boolean };
}

/**
 * Database client with extended types for testing
 */
export type TestDatabase = Database & {
  trajectory?: {
    count: () => Promise<number>;
    findMany: (args: TrajectoryQueryArgs) => Promise<TrajectoryRecord[]>;
    findUnique: (args: {
      where: { trajectoryId: string };
    }) => Promise<TrajectoryRecord | null>;
    delete: (args: {
      where: { trajectoryId: string };
    }) => Promise<TrajectoryRecord>;
    deleteMany: (args: {
      where: { trajectoryId: { in: string[] } };
    }) => Promise<{ count: number }>;
    groupBy: (
      args: TrajectoryQueryArgs & { by: string[] },
    ) => Promise<Array<{ agentId: string; _count: number }>>;
  };
  llmCallLog?: {
    deleteMany: (args: {
      where: { trajectoryId: string };
    }) => Promise<{ count: number }>;
    aggregate: (args: LLMCallLogQueryArgs) => Promise<LLMCallAggregate>;
  };
};

/**
 * Route handler function type
 */
export type RouteHandler = (route: Route) => void | Promise<void>;

/**
 * Route fulfillment options
 */
export interface RouteFulfillOptions {
  status?: number;
  contentType?: string;
  body?: string;
  headers?: Record<string, string>;
}

/**
 * Mock API response
 */
export interface MockAPIResponse<T = JsonValue> {
  success?: boolean;
  data?: T;
  error?: string;
  message?: string;
  statusCode?: number;
  timestamp?: string;
}

/**
 * Block entry for A2A request result
 */
export interface BlockEntry {
  id: string;
  blockedId: string;
  blockerId: string;
  reason?: string;
  createdAt: string;
}

/**
 * Mute entry for A2A request result
 */
export interface MuteEntry {
  id: string;
  mutedId: string;
  muterId: string;
  reason?: string;
  createdAt: string;
}

/**
 * Report entry for A2A request result
 */
export interface ReportEntry {
  id: string;
  reporterId: string;
  reportedUserId?: string;
  reportedPostId?: string;
  category: string;
  reason: string;
  status: string;
  priority: string;
  createdAt: string;
}

/**
 * Pagination info for A2A request result
 */
export interface PaginationInfo {
  total: number;
  limit: number;
  offset: number;
  hasMore?: boolean;
}

/**
 * A2A Request Result
 */
export interface A2ARequestResult {
  success: boolean;
  message: string;
  block?: BlockEntry;
  mute?: MuteEntry;
  report?: ReportEntry;
  isBlocked?: boolean;
  isMuted?: boolean;
  blocks?: BlockEntry[];
  mutes?: MuteEntry[];
  pagination?: PaginationInfo;
}

/**
 * Benchmark Config
 */
export interface BenchmarkConfig {
  durationMinutes: number;
  tickInterval: number;
  numPredictionMarkets: number;
  numPerpetualMarkets: number;
  numAgents: number;
  seed: number;
}

/**
 * Simulation Config
 */
export interface SimulationConfig {
  snapshot: {
    id: string;
    version: string;
    duration: number;
    ticks: SimulationTick[];
    initialState: {
      predictionMarkets: SimulationMarket[];
      perpetualMarkets: SimulationMarket[];
      agents: SimulationAgent[];
    };
    groundTruth: {
      marketOutcomes: Record<string, boolean>;
      priceHistory: Record<string, PriceHistoryEntry[]>;
      optimalActions: OptimalAction[];
    };
  };
  agentId: string;
  fastForward?: boolean;
  responseTimeout?: number;
}

/**
 * Perp metrics for simulation
 */
export interface PerpMetrics {
  totalTrades: number;
  profitableTrades: number;
  totalPnl: number;
  avgLeverage: number;
}

/**
 * Social metrics for simulation
 */
export interface SocialMetrics {
  postsCreated: number;
  commentsCreated: number;
  likesReceived: number;
  engagementScore: number;
}

/**
 * Timing metrics for simulation
 */
export interface TimingMetrics {
  avgResponseMs: number;
  maxResponseMs: number;
  totalTimeMs: number;
}

/**
 * Simulation Result
 */
export interface SimulationResult {
  id: string;
  agentId: string;
  benchmarkId: string;
  ticksProcessed: number;
  actions: Array<{
    type: string;
    marketId?: string;
    amount?: number;
    side?: string;
    timestamp?: number;
  }>;
  metrics: {
    totalPnl: number;
    predictionMetrics: {
      totalPositions: number;
      correctPredictions: number;
      accuracy: number;
      avgConfidence?: number;
      bestPrediction?: string;
    };
    perpMetrics: PerpMetrics;
    socialMetrics: SocialMetrics;
    timing: TimingMetrics;
    optimalityScore: number;
    riskAdjustedReturn?: number;
  };
  trajectory: {
    states: TrajectoryState[];
    actions: TrajectoryAction[];
    rewards: TrajectoryReward[];
    windowId: string;
    episodeId?: string;
  };
}

/**
 * Feedback Metadata
 */
export interface FeedbackMetadata {
  profitable?: boolean;
  autoGenerated?: boolean;
  won?: boolean;
  pnl?: number;
  confidence?: number;
  source?: string;
}

/**
 * Cron Job
 */
export interface CronJob {
  path: string;
  schedule?: string;
  enabled?: boolean;
  lastRun?: string;
  nextRun?: string;
}
