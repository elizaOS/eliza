import type { UUID } from './primitives';

/**
 * Represents the state of a plan execution
 */
export interface PlanState {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  startTime?: number;
  endTime?: number;
  currentStepIndex?: number;
  error?: Error;
}

/**
 * Represents a constraint on plan execution
 */
export interface Constraint {
  type: 'time' | 'resource' | 'dependency' | 'custom';
  value: any;
  description?: string;
}

/**
 * Represents a condition for action execution
 */
export interface Condition {
  type: 'state' | 'result' | 'time' | 'custom';
  operator: 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'matches';
  value: any;
  target: string;
}

/**
 * Represents expected outcome of an action
 */
export interface Outcome {
  success: boolean;
  data?: Record<string, any>;
  stateChanges?: string[];
}

/**
 * Retry policy for failed actions
 */
export interface RetryPolicy {
  maxRetries: number;
  backoffMs?: number;
  backoffMultiplier?: number;
  onError?: 'abort' | 'continue' | 'skip';
}

/**
 * Represents a single step in an action plan
 */
export interface ActionStep {
  id: UUID;
  actionName: string;
  parameters?: Record<string, any>;
  dependencies?: UUID[]; // Other step IDs
  conditions?: Condition[];
  expectedOutcome?: Outcome;
  retryPolicy?: RetryPolicy;
  onError?: 'abort' | 'continue' | 'skip';
}

/**
 * Represents a complete action plan
 */
export interface ActionPlan {
  id: UUID;
  goal: string;
  steps: ActionStep[];
  executionModel: 'sequential' | 'parallel' | 'dag' | 'reactive';
  state: PlanState;
  metadata: {
    createdAt: number;
    estimatedDuration?: number;
    priority?: number;
    constraints?: Constraint[];
    tags?: string[];
    adaptations?: string[];
  };
}

/**
 * Result of executing an action
 */
export interface ActionResult {
  values?: {
    [key: string]: any;
  };
  data?: {
    [key: string]: any;
  };
  text?: string;
}

/**
 * Context provided to actions during execution
 */
export interface ActionContext {
  planId?: UUID;
  stepId?: UUID;
  workingMemory?: WorkingMemory;
  previousResults?: ActionResult[];
  abortSignal?: AbortSignal;

  // Methods will be added by implementation
  updateMemory?: (key: string, value: any) => void;
  getMemory?: (key: string) => any;
  getPreviousResult?: (stepId: UUID) => ActionResult | undefined;
  requestReplanning?: () => Promise<ActionPlan>;
}

/**
 * Working memory interface for maintaining state across actions
 */
export interface WorkingMemory {
  set(key: string, value: any): void;
  get(key: string): any;
  has(key: string): boolean;
  delete(key: string): boolean;
  clear(): void;
  entries(): IterableIterator<[string, any]>;
  serialize(): Record<string, any>;
}

/**
 * Result of executing a plan
 */
export interface PlanExecutionResult {
  planId: UUID;
  success: boolean;
  completedSteps: number;
  totalSteps: number;
  results: ActionResult[];
  errors?: Error[];
  duration: number;
  adaptations?: string[];
}

/**
 * Context for planning
 */
export interface PlanningContext {
  goal: string;
  constraints: Constraint[];
  availableActions: string[];
  availableProviders: string[];
  preferences?: {
    executionModel?: 'sequential' | 'parallel' | 'dag';
    maxSteps?: number;
    timeoutMs?: number;
  };
}

/**
 * Unified Planning Service Interface
 * Provides both simple inline planning and complex multi-step planning capabilities
 */
export interface IPlanningService {
  /**
   * Service identifier for registration
   */
  readonly serviceName: string;

  /**
   * Service type for categorization
   */
  readonly serviceType: string;

  /**
   * Service capability description
   */
  readonly capabilityDescription: string;

  /**
   * Creates a simple plan for basic message handling
   * Used by message-handling for backwards compatibility
   */
  createSimplePlan(
    runtime: import('./runtime').IAgentRuntime,
    message: import('./memory').Memory,
    state: import('./state').State,
    responseContent: import('./primitives').Content
  ): Promise<ActionPlan | null>;

  /**
   * Creates a comprehensive multi-step plan
   * Used for complex planning scenarios
   */
  createComprehensivePlan(
    runtime: import('./runtime').IAgentRuntime,
    context: PlanningContext,
    message?: import('./memory').Memory,
    state?: import('./state').State
  ): Promise<ActionPlan>;

  /**
   * Executes a plan with full runtime integration
   */
  executePlan(
    runtime: import('./runtime').IAgentRuntime,
    plan: ActionPlan,
    message: import('./memory').Memory,
    callback?: import('./components').HandlerCallback
  ): Promise<PlanExecutionResult>;

  /**
   * Validates a plan before execution
   */
  validatePlan(
    runtime: import('./runtime').IAgentRuntime,
    plan: ActionPlan
  ): Promise<{ valid: boolean; issues?: string[] }>;

  /**
   * Adapts a plan during execution based on results
   */
  adaptPlan(
    runtime: import('./runtime').IAgentRuntime,
    plan: ActionPlan,
    currentStepIndex: number,
    results: ActionResult[]
    error?: Error
  ): Promise<ActionPlan>;

  /**
   * Gets the current execution status of a plan
   */
  getPlanStatus(planId: UUID): Promise<PlanState | null>;

  /**
   * Cancels plan execution
   */
  cancelPlan(planId: UUID): Promise<boolean>;

  /**
   * Cleanup method called when service is stopped
   */
  stop(): Promise<void>;
}
