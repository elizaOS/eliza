import type { UUID } from './primitives';

/**
 * Defines when and how a workflow should be triggered
 */
export interface WorkflowTrigger {
  /** Type of trigger */
  type: 'event' | 'schedule' | 'manual' | 'webhook';
  /** Event name(s) that trigger the workflow */
  event?: string | string[];
  /** Cron expression for scheduled triggers */
  schedule?: string;
  /** Conditions that must be met for the trigger to fire */
  conditions?: WorkflowCondition[];
}

/**
 * Condition that must be met for workflow execution
 */
export interface WorkflowCondition {
  /** JSONPath to field in event payload */
  field: string;
  /** Comparison operator */
  operator: 'equals' | 'contains' | 'matches' | 'exists' | 'gt' | 'lt';
  /** Value to compare against */
  value?: any;
  /** Regular expression for 'matches' operator */
  regex?: string;
}

/**
 * Action to be executed as part of a workflow
 */
export interface WorkflowAction {
  /** Unique identifier for this action within the workflow */
  id: string;
  /** Name of the registered action to execute */
  name: string;
  /** Input parameters for the action */
  inputs: Record<string, any>;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Retry policy for failed actions */
  retryPolicy?: {
    maxAttempts: number;
    backoffMs: number;
  };
  /** What to do on error */
  onError?: 'stop' | 'continue' | 'goto';
  /** Action ID to jump to on error (when onError is 'goto') */
  errorHandler?: string;
}

/**
 * A step in the workflow execution
 */
export interface WorkflowStep {
  /** Unique identifier for this step */
  id: string;
  /** Type of step */
  type: 'action' | 'condition' | 'parallel' | 'loop';
  /** Action configuration (for 'action' type) */
  action?: WorkflowAction;
  /** Conditional branching (for 'condition' type) */
  condition?: {
    if: WorkflowCondition;
    then: string; // step ID
    else?: string; // step ID
  };
  /** Parallel execution (for 'parallel' type) */
  parallel?: string[]; // step IDs to run in parallel
  /** Loop configuration (for 'loop' type) */
  loop?: {
    over: string; // JSONPath to array
    as: string; // variable name
    steps: string[]; // step IDs
  };
  /** Next step ID (for sequential execution) */
  next?: string;
}

/**
 * Complete workflow definition
 */
export interface Workflow {
  /** Unique identifier */
  id: UUID;
  /** Human-readable name */
  name: string;
  /** Description of what the workflow does */
  description: string;
  /** Version string */
  version: string;
  /** Whether the workflow is enabled */
  enabled: boolean;
  /** What triggers this workflow */
  triggers: WorkflowTrigger[];
  /** Default input values */
  inputs?: Record<string, any>;
  /** Steps to execute */
  steps: WorkflowStep[];
  /** Output extraction configuration */
  outputs?: {
    [key: string]: string; // JSONPath to extract from context
  };
  /** Additional metadata */
  metadata?: Record<string, any>;
  /** Tags for categorization */
  tags?: string[];
}

/**
 * Runtime execution state of a workflow
 */
export interface WorkflowExecution {
  /** Unique execution ID */
  id: UUID;
  /** ID of the workflow being executed */
  workflowId: UUID;
  /** Current execution status */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  /** What triggered this execution */
  trigger: {
    type: string;
    event?: string;
    payload?: any;
  };
  /** Execution context (variables, results, etc.) */
  context: Record<string, any>;
  /** Currently executing step ID */
  currentStepId?: string;
  /** When execution started */
  startedAt: number;
  /** When execution completed */
  completedAt?: number;
  /** Error message if failed */
  error?: string;
  /** Final outputs */
  outputs?: Record<string, any>;
} 