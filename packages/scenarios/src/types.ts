import type { IAgentRuntime, UUID, Content } from '@elizaos/core';

export interface ScenarioActor {
  id: UUID;
  name: string;
  role: 'subject' | 'observer' | 'assistant' | 'adversary';
  personality?: {
    traits?: string[];
    systemPrompt?: string;
    interests?: string[];
  };
  knowledge?: string[];
  settings?: Record<string, any>;
  script?: ScenarioScript;
  runtime?: IAgentRuntime;
  bio?: string;
  system?: string;
  plugins?: string[];
}

export interface ScenarioScript {
  steps: ScriptStep[];
  personality?: string;
  goals?: string[];
  triggers?: ScriptTrigger[];
}

export interface ScriptStep {
  id?: string;
  type: 'message' | 'wait' | 'react' | 'assert' | 'action' | 'condition';
  content?: string;
  waitTime?: number;
  reaction?: string;
  assertion?: Assertion;
  action?: string;
  actionName?: string;
  actionParams?: Record<string, any>;
  trigger?: string;
  condition?: string;
  description?: string;
  timeout?: number;
  critical?: boolean;
}

export interface ScriptTrigger {
  on: 'message_received' | 'keyword' | 'timer' | 'custom';
  condition: string;
  response: ScriptStep[];
}

export interface Assertion {
  type: 'contains' | 'regex' | 'count' | 'timing' | 'custom';
  value: any;
  description: string;
}

export interface ScenarioSetup {
  roomType?: 'group' | 'dm' | 'public';
  roomName?: string;
  context?: string;
  initialMessages?: Message[];
  environment?: Record<string, any>;
}

export interface ScenarioExecution {
  maxDuration?: number;
  maxSteps?: number;
  timeout?: number;
  stopConditions?: StopCondition[];
}

export interface StopCondition {
  type: 'message_count' | 'time_elapsed' | 'keyword' | 'custom';
  value: any;
  description: string;
}

export interface ScenarioVerification {
  rules: VerificationRule[];
  expectedOutcomes?: ExpectedOutcome[];
  groundTruth?: GroundTruth;
}

export interface VerificationRule {
  id: string;
  type: 'llm'; // All verification is now LLM-based for maximum intelligence
  description: string;
  config: VerificationConfig;
  weight?: number;
}

export interface VerificationConfig {
  successCriteria?: string;
  priority?: string;
  category?: string;
  dynamicallyGenerated?: boolean;
  context?: Record<string, any>;
  expectedValue?: string;
  criteria?: string;
  deterministicType?: string;
  minMessages?: number;
  maxMessages?: number;
  requiredKeywords?: string[];
  forbiddenKeywords?: string[];
  llmEnhancement?: boolean;
  [key: string]: any; // Allow arbitrary properties for LLM-determined configurations
}

export interface ExpectedOutcome {
  actorId: string;
  outcome: string;
  verification: VerificationRule;
}

export interface GroundTruth {
  correctAnswer?: any;
  expectedBehavior?: string;
  successCriteria?: string[];
}

export interface BenchmarkCriteria {
  maxDuration?: number;
  maxSteps?: number;
  maxTokens?: number;
  maxMemoryUsage?: number;
  targetAccuracy?: number;
  customMetrics?: Array<{
    name: string;
    threshold?: number;
  }>;
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  category?: string;
  tags?: string[];
  actors: ScenarioActor[];
  setup: ScenarioSetup;
  execution: ScenarioExecution;
  verification: ScenarioVerification;
  benchmarks?: BenchmarkCriteria;
  expectations?: {
    messagePatterns?: Array<{
      pattern: string;
      flags?: string;
    }>;
    responseTime?: {
      max: number;
    };
    actionCalls?: string[];
  };
  roomId?: UUID;
  metadata?: Record<string, any>;
}

export interface ScenarioResult {
  scenarioId: string;
  name: string;
  startTime: number;
  endTime: number;
  duration: number;
  passed: boolean;
  score?: number;
  metrics: ScenarioMetrics;
  verificationResults: VerificationResult[];
  transcript: ScenarioMessage[];
  errors?: string[];
  warnings?: string[];
}

export interface ScenarioMetrics {
  duration: number;
  messageCount: number;
  stepCount: number;
  tokenUsage: TokenUsage;
  memoryUsage: MemoryUsage;
  actionCounts: Record<string, number>;
  responseLatency: LatencyMetrics;
  customMetrics?: Record<string, any>;
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
  cost?: number;
}

export interface MemoryUsage {
  peak: number;
  average: number;
  memoryOperations: number;
}

export interface LatencyMetrics {
  min: number;
  max: number;
  average: number;
  p95: number;
}

export interface VerificationResult {
  ruleId: string;
  ruleName: string;
  passed: boolean;
  score?: number;
  confidence?: number;
  reason?: string;
  reasoning?: string;
  evidence?: any[];
  executionTime?: number;
  metadata?: Record<string, any>;
}

