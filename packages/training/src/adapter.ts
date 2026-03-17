/**
 * Training Data Adapter
 *
 * Abstracts all database operations so the training package has zero direct
 * database imports. Consumers provide an implementation of ITrainingDataAdapter
 * that maps to their specific database (Drizzle, Prisma, raw SQL, etc.).
 *
 * @packageDocumentation
 */

// ─── Local type replacements ────────────────────────────────────────────

/**
 * JSON-serializable value. Replaces `JsonValue` from `@elizaos/shared`.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * UUID-like string identifier.
 */
export type UUID = string & { readonly __brand: "UUID" };

// ─── Record types (replace schema-derived types from @elizaos/db) ───────

export interface TrajectoryRecord {
  id: string;
  trajectoryId: string;
  agentId: string;
  archetype: string | null;
  startTime: Date;
  endTime: Date;
  durationMs: number;
  windowId: string | null;
  windowHours: number;
  episodeId: string | null;
  scenarioId: string | null;
  batchId: string | null;
  stepsJson: string;
  rewardComponentsJson: string;
  metricsJson: string;
  metadataJson: string;
  totalReward: number;
  episodeLength: number;
  finalStatus: string;
  finalBalance: number | null;
  finalPnL: number | null;
  tradesExecuted: number | null;
  postsCreated: number | null;
  aiJudgeReward: number | null;
  aiJudgeReasoning: string | null;
  judgedAt: Date | null;
  isTrainingData: boolean;
  isEvaluation: boolean;
  usedInTraining: boolean;
  trainedInBatch: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TrainedModelRecord {
  id: string;
  modelId: string;
  version: string;
  baseModel: string;
  trainingBatch: string | null;
  status: string;
  deployedAt: Date | null;
  archivedAt: Date | null;
  storagePath: string;
  benchmarkScore: number | null;
  accuracy: number | null;
  avgReward: number | null;
  evalMetrics: JsonValue | null;
  wandbRunId: string | null;
  wandbArtifactId: string | null;
  huggingFaceRepo: string | null;
  agentsUsing: number;
  totalInferences: number;
  lastBenchmarked: Date | null;
  benchmarkCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface TrainingBatchRecord {
  id: string;
  batchId: string;
  scenarioId: string | null;
  baseModel: string;
  modelVersion: string;
  trajectoryIds: string;
  rankingsJson: string | null;
  rewardsJson: string;
  trainingLoss: number | null;
  policyImprovement: number | null;
  status: string;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface BenchmarkResultRecord {
  id: string;
  modelId: string;
  benchmarkId: string;
  benchmarkPath: string;
  runAt: Date;
  totalPnl: number;
  predictionAccuracy: number;
  perpWinRate: number;
  optimalityScore: number;
  detailedMetrics: JsonValue;
  baselinePnlDelta: number | null;
  baselineAccuracyDelta: number | null;
  improved: boolean | null;
  duration: number;
  createdAt: Date;
}

export interface UserRecord {
  id: string;
  displayName: string | null;
  username: string | null;
  isAgent: boolean;
  [key: string]: JsonValue | boolean | Date | null | undefined;
}

export interface LlmCallLogRecord {
  id: string;
  trajectoryId: string;
  stepId: string;
  callId: string;
  timestamp: Date;
  latencyMs: number | null;
  model: string;
  purpose: string;
  actionType: string | null;
  systemPrompt: string;
  userPrompt: string;
  response: string;
  [key: string]: JsonValue | Date | null | undefined;
}

// ─── Adapter interface ──────────────────────────────────────────────────

/**
 * Core training data adapter. All database access flows through this.
 *
 * Consumers implement this interface to connect the training package to
 * their database. The training package never imports database drivers,
 * ORM libraries, or schema definitions directly.
 */
export interface ITrainingDataAdapter {
  // ── Trajectory operations ──────────────────────────────────────────

  /** Count scored trajectories ready for training. */
  countScoredTrajectoriesReady(): Promise<number>;

  /** Count unscored trajectories. */
  countUnscoredTrajectories(): Promise<number>;

  /**
   * Get scenario groups with counts.
   * Returns groups where count >= minGroupSize.
   */
  getScenarioGroups(
    minGroupSize: number,
  ): Promise<Array<{ scenarioId: string | null; count: number }>>;

  /**
   * Sample recent trajectories for data quality assessment.
   * Returns up to `limit` trajectories, most recent first.
   */
  sampleRecentTrajectories(limit: number): Promise<TrajectoryRecord[]>;

  /** Get distinct window IDs that have unscored trajectories. */
  getUnscoredWindowIds(limit: number): Promise<string[]>;

  /**
   * Get trajectory IDs ready for training, ordered by creation time.
   * If limit is provided, return at most that many.
   */
  getTrajectoryIdsForTraining(limit?: number): Promise<string[]>;

  /** Get all trajectories for a given window. */
  getTrajectoriesByWindow(windowId: string): Promise<TrajectoryRecord[]>;

  /** Get a single trajectory by its trajectoryId. */
  getTrajectoryById(trajectoryId: string): Promise<TrajectoryRecord | null>;

  /** Mark trajectories as used in a training batch. */
  markTrajectoriesAsUsed(
    trajectoryIds: string[],
    batchId: string,
  ): Promise<void>;

  /** Update trajectory reward data. */
  updateTrajectoryRewards(
    id: string,
    stepsJson: string,
    totalReward: number,
  ): Promise<void>;

  /** Update trajectory with judge score. */
  updateTrajectoryScore(
    trajectoryId: string,
    aiJudgeReward: number,
    aiJudgeReasoning: string,
  ): Promise<void>;

  /** Insert a new trajectory record. */
  insertTrajectory(
    data: Omit<TrajectoryRecord, "createdAt" | "updatedAt">,
  ): Promise<void>;

  /**
   * Count trajectories created since a given timestamp.
   * Used for rate monitoring (e.g., last hour, last 24h, last 7d).
   */
  countTrajectoriesSince(since: Date): Promise<number>;

  // ── Model operations ───────────────────────────────────────────────

  /** Get the most recently created model. */
  getLatestModel(): Promise<TrainedModelRecord | null>;

  /** Get a model by its modelId. */
  getModelById(modelId: string): Promise<TrainedModelRecord | null>;

  /** Get a model by its version string. */
  getModelByVersion(version: string): Promise<TrainedModelRecord | null>;

  /** Get model associated with a training batch and status. */
  getModelByBatchAndStatus(
    batchId: string,
    status: string,
  ): Promise<TrainedModelRecord | null>;

  /** Count deployed models. */
  countDeployedModels(): Promise<number>;

  /** Count models currently in training. */
  countTrainingBatches(): Promise<number>;

  /** Update model status (deployed, archived, etc.). */
  updateModelStatus(
    modelId: string,
    status: string,
    extra?: { deployedAt?: Date; archivedAt?: Date; agentsUsing?: number },
  ): Promise<void>;

  /** Update model benchmark results. */
  updateModelBenchmark(
    modelId: string,
    benchmarkScore: number,
    avgReward: number,
    benchmarkCount: number,
  ): Promise<void>;

  /** Update model HuggingFace repo link. */
  updateModelHuggingFaceRepo(modelId: string, repoName: string): Promise<void>;

  /** Insert a new trained model record. */
  insertModel(data: Omit<TrainedModelRecord, "createdAt">): Promise<void>;

  // ── Batch operations ───────────────────────────────────────────────

  /** Get a training batch by batchId. */
  getBatchById(batchId: string): Promise<TrainingBatchRecord | null>;

  /** Get batch IDs that have been in 'training' status longer than maxAgeMs. */
  getStuckTrainingBatches(maxAgeMs: number): Promise<string[]>;

  /** Get recently completed batches (within hoursAgo). */
  getRecentlyCompletedBatches(hoursAgo: number): Promise<TrainingBatchRecord[]>;

  /** Get the last completed batch. */
  getLastCompletedBatch(): Promise<TrainingBatchRecord | null>;

  /** Update batch status. */
  updateBatchStatus(
    batchId: string,
    status: string,
    error?: string,
  ): Promise<void>;

  /** Insert a new training batch. */
  insertBatch(
    data: Omit<TrainingBatchRecord, "startedAt" | "completedAt">,
  ): Promise<string>;

  // ── Benchmark operations ───────────────────────────────────────────

  /** Get benchmark results for a model. */
  getBenchmarkResultsByModel(modelId: string): Promise<BenchmarkResultRecord[]>;

  /** Count benchmarks created since a given timestamp. */
  countBenchmarksSince(since: Date): Promise<number>;

  /** Insert a benchmark result. */
  insertBenchmarkResult(
    data: Omit<BenchmarkResultRecord, "createdAt">,
  ): Promise<void>;

  // ── User/Agent operations ──────────────────────────────────────────

  /** Get agent users (isAgent=true). Supports optional strategy filtering. */
  getAgentUsers(filter?: {
    strategy?: "all" | "gradual" | "test";
    rolloutPercentage?: number;
    testAgentIds?: string[];
  }): Promise<UserRecord[]>;

  /** Check database connectivity (health check). */
  healthCheck(): Promise<boolean>;

  // ── Extended query operations ─────────────────────────────────────

  /** Get model IDs with status='ready' and no benchmark score. */
  getUnbenchmarkedModels(): Promise<string[]>;

  /** Get a user record by username. */
  getUserByUsername(username: string): Promise<UserRecord | null>;

  /** Create a new user record. Returns the created record. */
  createUser(data: Record<string, unknown>): Promise<UserRecord>;

  /** Delete a user by ID. */
  deleteUser(userId: string): Promise<void>;

  /** Create an agent configuration record. */
  createAgentConfig(data: Record<string, unknown>): Promise<void>;

  /** Update an agent configuration by userId. */
  updateAgentConfig(
    userId: string,
    data: Record<string, unknown>,
  ): Promise<void>;

  /**
   * Flexible benchmark result query with optional filters.
   * Results ordered by runAt descending.
   */
  queryBenchmarkResults(query: {
    modelId?: string;
    benchmarkId?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
  }): Promise<BenchmarkResultRecord[]>;

  /** Aggregate benchmark statistics per model, ordered by avgPnl descending. */
  getBenchmarkModelSummary(): Promise<
    Array<{
      modelId: string;
      runCount: number;
      avgPnl: number;
      avgAccuracy: number;
      avgOptimality: number;
      bestPnl: number;
      latestRun: Date;
    }>
  >;

  /**
   * Get scored training trajectories (isTrainingData=true with judge scores).
   * Used for cache warming.
   */
  getScoredTrajectories(limit: number): Promise<TrajectoryRecord[]>;

  /** Get comprehensive training pipeline statistics. */
  getTrainingStatistics(): Promise<{
    benchmarkCount: number;
    lastBenchmarkDate: Date | null;
    trajectoryTotal: number;
    trajectoryTraining: number;
    modelTotal: number;
    modelBenchmarked: number;
    modelDeployed: number;
    publishedRepoCount: number;
  }>;

  /** Get the deployment date of the last model uploaded to HuggingFace. */
  getLastDeployedModelDate(): Promise<Date | null>;

  // ── Additional operations (added for service refactoring) ────────

  /** Get the best benchmarked model, optionally excluding a model ID. Status 'ready'/'deployed', non-null benchmarkScore, ordered by score desc. */
  getBestBenchmarkedModel(
    excludeModelId?: string,
  ): Promise<TrainedModelRecord | null>;

  /** Update model with detailed benchmark results (score, accuracy, eval metrics). */
  updateModelBenchmarkResults(
    modelId: string,
    data: { benchmarkScore: number; accuracy: number; evalMetrics: JsonValue },
  ): Promise<void>;

  /** Get models with benchmark scores, ordered by score descending. */
  getBenchmarkedModels(limit: number): Promise<TrainedModelRecord[]>;

  /** Count active models (status: training, ready, or deployed). */
  countActiveModels(): Promise<number>;

  /** Get training trajectories (scored, unused, valid steps). Most recent first. */
  getTrainingTrajectories(limit?: number): Promise<TrajectoryRecord[]>;

  /** Get trajectory IDs for a specific agent. */
  getTrajectoryIdsByAgent(agentId: string): Promise<string[]>;

  /** Get trajectories by multiple IDs. */
  getTrajectoriesByIds(trajectoryIds: string[]): Promise<TrajectoryRecord[]>;

  /** Get unscored trajectories, optionally filtered by IDs or limited. */
  getUnscoredTrajectories(options?: {
    trajectoryIds?: string[];
    limit?: number;
  }): Promise<TrajectoryRecord[]>;

  /** Get unscored trajectory IDs for a specific window. */
  getUnscoredWindowTrajectoryIds(windowId: string): Promise<string[]>;
}

/**
 * Optional extended adapter for market-specific operations.
 * Only needed by Babylon or similar market-focused platforms.
 */
export interface IMarketDataAdapter {
  /** Get perpetual positions within a time window. */
  getPerpPositionsForWindow(
    windowStart: Date,
    windowEnd: Date,
  ): Promise<
    Array<{
      id: string;
      ticker?: string;
      direction: string;
      entryPrice: number;
      currentPrice?: number | null;
      exitPrice: number | null;
      closedAt?: Date | null;
      pnl: number | null;
      [key: string]: JsonValue | Date | null | undefined;
    }>
  >;

  /** Get resolved prediction markets within a time window. */
  getResolvedMarketsForWindow(
    windowStart: Date,
    windowEnd: Date,
  ): Promise<
    Array<{
      id: string;
      question: string;
      outcome: boolean | null;
      finalProbability: number | null;
      [key: string]: JsonValue | boolean | Date | null | undefined;
    }>
  >;

  /** Get market outcomes for a window ID. */
  getMarketOutcomesByWindow(windowId: string): Promise<
    Array<{
      windowId: string;
      [key: string]: JsonValue | undefined;
    }>
  >;

  /** Insert a market outcome record. */
  insertMarketOutcome(data: Record<string, JsonValue>): Promise<void>;

  /** Check if outcomes exist for a window. */
  hasOutcomesForWindow(windowId: string): Promise<boolean>;

  /** Get distinct window IDs that have market outcomes. */
  getDistinctWindowsWithOutcomes(): Promise<string[]>;
}

/**
 * Optional adapter for LLM call logging.
 * Only needed if the consuming platform records per-call LLM logs.
 */
export interface ILlmLogAdapter {
  /** Count LLM calls for a trajectory. */
  countLLMCallsForTrajectory(trajectoryId: string): Promise<number>;

  /** Insert an LLM call log record. */
  insertLLMCallLog(data: LlmCallLogRecord): Promise<void>;

  /** Count LLM calls for multiple trajectories since a given time. */
  countRecentLLMCalls(trajectoryIds: string[], since: Date): Promise<number>;
}

// ─── Adapter registration ───────────────────────────────────────────────

let _dataAdapter: ITrainingDataAdapter | null = null;
let _marketAdapter: IMarketDataAdapter | null = null;
let _llmLogAdapter: ILlmLogAdapter | null = null;

/**
 * Register the training data adapter.
 * Must be called before any training operations that need database access.
 */
export function setTrainingDataAdapter(adapter: ITrainingDataAdapter): void {
  if (!adapter || typeof adapter.countScoredTrajectoriesReady !== "function") {
    throw new TypeError(
      "setTrainingDataAdapter: provided object does not implement ITrainingDataAdapter",
    );
  }
  _dataAdapter = adapter;
}

/** Register the optional market data adapter. */
export function setMarketDataAdapter(adapter: IMarketDataAdapter): void {
  _marketAdapter = adapter;
}

/** Register the optional LLM log adapter. */
export function setLlmLogAdapter(adapter: ILlmLogAdapter): void {
  _llmLogAdapter = adapter;
}

/**
 * Get the registered training data adapter.
 * Throws if not registered — this is intentional to surface misconfiguration early.
 */
export function getTrainingDataAdapter(): ITrainingDataAdapter {
  if (!_dataAdapter) {
    throw new Error(
      "Training data adapter not registered. Call setTrainingDataAdapter() before using training operations.",
    );
  }
  return _dataAdapter;
}

/** Get the optional market data adapter (null if not registered). */
export function getMarketDataAdapter(): IMarketDataAdapter | null {
  return _marketAdapter;
}

/** Get the optional LLM log adapter (null if not registered). */
export function getLlmLogAdapter(): ILlmLogAdapter | null {
  return _llmLogAdapter;
}

/** Check if the data adapter has been registered. */
export function isDataAdapterRegistered(): boolean {
  return _dataAdapter !== null;
}

/** Reset all adapters (for testing). */
export function resetAdapters(): void {
  _dataAdapter = null;
  _marketAdapter = null;
  _llmLogAdapter = null;
}
