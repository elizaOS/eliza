import type { JsonValue } from '@feed/shared';
import { type UUID } from '@elizaos/core';

export interface ScamAnalysis {
  schemaVersion: 'scam-analysis-v1';
  isScamSuspected: boolean;
  threatFamily: string;
  evidence: string[];
  riskSignals: string[];
  sensitiveTargets: string[];
  recommendedAction: string;
  confidence: number;
  grounded: boolean;
}

/**
 * Enhanced Trajectory Types for RULER/OpenPipe ART Training
 * Captures EVERYTHING needed for reinforcement learning
 */

export interface LLMCall {
  callId: string;
  timestamp: number;
  model: string;
  modelVersion?: string; // RL model version if using trained model

  // Full prompt context
  systemPrompt: string;
  userPrompt: string;
  messages?: Array<{ role: string; content: string }>; // Full conversation history

  // Response
  response: string;
  reasoning?: string; // Chain-of-thought if applicable
  metadata?: Record<string, JsonValue>;
  privateAnalysis?: ScamAnalysis;
  reasoningAvailable?: boolean;
  reasoningSource?: string;
  traceVisibility?: 'private' | 'public';
  rawReasoningTrace?: string;

  // Parameters
  temperature: number;
  maxTokens: number;
  topP?: number;

  // Metrics
  promptTokens?: number;
  completionTokens?: number;
  latencyMs?: number;

  // Context
  purpose: 'action' | 'reasoning' | 'evaluation' | 'response' | 'other';
  actionType?: string; // e.g., 'post', 'trade', 'comment'
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
  purpose: string; // Why this provider was accessed
}

export interface ActionAttempt {
  attemptId: string;
  timestamp: number;

  // Action details
  actionType: string; // 'CREATE_POST', 'BUY_SHARES', 'SEND_MESSAGE', etc.
  actionName: string;
  parameters: Record<string, JsonValue>;

  // Context that led to this action
  reasoning?: string; // Why agent chose this action
  llmCallId?: string; // Reference to LLM call that generated this
  privateAnalysis?: ScamAnalysis;
  reasoningAvailable?: boolean;
  reasoningSource?: string;
  traceVisibility?: 'private' | 'public';

  // Outcome
  success: boolean;
  result?: Record<string, JsonValue>;
  error?: string;

  // Reward signals
  immediateReward?: number; // Instant feedback (if any)
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

  // Group chat context at decision time
  groupChatsActive?: number;
  groupChatFacts?: string[];
  groupChatIntelTokenEstimate?: number;

  // Prompt token budget breakdown
  promptTokenEstimate?: number;
  contextBreakdown?: {
    system?: number;
    markets?: number;
    positions?: number;
    groupChat?: number;
    pending?: number;
    actionSchemas?: number;
    feed?: number;
  };

  // Any other relevant state
  custom?: Record<string, JsonValue>;
}

/**
 * Ground-truth context about the counterparty in an interaction.
 *
 * Populated from the NPC character roster or agent config. Enables
 * intent-aware reward computation: the same action (e.g. sharing
 * an API key) is rewarded differently depending on whether the
 * counterparty is a verified admin, a teammate, or a red-team attacker.
 */
export interface CounterpartyContext {
  counterpartyId?: string;
  counterpartyAlignment?: 'good' | 'neutral' | 'evil';
  counterpartyTeam?: 'red' | 'blue' | 'gray';
  /** Admin = system-verified, team = same-team agent, none = unknown/cross-team */
  senderRole?: 'admin' | 'team' | 'none';
  /** Ground-truth intent of the counterparty in this interaction */
  interactionIntent?: 'attack' | 'legitimate' | 'neutral';
  isVerifiedAdmin?: boolean;
}

export interface TrajectoryStep {
  stepId: UUID;
  stepNumber: number; // Sequential number within trajectory
  timestamp: number;

  // Environment observation at this step
  environmentState: EnvironmentState;
  observation: Record<string, JsonValue>; // Raw observation from environment

  // Agent cognition
  llmCalls: LLMCall[]; // All LLM calls made during this step
  providerAccesses: ProviderAccess[]; // All data accessed via providers
  reasoning?: string; // Agent's overall thought process for this step
  privateAnalysis?: ScamAnalysis;