export interface ScenarioMessage {
  id: string;
  timestamp: number;
  actorId: string;
  actorName: string;
  content: Content;
  roomId: string;
  messageType: 'incoming' | 'outgoing' | 'system';
  metadata?: Record<string, any>;
}

export interface ScenarioRunOptions {
  scenarios?: string[];
  filter?: string;
  benchmark?: boolean;
  verbose?: boolean;
  outputFormat?: 'json' | 'text' | 'html';
  outputFile?: string;
  parallel?: boolean;
  maxConcurrency?: number;
}

export interface ScenarioSuite {
  name: string;
  description?: string;
  scenarios: Scenario[];
  globalSetup?: ScenarioSetup;
  globalTeardown?: () => Promise<void>;
}

export interface ScenarioContext {
  scenario: Scenario;
  actors: Map<string, ScenarioActor>;
  roomId: UUID;
  worldId: UUID;
  startTime: number;
  transcript: ScenarioMessage[];
  metrics: Partial<ScenarioMetrics>;
  state: Record<string, any>;
}

export interface BenchmarkReport {
  scenarioId: string;
  scenarioName: string;
  timestamp: number;
  metrics: ScenarioMetrics;
  performance: PerformanceScore;
  comparison?: BaselineComparison;
  artifacts?: string[];
}

export interface PerformanceScore {
  overall: number;
  speed: number;
  accuracy: number;
  efficiency: number;
  reliability: number;
}

export interface BaselineComparison {
  baselineVersion: string;
  improvement: number;
  regression: string[];
  improvements: string[];
}

export interface ScenarioError extends Error {
  scenarioId: string;
  actorId?: string;
  step?: string;
  context?: Record<string, any>;
}

export interface ScenarioProgressCallback {
  (progress: {
    scenarioId: string;
    phase: 'setup' | 'execution' | 'verification' | 'teardown';
    step: number;
    totalSteps: number;
    message?: string;
  }): void;
}

export interface Message {
  id: string;
  content: string;
  sender: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

// Additional types for production scenario runner
export interface ScenarioExecutionResult {
  scenario: string;
  status: 'passed' | 'failed' | 'partial';
  duration: number;
  transcript: TranscriptMessage[];
  errors: string[];
  metrics?: MetricsReport;
}

export interface TranscriptMessage {
  id: UUID;
  timestamp: number;
  actorId: UUID;
  actorName: string;
  content: Content;
  messageType: 'incoming' | 'outgoing';
}

export interface MetricsReport {
  scenario: string;
  timestamp: number;
  duration: number;
  messageCount: number;
  avgResponseTime: number;
  benchmarks: BenchmarkResult[];
  failures?: BenchmarkFailure[];
}

export interface BenchmarkResult {
  metric: string;
  value: number;
  threshold?: number;
  passed: boolean;
}

export interface BenchmarkFailure {
  metric: string;
  reason: string;
}

export interface BenchmarkExpectation {
  name: string;
  threshold: number;
  comparison: 'less_than' | 'greater_than' | 'equals';
}

// Scenario Manifest System Types
export interface ScenarioManifest {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  plugins: PluginDependency[];
  environment: EnvironmentRequirement[];
  actors: ActorRequirement[];
  setup: ScenarioSetup;
  execution: ScenarioExecution;
  verification: ScenarioVerification;
  benchmarks?: BenchmarkCriteria;
}

export interface PluginDependency {
  name: string;
  version?: string;
  required: boolean;
  config?: Record<string, any>;
}

export interface EnvironmentRequirement {
  name: string;
  type: 'secret' | 'config' | 'service' | 'database';
  required: boolean;
  description?: string;
  defaultValue?: string;
  validation?: string;
}

export interface ActorRequirement {
  role: 'subject' | 'observer' | 'assistant' | 'adversary';
  plugins: string[];
  config?: Record<string, any>;
}

export interface ScenarioValidationResult {
  scenario: string;
  valid: boolean;
  errors: ScenarioValidationError[];
  warnings: ScenarioValidationWarning[];
  pluginStatus: PluginValidationStatus[];
  environmentStatus: EnvironmentValidationStatus[];
}

export interface ScenarioValidationError {
  type: 'plugin' | 'environment' | 'config' | 'runtime';
  message: string;
  severity: 'error' | 'warning';
  context?: Record<string, any>;
}

export interface ScenarioValidationWarning {
  type: 'plugin' | 'environment' | 'config' | 'performance';
  message: string;
  suggestion?: string;
}

export interface PluginValidationStatus {
  name: string;
  available: boolean;
  version?: string;
  compatible: boolean;
  errors?: string[];
}

export interface EnvironmentValidationStatus {
  name: string;
  present: boolean;
  valid: boolean;
  value?: string;
  errors?: string[];
}