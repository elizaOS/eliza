import type {
  IAgentRuntime,
  Memory,
  State,
  UUID,
  Service,
  ServiceTypeName,
  Content,
} from '@elizaos/core';
import type { CustomModelType, TrainingDataPoint } from '../types.js';

// Re-export for convenience
export type { CustomModelType, TrainingDataPoint };

export interface CustomReasoningService extends Service {
  // Core reasoning capabilities
  shouldRespond(context: ShouldRespondContext): Promise<ShouldRespondResult>;
  planResponse(context: PlanningContext): Promise<PlanningResult>;
  generateCode(context: CodingContext): Promise<CodingResult>;

  // Model management
  enableModel(modelType: CustomModelType): Promise<void>;
  disableModel(modelType: CustomModelType): Promise<void>;
  getModelStatus(modelType: CustomModelType): Promise<ModelStatus>;

  // Training data collection
  collectTrainingData(interaction: TrainingDataPoint): Promise<void>;
  exportTrainingData(options: ExportOptions): Promise<TrainingDataset>;

  // Cost management
  getCostReport(): Promise<CostReport>;
  setBudgetLimit(limitUSD: number): Promise<void>;
  enableAutoShutdown(idleMinutes: number): Promise<void>;
}

export interface ShouldRespondContext {
  runtime: IAgentRuntime;
  message: Memory;
  state: State;
  conversationHistory: Memory[];
}

export interface ShouldRespondResult {
  decision: 'RESPOND' | 'IGNORE' | 'STOP';
  reasoning: string;
  confidence: number;
  trainingData: TrainingDataPoint;
}

export interface PlanningContext {
  runtime: IAgentRuntime;
  message: Memory;
  state: State;
  actionNames: string[];
}

export interface PlanningResult {
  thought: string;
  actions: string[];
  providers: string[];
  text: string;
  trainingData: TrainingDataPoint;
}

export interface CodingContext {
  prompt: string;
  language?: string;
  context?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface CodingResult {
  code: string;
  explanation?: string;
  trainingData: TrainingDataPoint;
}

export interface ModelConfig {
  name: string;
  size: 'ultra-small' | 'small' | 'medium' | 'large' | 'ultra-large';
  costPerHour: number;
  maxTokens: number;
  temperature: number;
  enabled: boolean;
  deploymentId?: string;
  endpoint?: string;
}

export interface ModelStatus {
  enabled: boolean;
  name: string;
  size: string;
  costPerHour: number;
  isDeployed: boolean;
  lastUsed?: number;
  totalRequests?: number;
  totalCost?: number;
}

export interface DeploymentInfo {
  deploymentId: string;
  endpoint: string;
  deployedAt: number;
  status: 'active' | 'inactive' | 'deploying' | 'error';
  costPerHour: number;
  lastUsed: number;
}

export interface CostReport {
  totalCost: number;
  modelCosts: Map<string, ModelCostInfo>;
  period: string;
  budgetLimit?: number;
  budgetUsed: number;
}

export interface ModelCostInfo {
  hoursActive: number;
  cost: number;
  requests: number;
  averageCostPerRequest: number;
}

export interface ExportOptions {
  modelType?: CustomModelType;
  limit?: number;
  offset?: number;
  startDate?: Date;
  endDate?: Date;
  format?: 'jsonl' | 'json';
}

export interface TrainingDataset {
  modelType?: CustomModelType;
  format: 'jsonl' | 'json';
  samples: TrainingSample[];
  metadata: {
    exportedAt: number;
    agentId: UUID;
    totalSamples: number;
    dateRange?: {
      start: number;
      end: number;
    };
  };
}

export interface TrainingSample {
  messages: {
    role: 'system' | 'user' | 'assistant';
    content: string;
  }[];
  metadata?: Record<string, any>;
}

export interface UsageMetrics {
  deploymentId: string;
  hoursActive: number;
  requests: number;
  totalTokens: number;
  cost: number;
  lastRequestAt: number;
}

// Configuration types
export interface CustomReasoningConfig {
  enabled: boolean;
  models: {
    shouldRespond?: {
      modelName: string;
      enabled: boolean;
    };
    planning?: {
      modelName: string;
      enabled: boolean;
    };
    coding?: {
      modelName: string;
      enabled: boolean;
    };
  };
  togetherAI: {
    apiKey: string;
    baseUrl?: string;
  };
  costManagement: {
    budgetLimitUSD?: number;
    autoShutdownIdleMinutes?: number;
    maxCostPerHour?: number;
  };
  trainingData: {
    collectData: boolean;
    maxSamplesPerModel?: number;
    retentionDays?: number;
  };
}
