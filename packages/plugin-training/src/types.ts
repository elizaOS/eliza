import { type UUID, Memory, State, IAgentRuntime, type Service } from '@elizaos/core';

/**
 * Training data extraction configuration
 */
export interface TrainingConfig {
  // Data extraction settings
  extractionConfig: {
    startDate?: Date;
    endDate?: Date;
    minConversationLength?: number;
    maxConversationLength?: number;
    includeSystemMessages?: boolean;
    includeActions?: boolean;
    includeProviders?: boolean;
    includeEvaluators?: boolean;
    filterByStatus?: string[];
    includePlugins?: string[];
    excludePlugins?: string[];
  };

  // Dataset preparation settings
  datasetConfig: {
    outputFormat: 'jsonl' | 'csv' | 'parquet';
    splitRatio: {
      train: number;
      validation: number;
      test: number;
    };
    maxTokens?: number;
    tokenizer?: string;
    deduplicate?: boolean;
    minQuality?: number;
  };

  // RLAIF training settings
  rlaifConfig: {
    judgeModel: string;
    preferenceDescription: string;
    maxResponseVariants: number;
    scoringStrategy: 'pairwise' | 'pointwise';
    rewardThreshold: number;
  };

  // Atropos integration settings
  atroposConfig: {
    apiUrl: string;
    environment: string;
    batchSize: number;
    maxSteps: number;
    learningRate: number;
    warmupSteps: number;
    evalSteps: number;
    saveSteps: number;
  };

  // Cloud deployment settings
  deploymentConfig?: {
    provider: 'gcp' | 'aws' | 'azure';
    region: string;
    instanceType: string;
    gpuType?: string;
    maxInstances: number;
    autoScaling?: boolean;
  };

  // Hugging Face integration
  huggingFaceConfig?: {
    organization: string;
    datasetName: string;
    modelName: string;
    private: boolean;
    license?: string;
  };
}

/**
 * Extracted training conversation
 */
export interface TrainingConversation {
  id: UUID;
  roomId: UUID;
  worldId?: UUID;
  agentId: UUID;
  participants: UUID[];
  messages: TrainingMessage[];
  metadata: {
    startTime: number;
    endTime: number;
    messageCount: number;
    averageResponseTime?: number;
    actionCount: number;
    successfulActions: number;
    quality?: number;
    topics?: string[];
    outcomes?: string[];
  };
}

/**
 * Training message with extended metadata
 */
export interface TrainingMessage {
  id: UUID;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  entityId: UUID;
  metadata?: {
    thought?: string;
    actions?: string[];
    providers?: string[];
    evaluators?: string[];
    actionResults?: ActionResult[];
    providerResults?: ProviderResult[];
    evaluationResults?: EvaluationResult[];
    tokenCount?: number;
    responseTime?: number;
    quality?: number;
  };
}

/**
 * Action execution result for training
 */
export interface ActionResult {
  actionName: string;
  success: boolean;
  duration: number;
  input: any;
  output?: any;
  error?: string;
  metadata?: any;
}

/**
 * Provider result for training
 */
export interface ProviderResult {
  providerName: string;
  success: boolean;
  duration: number;
  data?: any;
  error?: string;
  metadata?: any;
}

/**
 * Evaluation result for training
 */
export interface EvaluationResult {
  evaluatorName: string;
  success: boolean;
  duration: number;
  insights?: string[];
  facts?: string[];
  relationships?: any[];
  error?: string;
  metadata?: any;
}

/**
 * Training trajectory for RLAIF
 */
export interface TrainingTrajectory {
  id: string;
  prompt: string;
  responses: TrainingResponse[];
  scores: number[];
  preferredResponseIndex?: number;
  metadata: {
    domain: string;
    difficulty: number;
    taskType: string;
    quality: number;
    timestamp: number;
  };
}

/**
 * Training response for RLAIF
 */
export interface TrainingResponse {
  text: string;
  actions?: string[];
  thought?: string;
  metadata?: {
    responseTime: number;
    tokenCount: number;
    confidence?: number;
  };
}

/**
 * Dataset statistics
 */
export interface DatasetStats {
  totalConversations: number;
  totalMessages: number;
  averageConversationLength: number;
  averageMessageLength: number;
  participantCount: number;
  timeSpan: {
    start: Date;
    end: Date;
    durationDays: number;
  };
  actionStats: {
    totalActions: number;
    successfulActions: number;
    actionTypes: Record<string, number>;
  };
  qualityMetrics: {
    averageQuality: number;
    highQualityCount: number;
    lowQualityCount: number;
  };
  topicDistribution: Record<string, number>;
}

