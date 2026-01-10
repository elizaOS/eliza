import type { UUID } from '@elizaos/core';

// Extend the core service types with autonomous service
declare module '@elizaos/core' {
  interface ServiceTypeRegistry {
    AUTONOMOUS: 'autonomous';
  }
}

// Export service type constant
export const AutonomousServiceType = {
  AUTONOMOUS: 'autonomous' as const,
} satisfies Partial<import('@elizaos/core').ServiceTypeRegistry>;

export enum EventType {
  AUTO_MESSAGE_RECEIVED = 'auto_message_received',
}

// OODA Loop Types
export interface OODAContext {
  runId: string;
  startTime: number;
  phase: OODAPhase;
  observations: Observation[];
  orientation: Orientation;
  decisions: Decision[];
  actions: ActionExecution[];
  errors: Error[];
  metrics: LoopMetrics;
}

export enum OODAPhase {
  IDLE = 'idle',
  OBSERVING = 'observing',
  ORIENTING = 'orienting',
  DECIDING = 'deciding',
  ACTING = 'acting',
  REFLECTING = 'reflecting',
}

export interface Observation {
  timestamp: number;
  type: ObservationType;
  source: string;
  data: any;
  relevance: number;
}

export enum ObservationType {
  TASK_STATUS = 'task_status',
  SYSTEM_STATE = 'system_state',
  EXTERNAL_EVENT = 'external_event',
  RESOURCE_USAGE = 'resource_usage',
  ERROR_OCCURRED = 'error_occurred',
  GOAL_PROGRESS = 'goal_progress',
}

export interface Orientation {
  currentGoals: Goal[];
  activeProjects: Project[];
  resourceStatus: ResourceStatus;
  environmentalFactors: EnvironmentalFactor[];
  historicalContext: HistoricalContext;
}

export interface EnvironmentalFactor {
  type: string;
  description: string;
  impact: number; // -1 to 1, negative is hindrance, positive is help
  timestamp: number;
}

export interface HistoricalContext {
  recentActions: ActionExecution[];
  recentErrors: ErrorContext[];
  successPatterns: string[];
  failurePatterns: string[];
  learnings: Learning[];
}

export interface Learning {
  id: UUID;
  timestamp: number;
  context: {
    goals: string[];
    environment: string[];
    observations: string[];
  };
  outcome: 'success' | 'failure';
  pattern: string;
  confidence: number;
  applicableConditions: string[];
  embedding?: number[];
}

export interface SuccessPattern {
  id: UUID;
  pattern: string;
  frequency: number;
  confidence: number;
  lastOccurrence: number;
  conditions: string[];
  outcomes: string[];
  embedding?: number[];
}

export interface FailurePattern {
  id: UUID;
  pattern: string;
  frequency: number;
  severity: number;
  lastOccurrence: number;
  causes: string[];
  mitigations: string[];
  embedding?: number[];
}

export interface Decision {
  id: string;
  timestamp: number;
  type: DecisionType;
  reasoning: string;
  confidence: number;
  expectedOutcome: string;
  alternativesConsidered: Alternative[];
  chosenActionIds: string[];
}

export interface ActionExecution {
  id: string;
  decisionId: string;
  actionName: string;
  startTime: number;
  endTime?: number;
  status: ActionStatus;
  result?: any;
  error?: Error;
  resourcesUsed: ResourceUsage;
}

export interface LoopMetrics {
  cycleTime: number;
  decisionsPerCycle: number;
  actionSuccessRate: number;
  errorRate: number;
  resourceEfficiency: number;
  goalProgress: number;
}

// Logging Types
export interface LogEntry {
  runId: string;
  timestamp: number;
  level: LogLevel;
  phase: OODAPhase;
  message: string;
  data?: any;
  error?: Error;
}

export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
  FATAL = 'fatal',
}

// Additional supporting types
export interface Goal {
  id: string;
  description: string;
  priority: number;
  progress: number;
  subGoals?: Goal[];
  deadline?: number;
  dependencies?: string[];
}

export interface Project {
  id: string;
  name: string;
  goals: string[];
  status: ProjectStatus;
  resources: ResourceAllocation;
}

export interface ResourceStatus {
  cpu: number;
  memory: number;
  diskSpace: number;
  apiCalls: { [api: string]: number };
  taskSlots: { used: number; total: number };
}

export enum ProjectStatus {
  PLANNING = 'planning',
  ACTIVE = 'active',
  BLOCKED = 'blocked',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export enum ActionStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum DecisionType {
  START_PROJECT = 'start_project',
  CONTINUE_TASK = 'continue_task',
  PIVOT_STRATEGY = 'pivot_strategy',
  ALLOCATE_RESOURCES = 'allocate_resources',
  HANDLE_ERROR = 'handle_error',
  DEFER_ACTION = 'defer_action',
}

// Error handling types
export interface ErrorContext {
  runId: string;
  phase: OODAPhase;
  actionId?: string;
  errorType: ErrorType;
  severity: ErrorSeverity;
  recovery?: RecoveryStrategy;
}

export enum ErrorType {
  RESOURCE_EXHAUSTED = 'resource_exhausted',
  ACTION_FAILED = 'action_failed',
  DEPENDENCY_MISSING = 'dependency_missing',
  TIMEOUT = 'timeout',
  VALIDATION_ERROR = 'validation_error',
  EXTERNAL_SERVICE = 'external_service',
}

export enum ErrorSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export interface RecoveryStrategy {
  type: RecoveryType;
  retryCount?: number;
  backoffMs?: number;
  alternativeAction?: string;
}

export enum RecoveryType {
  RETRY = 'retry',
  BACKOFF = 'backoff',
  ALTERNATIVE = 'alternative',
  ESCALATE = 'escalate',
  ABORT = 'abort',
}

export interface Alternative {
  actionName: string;
  reasoning: string;
  expectedOutcome: string;
  confidence: number;
  risks: string[];
}

export interface ResourceUsage {
  cpuTime: number;
  memoryMB: number;
  apiCalls: { [api: string]: number };
  executionTimeMs: number;
}

export interface ResourceAllocation {
  cpuLimit: number;
  memoryLimitMB: number;
  apiCallLimits: { [api: string]: number };
  timeoutMs: number;
}
