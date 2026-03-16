import type { UUID } from "@elizaos/core";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/**
 * Enhanced Trajectory Types for RULER/OpenPipe ART Training
 * Captures EVERYTHING needed for reinforcement learning
 */

export interface LLMCall {
  callId: string;
  timestamp: number;
  model: string;
  modelVersion?: string;

  // Full prompt context
  systemPrompt: string;
  userPrompt: string;
  messages?: Array<{ role: string; content: string }>;

  // Response
  response: string;
  reasoning?: string;

  // Parameters
  temperature: number;
  maxTokens: number;
  topP?: number;

  // Metrics
  promptTokens?: number;
  completionTokens?: number;
  latencyMs?: number;

  // Context
  purpose: "action" | "reasoning" | "evaluation" | "response" | "other";
  actionType?: string;
}

export interface ProviderAccess {
  providerId: string;
  providerName: string;
  timestamp: number;

  // What was requested
  query?: Record<string, JsonValue>;

  // What was returned
  data: Record<string, JsonValue>;

  // Context
  purpose: string;
}

export interface ActionAttempt {
  attemptId: string;
  timestamp: number;

  // Action details
  actionType: string;
  actionName: string;
  parameters: Record<string, JsonValue>;

  // Context that led to this action
  reasoning?: string;
  llmCallId?: string;

  // Outcome
  success: boolean;
  result?: Record<string, JsonValue>;
  error?: string;

  // Reward signals
  immediateReward?: number;
}

export interface EnvironmentState {
  timestamp: number;

  // Agent state
  agentBalance: number;
  agentPoints: number;
  agentPnL: number;
  openPositions: number;

  // Market state
  activeMarkets?: number;
  portfolioValue?: number;

  // Social state
  unreadMessages?: number;
  recentEngagement?: number;

  // Any other relevant state
  custom?: Record<string, JsonValue>;
}

export interface TrajectoryStep {
  stepId: UUID;
  stepNumber: number;
  timestamp: number;

  // Environment observation at this step
  environmentState: EnvironmentState;
  observation: Record<string, JsonValue>;

  // Agent cognition
  llmCalls: LLMCall[];
  providerAccesses: ProviderAccess[];
  reasoning?: string;

  // Action taken
  action: ActionAttempt;

  // Feedback
  reward: number;
  done: boolean;

  // Metadata
  metadata?: Record<string, JsonValue>;
}

export interface RewardComponents {
  environmentReward: number;
  aiJudgeReward?: number;
  components?: {
    profitLoss?: number;
    predictionAccuracy?: number;
    socialEngagement?: number;
    riskAdjusted?: number;
    [key: string]: number | undefined;
  };
  judgeModel?: string;
  judgeReasoning?: string;
  judgeTimestamp?: number;
}

export interface Trajectory {
  trajectoryId: UUID;
  agentId: UUID;

  // Timing
  startTime: number;
  endTime: number;
  durationMs: number;

  // Episode context
  episodeId?: string;
  scenarioId?: string;
  batchId?: string;
  groupIndex?: number;

  // Rich trajectory data
  steps: TrajectoryStep[];

  // Rewards
  totalReward: number;
  rewardComponents: RewardComponents;

  metrics: {
    episodeLength: number;
    finalStatus: "completed" | "terminated" | "error" | "timeout";
    finalBalance?: number;
    finalPnL?: number;
    tradesExecuted?: number;
    postsCreated?: number;
    messagesHandled?: number;
    successRate?: number;
    errorCount?: number;
    [key: string]: JsonValue | undefined;
  };

  metadata: {
    agentName?: string;
    agentModel?: string;
    agentVersion?: string;
    environmentVersion?: string;
    randomSeed?: number;
    isTrainingData?: boolean;
    isEvaluation?: boolean;
    comparisonGroup?: string;
    initialState?: Record<string, JsonValue>;
    goalDescription?: string;
    constraints?: string[];
    trueProbabilities?: Record<string, number>;
    futureOutcomes?: Record<string, JsonValue>;
    hiddenVariables?: Record<string, JsonValue>;
    [key: string]: JsonValue | undefined;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  name?: string;
}

export interface ARTTrajectory {
  messages: ChatMessage[];
  reward: number;
  metadata: {
    trajectoryId: string;
    agentId: string;
    scenarioId?: string;
    groupIndex?: number;
    environmentContext?: {
      initialBalance: number;
      finalBalance: number;
      initialPnL: number;
      finalPnL: number;
      actionsTaken: string[];
      errors: string[];
    };
    gameKnowledge?: {
      trueProbabilities?: Record<string, number>;
      actualOutcomes?: Record<string, JsonValue>;
      hiddenVariables?: Record<string, JsonValue>;
    };
    metrics?: Record<string, JsonValue>;
    [key: string]: JsonValue | undefined;
  };
  metrics?: Record<string, number>;
}

export interface TrajectoryRecord {
  id: string;
  trajectoryId: string;
  agentId: string;
  startTime: Date;
  endTime: Date;
  durationMs: number;
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
  aiJudgeReward: number | null;
  aiJudgeReasoning: string | null;
  judgedAt: Date | null;
  isTrainingData: boolean;
  isEvaluation: boolean;
  usedInTraining: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface RewardRequest {
  trajectoryId: string;
  trajectory: Trajectory;
  groupTrajectories?: Trajectory[];
  criteria: {
    profitability?: boolean;
    riskManagement?: boolean;
    socialQuality?: boolean;
    strategyCoherence?: boolean;
  };
}

export interface RewardResponse {
  trajectoryId: string;
  overallScore: number;
  componentScores?: Record<string, number>;
  rank?: number;
  normalizedScore?: number;
  reasoning: string;
  strengths?: string[];
  weaknesses?: string[];
  judgeModel: string;
  judgeVersion: string;
  judgedAt: number;
}

export interface TrajectoryGroup {
  groupId: string;
  scenarioId: string;
  trajectories: Trajectory[];
  sharedPrefix?: ChatMessage[];
  rankings?: number[];
  normalizedRewards?: number[];
  rulerScores?: number[];
  createdAt: number;
  modelVersion?: string;
}

export interface TrainingBatch {
  batchId: string;
  scenarioId?: string;
  groups: TrajectoryGroup[];
  createdAt: number;
  modelVersion: string;
  trainingConfig?: Record<string, JsonValue>;
}