/**
 * Training job status
 */
export interface TrainingJob {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  config: TrainingConfig;
  startTime?: Date;
  endTime?: Date;
  progress?: {
    currentStep: number;
    totalSteps: number;
    currentLoss: number;
    bestLoss: number;
    eta?: number;
  };
  metrics?: {
    trainingLoss: number[];
    validationLoss: number[];
    accuracy?: number[];
    rewardScore?: number[];
  };
  artifacts?: {
    modelPath?: string;
    datasetPath?: string;
    logsPath?: string;
    checkpointPaths?: string[];
  };
  error?: string;
  metadata?: any;
}

/**
 * Bridge communication message between TypeScript and Python
 */
export interface BridgeMessage {
  id: string;
  type: 'command' | 'response' | 'error' | 'progress' | 'log';
  payload: any;
  timestamp: number;
  source: 'typescript' | 'python';
}

/**
 * Atropos environment configuration
 */
export interface AtroposEnvironment {
  name: string;
  type: 'rlaif' | 'dataset' | 'interactive';
  config: {
    judgeModel?: string;
    datasetPath?: string;
    maxTurns?: number;
    timeout?: number;
    rewardFunction?: string;
  };
  serverUrl: string;
  status: 'inactive' | 'starting' | 'active' | 'stopping' | 'error';
}

/**
 * Cloud training instance configuration
 */
export interface CloudInstance {
  id: string;
  provider: string;
  region: string;
  instanceType: string;
  status: 'pending' | 'running' | 'stopping' | 'stopped' | 'terminated';
  publicIp?: string;
  privateIp?: string;
  tags: Record<string, string>;
  createdAt: Date;
  trainingJobId?: string;
}

/**
 * Plugin training service interface extending Service
 */
export interface TrainingServiceInterface extends Service {
  extractTrainingData(config: TrainingConfig): Promise<TrainingConversation[]>;
  prepareDataset(conversations: TrainingConversation[], config: TrainingConfig): Promise<string>;
  uploadToHuggingFace(datasetPath: string, config: TrainingConfig): Promise<string>;
  startTraining(config: TrainingConfig): Promise<TrainingJob>;
  monitorTraining(jobId: string): Promise<TrainingJob>;
  deployToCloud(config: TrainingConfig): Promise<CloudInstance>;
  stopTraining(jobId: string): Promise<void>;
  getTrainingStats(): Promise<DatasetStats>;
}

/**
 * JSONL Dataset types
 */
export interface JSONLDataset {
  train?: any[];
  validation?: any[];
  test?: any[];
  entries?: any[]; // Added for compatibility
  totalEntries?: number; // Added for compatibility
  format?: string; // Added for compatibility
  metadata: {
    totalSamples: number;
    trainSize: number;
    validationSize: number;
    testSize: number;
    features: string[];
    createdAt: Date;
    source?: string; // Added for compatibility
    augmented?: boolean; // Added for compatibility
    loadedAt?: Date; // Added for compatibility
    originalSize?: number; // Added for compatibility
    originalDataPoints?: number; // Added for compatibility
    filteredOut?: number; // Added for compatibility
    maxTokens?: number; // Added for compatibility
    includeThinking?: boolean; // Added for compatibility
    augmentationCount?: number; // Added for compatibility
  };
}

/**
 * Together.ai Configuration
 */
export interface TogetherAIConfig {
  apiKey: string;
  baseModel: string;
  trainingFile: string;
  trainingFileId?: string;
  validationFileId?: string;
  suffix?: string;
  learningRate?: number;
  epochs?: number;
  batchSize?: number;
  useLoRA?: boolean;
  trainingType?: 'full' | 'lora';
  hyperparameters?: Record<string, any>;
}

/**
 * Together.ai Training Job
 */
export interface TogetherAIJob {
  id: string;
  model: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  created_at: number;
  createdAt?: number; // Added for compatibility (converted property)
  finished_at?: number;
  training_file: string;
  trainingFileId?: string;
  validation_file?: string;
  result_files?: string[];
  hyperparameters?: Record<string, any>;
  fineTunedModel?: string; // Added for compatibility
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Together.ai Model Information
 */
export interface TogetherAIModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  permission: any[];
  root: string;
  parent?: string;
}

/**
 * Thinking Block for o1-style reasoning
 */
