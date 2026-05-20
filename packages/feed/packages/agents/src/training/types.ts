/**
 * TypeScript types for Training Pipeline
 *
 * Proper types to replace 'any' usage throughout the training system
 */

import type {
  LlmCallLog,
  OrderByInput,
  SelectInput,
  TrainedModel,
  TrainingBatch,
  Trajectory,
  WhereInput,
} from "@feed/db";
import type { JsonValue } from "@feed/shared";

// Re-export schema types for convenience
export type { LlmCallLog, TrainedModel, TrainingBatch, Trajectory };

/**
 * Trajectory Step types.
 *
 * Simplified versions optimized for the training pipeline.
 */
export interface TrajectoryStep {
  stepNumber: number;
  timestamp: number;
  environmentState: EnvironmentState;
  providerAccesses: ProviderAccess[];
  llmCalls: LLMCall[];
  action: Action;
  reward: number;
  /** Relative importance weight for this step (computed during trajectory save) */
  stepWeight?: number;
  /** Portion of totalReward attributed to this step (computed during trajectory save) */
  attributedReward?: number;
  trustState?: TrustState;
  privateAnalysis?: ScamAnalysis;
  /** Counterparty context for interaction labeling (populated by adversarial eval) */
  counterpartyContext?: {
    counterpartyId?: string;
    counterpartyAlignment?: "good" | "neutral" | "evil";
    counterpartyTeam?: "red" | "blue" | "gray";
    senderRole?: "admin" | "team" | "none";
    interactionIntent?: "attack" | "legitimate" | "neutral";
    isVerifiedAdmin?: boolean;
  };
}

export interface EnvironmentState {
  agentBalance: number;
  agentPnL: number;
  openPositions: number;
  activeMarkets?: number;
  timestamp?: number;

  // Group chat context (R2)
  groupChatsActive?: number;
  groupChatFacts?: string[];
  groupChatIntelTokenEstimate?: number;

  // Token budget breakdown (R5)
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

  // Working memory summary (R1)
  workingMemoryFactCount?: number;
  workingMemoryActiveThesis?: string;

  // Catch-all for custom fields
  [key: string]:
    | number
    | string
    | boolean
    | string[]
    | Record<string, number | undefined>
    | null
    | undefined;
}

export interface ProviderAccess {
  providerName: string;
  data: Record<string, JsonValue>;
  purpose: string;
  query?: Record<string, JsonValue>;
}

export interface TrustState {
  profile?: string;
  trustScore?: number;
  scamRisk?: number;
  scamLossesAvoided?: number;
  scamLossesIncurred?: number;
  unsafeDisclosures?: number;
  socialCapital?: number;
  informationSaleRevenue?: number;
  fraudulentInformationRevenue?: number;
}

