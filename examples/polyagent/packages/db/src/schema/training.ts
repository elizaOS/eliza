import { relations } from "drizzle-orm";
import {
  boolean,
  decimal,
  doublePrecision,
  index,
  integer,
  json,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import type { JsonValue } from "../types";
import { users } from "./users";

// Trajectory
export const trajectories = pgTable(
  "trajectories",
  {
    id: text("id").primaryKey(),
    trajectoryId: text("trajectoryId").notNull().unique(),
    agentId: text("agentId").notNull(),
    archetype: varchar("archetype", { length: 50 }),
    startTime: timestamp("startTime", { mode: "date" }).notNull(),
    endTime: timestamp("endTime", { mode: "date" }).notNull(),
    durationMs: integer("durationMs").notNull(),
    windowId: varchar("windowId", { length: 50 }),
    windowHours: integer("windowHours").notNull().default(1),
    episodeId: varchar("episodeId", { length: 100 }),
    scenarioId: varchar("scenarioId", { length: 100 }),
    batchId: varchar("batchId", { length: 100 }),
    stepsJson: text("stepsJson").notNull(),
    rewardComponentsJson: text("rewardComponentsJson").notNull(),
    metricsJson: text("metricsJson").notNull(),
    metadataJson: text("metadataJson").notNull(),
    totalReward: doublePrecision("totalReward").notNull(),
    episodeLength: integer("episodeLength").notNull(),
    finalStatus: text("finalStatus").notNull(),
    finalBalance: doublePrecision("finalBalance"),
    finalPnL: doublePrecision("finalPnL"),
    tradesExecuted: integer("tradesExecuted"),
    postsCreated: integer("postsCreated"),
    aiJudgeReward: doublePrecision("aiJudgeReward"),
    aiJudgeReasoning: text("aiJudgeReasoning"),
    judgedAt: timestamp("judgedAt", { mode: "date" }),
    isTrainingData: boolean("isTrainingData").notNull().default(true),
    isEvaluation: boolean("isEvaluation").notNull().default(false),
    usedInTraining: boolean("usedInTraining").notNull().default(false),
    trainedInBatch: text("trainedInBatch"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
  },
  (table) => [
    index("trajectories_agentId_startTime_idx").on(
      table.agentId,
      table.startTime,
    ),
    index("trajectories_aiJudgeReward_idx").on(table.aiJudgeReward),
    index("trajectories_isTrainingData_usedInTraining_idx").on(
      table.isTrainingData,
      table.usedInTraining,
    ),
    index("trajectories_scenarioId_createdAt_idx").on(
      table.scenarioId,
      table.createdAt,
    ),
    index("trajectories_trainedInBatch_idx").on(table.trainedInBatch),
    index("trajectories_windowId_agentId_idx").on(
      table.windowId,
      table.agentId,
    ),
    index("trajectories_windowId_idx").on(table.windowId),
    index("trajectories_archetype_idx").on(table.archetype),
  ],
);

// RewardJudgment
export const rewardJudgments = pgTable(
  "reward_judgments",
  {
    id: text("id").primaryKey(),
    trajectoryId: text("trajectoryId").notNull().unique(),
    judgeModel: text("judgeModel").notNull(),
    judgeVersion: text("judgeVersion").notNull(),
    overallScore: doublePrecision("overallScore").notNull(),
    componentScoresJson: text("componentScoresJson"),
    rank: integer("rank"),
    normalizedScore: doublePrecision("normalizedScore"),
    groupId: text("groupId"),
    reasoning: text("reasoning").notNull(),
    strengthsJson: text("strengthsJson"),
    weaknessesJson: text("weaknessesJson"),
    criteriaJson: text("criteriaJson").notNull(),
    judgedAt: timestamp("judgedAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("reward_judgments_overallScore_idx").on(table.overallScore),
    index("reward_judgments_groupId_rank_idx").on(table.groupId, table.rank),
  ],
);

// TrainingBatch
export const trainingBatches = pgTable(
  "training_batches",
  {
    id: text("id").primaryKey(),
    batchId: text("batchId").notNull().unique(),
    scenarioId: text("scenarioId"),
    baseModel: text("baseModel").notNull(),
    modelVersion: text("modelVersion").notNull(),
    trajectoryIds: text("trajectoryIds").notNull(),
    rankingsJson: text("rankingsJson"),
    rewardsJson: text("rewardsJson").notNull(),
    trainingLoss: doublePrecision("trainingLoss"),
    policyImprovement: doublePrecision("policyImprovement"),
    status: text("status").notNull().default("pending"),
    error: text("error"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    startedAt: timestamp("startedAt", { mode: "date" }),
    completedAt: timestamp("completedAt", { mode: "date" }),
  },
  (table) => [
    index("training_batches_scenarioId_idx").on(table.scenarioId),
    index("training_batches_status_createdAt_idx").on(
      table.status,
      table.createdAt,
    ),
  ],
);

// TrainedModel
export const trainedModels = pgTable(
  "trained_models",
  {
    id: text("id").primaryKey(),
    modelId: text("modelId").notNull().unique(),
    version: text("version").notNull(),
    baseModel: text("baseModel").notNull(),
    trainingBatch: text("trainingBatch"),
    status: text("status").notNull().default("training"),
    deployedAt: timestamp("deployedAt", { mode: "date" }),
    archivedAt: timestamp("archivedAt", { mode: "date" }),
    storagePath: text("storagePath").notNull(),
    benchmarkScore: doublePrecision("benchmarkScore"),
    accuracy: doublePrecision("accuracy"),
    avgReward: doublePrecision("avgReward"),
    evalMetrics: json("evalMetrics").$type<JsonValue>(),
    wandbRunId: text("wandbRunId"),
    wandbArtifactId: text("wandbArtifactId"),
    huggingFaceRepo: text("huggingFaceRepo"),
    agentsUsing: integer("agentsUsing").notNull().default(0),
    totalInferences: integer("totalInferences").notNull().default(0),
    lastBenchmarked: timestamp("lastBenchmarked", { mode: "date" }),
    benchmarkCount: integer("benchmarkCount").notNull().default(0),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
  },
  (table) => [
    index("trained_models_status_idx").on(table.status),
    index("trained_models_version_idx").on(table.version),
    index("trained_models_deployedAt_idx").on(table.deployedAt),
    index("trained_models_lastBenchmarked_idx").on(table.lastBenchmarked),
  ],
);

// BenchmarkResult
export const benchmarkResults = pgTable(
  "benchmark_results",
  {
    id: text("id").primaryKey(),
    modelId: text("modelId").notNull(),
    benchmarkId: text("benchmarkId").notNull(),
    benchmarkPath: text("benchmarkPath").notNull(),
    runAt: timestamp("runAt", { mode: "date" }).notNull().defaultNow(),
    totalPnl: doublePrecision("totalPnl").notNull(),
    predictionAccuracy: doublePrecision("predictionAccuracy").notNull(),
    perpWinRate: doublePrecision("perpWinRate").notNull(),
    optimalityScore: doublePrecision("optimalityScore").notNull(),
    detailedMetrics: json("detailedMetrics").$type<JsonValue>().notNull(),
    baselinePnlDelta: doublePrecision("baselinePnlDelta"),
    baselineAccuracyDelta: doublePrecision("baselineAccuracyDelta"),
    improved: boolean("improved"),
    duration: integer("duration").notNull(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("benchmark_results_modelId_idx").on(table.modelId),
    index("benchmark_results_benchmarkId_idx").on(table.benchmarkId),
    index("benchmark_results_runAt_idx").on(table.runAt),
    index("benchmark_results_optimalityScore_idx").on(table.optimalityScore),
  ],
);

// LlmCallLog
export const llmCallLogs = pgTable(
  "llm_call_logs",
  {
    id: text("id").primaryKey(),
    trajectoryId: text("trajectoryId").notNull(),
    stepId: text("stepId").notNull(),
    callId: text("callId").notNull().unique(),
    timestamp: timestamp("timestamp", { mode: "date" }).notNull(),
    latencyMs: integer("latencyMs"),
    model: text("model").notNull(),
    purpose: text("purpose").notNull(),
    actionType: text("actionType"),
    systemPrompt: text("systemPrompt").notNull(),
    userPrompt: text("userPrompt").notNull(),
    messagesJson: text("messagesJson"),
    response: text("response").notNull(),
    reasoning: text("reasoning"),
    temperature: doublePrecision("temperature").notNull(),
    maxTokens: integer("maxTokens").notNull(),
    topP: doublePrecision("topP"),
    promptTokens: integer("promptTokens"),
    completionTokens: integer("completionTokens"),
    totalTokens: integer("totalTokens"),
    metadata: text("metadata"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("llm_call_logs_callId_idx").on(table.callId),
    index("llm_call_logs_timestamp_idx").on(table.timestamp),
    index("llm_call_logs_trajectoryId_idx").on(table.trajectoryId),
    // Admin stats index for createdAt time series queries
    index("llm_call_logs_createdAt_idx").on(table.createdAt),
  ],
);

// market_outcomes
export const marketOutcomes = pgTable(
  "market_outcomes",
  {
    id: text("id").primaryKey(),
    windowId: varchar("windowId", { length: 50 }).notNull(),
    stockTicker: varchar("stockTicker", { length: 20 }),
    startPrice: decimal("startPrice", { precision: 10, scale: 2 }),
    endPrice: decimal("endPrice", { precision: 10, scale: 2 }),
    changePercent: decimal("changePercent", { precision: 5, scale: 2 }),
    sentiment: varchar("sentiment", { length: 20 }),
    newsEvents: json("newsEvents").$type<JsonValue>(),
    predictionMarketId: text("predictionMarketId"),
    question: text("question"),
    outcome: varchar("outcome", { length: 20 }),
    finalProbability: decimal("finalProbability", { precision: 5, scale: 4 }),
    volume: decimal("volume", { precision: 15, scale: 2 }),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("market_outcomes_windowId_idx").on(table.windowId),
    index("market_outcomes_windowId_stockTicker_idx").on(
      table.windowId,
      table.stockTicker,
    ),
  ],
);

// Relations
export const trajectoriesRelations = relations(trajectories, ({ one }) => ({
  agent: one(users, {
    fields: [trajectories.agentId],
    references: [users.id],
  }),
  rewardJudgment: one(rewardJudgments, {
    fields: [trajectories.trajectoryId],
    references: [rewardJudgments.trajectoryId],
  }),
}));

export const rewardJudgmentsRelations = relations(
  rewardJudgments,
  ({ one }) => ({
    trajectory: one(trajectories, {
      fields: [rewardJudgments.trajectoryId],
      references: [trajectories.trajectoryId],
    }),
  }),
);

// Type exports
export type Trajectory = typeof trajectories.$inferSelect;
export type NewTrajectory = typeof trajectories.$inferInsert;
export type RewardJudgment = typeof rewardJudgments.$inferSelect;
export type NewRewardJudgment = typeof rewardJudgments.$inferInsert;
export type TrainingBatch = typeof trainingBatches.$inferSelect;
export type NewTrainingBatch = typeof trainingBatches.$inferInsert;
export type TrainedModel = typeof trainedModels.$inferSelect;
export type NewTrainedModel = typeof trainedModels.$inferInsert;
export type BenchmarkResult = typeof benchmarkResults.$inferSelect;
export type NewBenchmarkResult = typeof benchmarkResults.$inferInsert;
export type LlmCallLog = typeof llmCallLogs.$inferSelect;
export type NewLlmCallLog = typeof llmCallLogs.$inferInsert;
export type MarketOutcome = typeof marketOutcomes.$inferSelect;
export type NewMarketOutcome = typeof marketOutcomes.$inferInsert;