export interface ThinkingBlock {
  id: string;
  type:
    | 'reasoning'
    | 'planning'
    | 'analysis'
    | 'problem_solving'
    | 'plugin-creation'
    | 'mcp-creation';
  content: string;
  thinking?: string; // Added for compatibility
  request?: string; // Added for compatibility
  solution?: string; // Added for compatibility
  files?: any[]; // Added for compatibility
  outcome?: any; // Added for compatibility
  generatedAt?: Date; // Added for compatibility
  tokensUsed?: number; // Added for compatibility
  executionTime?: number; // Added for compatibility
  metadata: {
    complexity: 'low' | 'medium' | 'high' | 'simple' | 'complex';
    domain: string;
    duration_ms: number;
    step_count: number;
    confidence: number;
  };
}

/**
 * Code Generation Success Event
 */
export interface CodeGenerationSuccess {
  id: string;
  prompt: string;
  code: string;
  language: string;
  explanation: string;
  tests?: string;
  type?: string; // Added for compatibility
  quality?: number; // Added for top-level access
  request?: string; // Added for compatibility
  metadata: {
    complexity: number;
    tokensUsed: number;
    responseTime: number;
    quality: number;
  };
  // Additional properties for thinking block generator
  files?: any[];
  solution?: string;
}

/**
 * Plugin Creation Event
 */
export interface PluginCreationEvent {
  id: string;
  pluginName: string;
  description: string;
  features: string[];
  codeFiles: Array<{
    path: string;
    content: string;
    type: 'action' | 'provider' | 'evaluator' | 'service' | 'util';
  }>;
  metadata: {
    complexity: number;
    estimatedDevelopmentTime: number;
    dependencies: string[];
    testCoverage: number;
  };
  // Additional properties for thinking block generator
  originalRequest?: string;
  context?: string;
  outcome?: any;
  executionTime?: number; // Added for compatibility
  tokensUsed?: number; // Added for compatibility
}

/**
 * MCP Creation Event
 */
export interface MCPCreationEvent {
  id: string;
  serverName: string;
  description: string;
  tools: Array<{
    name: string;
    description: string;
    inputSchema: any;
    outputSchema: any;
  }>;
  metadata: {
    protocol: string;
    version: string;
    capabilities: string[];
  };
  // Additional properties for thinking block generator
  originalRequest?: string;
  context?: string;
  outcome?: any;
  executionTime?: number; // Added for compatibility
  tokensUsed?: number; // Added for compatibility
}

/**
 * Training Data Point for custom reasoning
 */
export interface TrainingDataPoint {
  id: UUID;
  timestamp: number;
  modelType: CustomModelType;
  type?: string; // Added for compatibility
  subtype?: string; // Added for compatibility
  request?: string; // Added for compatibility
  response?: string; // Added for compatibility
  thinking?: string; // Added for compatibility
  quality?: number; // Added for compatibility
  createdAt?: Date; // Added for compatibility
  context?: any; // Added for compatibility
  input: {
    prompt: string;
    messageText?: string;
    conversationContext?: any[];
    [key: string]: any;
  };
  output: {
    decision?: string;
    reasoning?: string;
    confidence?: number;
    [key: string]: any;
  };
  metadata: {
    agentId: UUID;
    roomId?: UUID;
    messageId?: UUID;
    modelName?: string;
    responseTimeMs?: number;
    tokensUsed?: number;
    costUsd?: number;
    [key: string]: any;
  };
}

/**
 * Custom Model Types
 */
export type CustomModelType =
  | 'should_respond'
  | 'planning'
  | 'coding'
  | 'autocoder'
  | 'conversation';

/**
 * Automation Pipeline Interface
 */
export interface AutomationPipeline {
  id: string;
  name: string;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'collecting-data' | 'cancelled';
  steps: PipelineStep[];
  metadata?: Record<string, any>;
  config?: Record<string, any>;
  datasets?: any[];
  models?: any[] | Record<string, any>;
  deploymentRecommendations?: Record<string, any>;
  startedAt?: number;
  deployment?: Record<string, any>;
  error?: string;
  completedAt?: number;
  phases?: Record<string, any>;
}

export interface PipelineStep {
  id: string;
  name: string;
  type: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  config: Record<string, any>;
}

/**
 * Model Deployment Decision
 */
export interface ModelDeploymentDecision {
  shouldDeploy: boolean;
  reasoning: string;
  reason?: string; // Alternative to reasoning
  confidence: number;
  estimatedCost: number;
  estimatedPerformanceGain: number;
  risks: string[];
  recommendations: string[];
  platform?: string;
  implementation?: string; // Added for compatibility
}