export interface ScamAnalysis {
  schemaVersion: "scam-analysis-v1";
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
 * Ground-truth label for a single interaction with a counterparty.
 *
 * We know each agent's team (red/blue/gray) and alignment (good/neutral/evil)
 * from their character sheet. By labeling each interaction with the counterparty's
 * identity, we can derive verifiable scam/legitimate outcomes:
 * - Money paid to red-team agent → scam
 * - Money paid to blue/gray-team agent → legitimate
 * - Interaction rejected with blue-team agent → false positive
 */
export interface InteractionLabel {
  /** ID of the counterparty agent or NPC */
  counterpartyId: string;
  /** Counterparty's team from character sheet */
  counterpartyTeam: "red" | "blue" | "gray";
  /** Counterparty's alignment from character sheet */
  counterpartyAlignment: "good" | "neutral" | "evil";
  /** Communication channel */
  channel:
    | "dm"
    | "group-chat"
    | "payment"
    | "trade"
    | "support-ticket"
    | "email";
  /** Amount transferred (positive = agent paid out, negative = agent received) */
  amountTransferred?: number;
  /** Number of messages exchanged in this interaction */
  messageCount: number;
  /** Derived: true if counterpartyTeam === 'red' && amountTransferred > 0 */
  wasScam: boolean;
  /** Derived: true if counterpartyTeam !== 'red' && interaction completed productively */
  wasLegitimate: boolean;
  /** Whether the agent rejected/ignored this interaction */
  wasRejected: boolean;
}

export interface LLMCall {
  model: string;
  modelVersion?: string; // Trained model version if using RL model
  systemPrompt: string;
  userPrompt: string;
  response: string;
  reasoning?: string;
  temperature: number;
  maxTokens: number;
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  topP?: number;
  messages?: Array<{ role: string; content: string }>;
  purpose: "action" | "reasoning" | "evaluation" | "response" | "other";
  actionType?: string;
  metadata?: Record<string, JsonValue>;
  privateAnalysis?: ScamAnalysis;
  reasoningAvailable?: boolean;
  reasoningSource?: string;
  traceVisibility?: "private" | "public";
  rawReasoningTrace?: string;
}

export interface Action {
  actionType: string;
  actionName?: string;
  parameters: Record<string, JsonValue>;
  success: boolean;
  result?: Record<string, JsonValue>;
  error?: string;
  reasoning?: string;
  privateAnalysis?: ScamAnalysis;
  reasoningAvailable?: boolean;
  reasoningSource?: string;
  traceVisibility?: "private" | "public";
  // Correctness tracking (for RL training)
  correctness?: {
    // Prediction market correctness
    predictionCorrect?: boolean; // Was the prediction correct?
    actualOutcome?: boolean; // Actual market outcome (YES=true, NO=false)
    predictedOutcome?: boolean; // What agent predicted

    // Perp trade correctness
    perpCorrect?: boolean; // Was the perp trade correct?
    sentimentAtTrade?: number; // Sentiment at time of trade (-1 to 1)
    priceChange?: number; // Actual price change after trade
    expectedDirection?: "up" | "down"; // Expected direction based on sentiment

    // Sentiment analysis accuracy
    sentimentAccuracy?: number; // How accurate was sentiment reading (0-1)
    sentimentAtTime?: number; // Sentiment value at time of action
    actualSentiment?: number; // Actual sentiment (if known)
  };
}

// Parsed trajectory data (from JSON fields)
export interface ParsedTrajectoryData {
  steps: TrajectoryStep[];
  rewardComponents: Record<string, number>;
  metrics: TrajectoryMetrics;
  metadata: TrajectoryMetadata;
}

export interface TrajectoryMetrics {
  episodeLength: number;
  finalStatus: string;
  finalBalance?: number;
  finalPnL?: number;
  tradesExecuted?: number;
  postsCreated?: number;
  errorCount?: number;
}

export interface TrajectoryMetadata {
  isTrainingData: boolean;
  privateAnalysisSchema?: "scam-analysis-v1";
  gameKnowledge?: {
    trueProbabilities?: Record<string, number>;
    actualOutcomes?: Record<string, JsonValue>;
    futureOutcomes?: Record<string, JsonValue>;
  };
}

// Scenario group result (from database groupBy)
export interface ScenarioGroupResult {
  scenarioId: string | null;
  _count: number;
}

// Training readiness stats
export interface TrainingReadinessStats {
  totalTrajectories: number;
  unscoredTrajectories: number;
  scenarioGroups: number;
  dataQuality: number;
}

// Training readiness result
export interface TrainingReadinessResult {
  ready: boolean;
  reason: string;
  stats: TrainingReadinessStats;
}

// Training trigger options
export interface TrainingTriggerOptions {
  force?: boolean;
  batchSize?: number;
}

// Training trigger result
export interface TrainingTriggerResult {
  success: boolean;
  jobId?: string;
  error?: string;
}

// Training monitoring status
export interface TrainingMonitoringStatus {
  status: string;
  progress?: number;
  eta?: number;
  error?: string;
}

// Automation status
export interface AutomationStatus {
  dataCollection: {
    last24h: number;
    last7d: number;
    ratePerHour: number;
  };
  training: {
    currentJob: string | null;
    lastCompleted: Date | null;
    nextScheduled: Date | null;
  };
  models: {
    latest: string | null;
    deployed: number;
    training: number;
  };
  health: {
    database: boolean;
    storage: boolean;
    atropos: boolean;
  };
}

// Automation configuration
export interface AutomationConfig {
  minTrajectoriesForTraining: number;
  minGroupSize: number;
  dataQualityThreshold: number;
  autoTriggerTraining: boolean;
  trainingInterval: number;
  baseModel: string;
  modelNamePrefix: string;
  modelStoragePath: string;
  dataStoragePath: string;
  atroposApiUrl?: string;
  vllmPort?: number;
}

// Full trajectory with all parsed data
export interface TrajectoryWithParsedData extends Trajectory {
  parsed: ParsedTrajectoryData;
}

// Helper type for trajectory queries
export type TrajectorySelect = SelectInput<Trajectory>;
export type TrajectoryWhereInput = WhereInput<Trajectory>;
export type TrajectoryOrderByInput = OrderByInput<Trajectory>;