  // Action taken
  action: ActionAttempt;

  // Counterparty context (for intent-aware rewards)
  counterpartyContext?: CounterpartyContext;

  // Trust state at this step (populated from trust system)
  trustState?: {
    profile?: string; // "good" | "bad" | "neutral"
    trustScore?: number; // 0-100
    scamRisk?: number;
    scamLossesAvoided?: number;
    scamLossesIncurred?: number;
    unsafeDisclosures?: number;
    socialCapital?: number;
    informationSaleRevenue?: number;
    fraudulentInformationRevenue?: number;
  };

  // Feedback
  reward: number; // Step reward (if applicable)
  done: boolean; // Is episode finished?

  // Step-level reward attribution (computed by endTrajectory)
  stepWeight?: number; // Relative importance weight for this step
  attributedReward?: number; // Portion of totalReward attributed to this step

  // Metadata
  metadata?: Record<string, JsonValue>;
}

export interface RewardComponents {
  // Environment-driven rewards
  environmentReward: number; // e.g., P&L, accuracy

  // AI judge rewards (added later during training)
  aiJudgeReward?: number; // RULER score

  // Component breakdown
  components?: {
    profitLoss?: number;
    predictionAccuracy?: number;
    socialEngagement?: number;
    riskAdjusted?: number;
    [key: string]: number | undefined;
  };

  // Judge metadata
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
  episodeId?: string; // For grouping related episodes
  scenarioId?: string; // For GRPO grouping (same scenario, different outcomes)
  batchId?: string; // Training batch identifier
  groupIndex?: number; // Position in trajectory group (for GRPO)

  // The trajectory data (RICH FORMAT - for analysis & RULER context)
  steps: TrajectoryStep[];

  // Rewards
  totalReward: number;
  rewardComponents: RewardComponents;

  // Outcome metrics
  metrics: {
    episodeLength: number;
    finalStatus: 'completed' | 'terminated' | 'error' | 'timeout';

    // Performance metrics
    finalBalance?: number;
    finalPnL?: number;
    tradesExecuted?: number;
    postsCreated?: number;
    messagesHandled?: number;

    // Quality metrics
    successRate?: number;
    errorCount?: number;

    [key: string]: JsonValue | undefined;
  };

  // Context for training (For RULER judge to use)
  metadata: {
    agentName?: string;
    agentModel?: string;
    agentVersion?: string;

    // Agent alignment context (ground truth from character roster)
    agentAlignment?: 'good' | 'neutral' | 'evil';
    agentTeam?: 'red' | 'blue' | 'gray';
    agentScamProfile?: string; // hunter | wary | gullible | etc.

    // Environment config
    environmentVersion?: string;
    randomSeed?: number;

    // Training metadata
    isTrainingData?: boolean;
    isEvaluation?: boolean;
    comparisonGroup?: string; // For RULER comparison

    // Additional context for RULER
    initialState?: Record<string, JsonValue>; // Starting conditions
    goalDescription?: string; // What agent was trying to achieve
    constraints?: string[]; // Rules/constraints agent should follow

    // Interaction summary (derived from step-level counterparty contexts)
    interactionSummary?: {
      totalInteractions: number;
      redTeamInteractions: number;
      blueTeamInteractions: number;
      grayTeamInteractions: number;
      scamAttemptsReceived: number;
      scamAttemptsResisted: number;
      legitimateRequestsAccepted: number;
      legitimateRequestsRefused: number; // over-refusal count
    };

    [key: string]: JsonValue | undefined;
  };
}

/**
 * OpenAGI Chat Message Format (for ART training)
 * This is what ART/GRPO actually trains on
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  name?: string;
}

/**
 * ART-compatible Trajectory Format
 * This is what gets exported for GRPO training
 */
export interface ARTTrajectory {
  // Message sequence (what model sees/generates)
  messages: ChatMessage[];

  // Single reward (computed from outcome)
  reward: number;

  // Metadata (for RULER judge context)
  metadata: {
    trajectoryId: string;
    agentId: string;
    scenarioId?: string;
    groupIndex?: number;

    // Additional context for RULER to rank trajectories
    environmentContext?: {
      initialBalance: number;
      finalBalance: number;
      initialPnL: number;
      finalPnL: number;
      actionsTaken: string[];
      errors: string[];
    };

    // Game knowledge for RULER
    gameKnowledge?: {
      trueProbabilities?: Record<string, number>;
      actualOutcomes?: Record<string, JsonValue>;
      hiddenVariables?: Record<string, JsonValue>;
    };

    // Performance metrics for RULER
    metrics?: Record<string, JsonValue>;

    // Agent alignment (for offline RL reward relabeling)
    agentAlignment?: 'good' | 'neutral' | 'evil';
    agentTeam?: 'red' | 'blue' | 'gray';

    // Per-step counterparty labels (parallel array to messages)
    stepCounterparties?: Array<{
      counterpartyAlignment?: 'good' | 'neutral' | 'evil';
      counterpartyTeam?: 'red' | 'blue' | 'gray';
      senderRole?: 'admin' | 'team' | 'none';
      interactionIntent?: 'attack' | 'legitimate' | 'neutral';
    } | null>;

    [key: string]: JsonValue | undefined;
  };

  // Metrics (for analysis, not training)
  metrics?: Record<string, number>;
}

/**
 * Database-compatible flattened version for storage
 */
export interface TrajectoryRecord {
  id: string;
  trajectoryId: string;
  agentId: string;

  // Timing
  startTime: Date;
  endTime: Date;
  durationMs: number;

  // Grouping
  episodeId: string | null;
  scenarioId: string | null;
  batchId: string | null;

  // Data (stored as JSON)
  stepsJson: string; // JSON.stringify(steps)
  rewardComponentsJson: string;
  metricsJson: string;
  metadataJson: string;

  // Quick access fields
  totalReward: number;
  episodeLength: number;
  finalStatus: string;
  finalBalance: number | null;
  finalPnL: number | null;

  // AI Judge (added later)
  aiJudgeReward: number | null;
  aiJudgeReasoning: string | null;
  judgedAt: Date | null;

  // Training
  isTrainingData: boolean;
  isEvaluation: boolean;
  usedInTraining: boolean;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Reward computation request for AI judge
 */
export interface RewardRequest {
  trajectoryId: string;
  trajectory: Trajectory;

  // Comparison context (for RULER)
  groupTrajectories?: Trajectory[]; // Other trajectories in the same scenario

  // Reward criteria
  criteria: {
    profitability?: boolean;
    riskManagement?: boolean;
    socialQuality?: boolean;
    strategyCoherence?: boolean;
  };
}

export interface RewardResponse {
  trajectoryId: string;

  // Scores
  overallScore: number; // 0-1
  componentScores?: Record<string, number>;

  // Relative ranking (for RULER)
  rank?: number; // Position in group
  normalizedScore?: number; // Relative to group

  // Explanation
  reasoning: string;
  strengths?: string[];
  weaknesses?: string[];

  // Metadata
  judgeModel: string;
  judgeVersion: string;
  judgedAt: number;
}

/**
 * Trajectory Group for GRPO
 * N trajectories from same scenario (for comparative ranking)
 */
export interface TrajectoryGroup {
  groupId: string;
  scenarioId: string;

  // Multiple trajectories from same scenario (N parallel rollouts)
  trajectories: Trajectory[];

  // Shared prefix (deduplicated)
  sharedPrefix?: ChatMessage[]; // Messages common to all trajectories

  // Rankings (for GRPO/RULER)
  rankings?: number[]; // Index matches trajectories array
  normalizedRewards?: number[];
  rulerScores?: number[]; // 0-1 scores from LLM judge

  // Metadata
  createdAt: number;
  modelVersion?: string;
}

/**
 * Training batch for GRPO
 */
export interface TrainingBatch {
  batchId: string;
  scenarioId?: string;

  // Multiple trajectory groups
  groups: TrajectoryGroup[];

  // Metadata
  createdAt: number;
  modelVersion: string;
  trainingConfig?: Record<string, JsonValue>;
}
