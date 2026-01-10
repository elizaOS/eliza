/**
 * Type definitions for the Planning Plugin.
 */

import type { UUID, ActionResult, IAgentRuntime, Memory, State, Content, HandlerCallback } from '@elizaos/core';

/**
 * Execution model for plans.
 */
export type ExecutionModel = 'sequential' | 'parallel' | 'dag';

/**
 * Plan status.
 */
export type PlanStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Extended action plan with full metadata.
 */
export interface ExtendedActionPlan {
  id: string;
  goal: string;
  thought: string;
  totalSteps: number;
  currentStep: number;
  steps: ActionStepExtended[];
  executionModel: ExecutionModel;
  createdAt: number;
  context?: PlanningContext;
}

/**
 * Planning context for plan creation.
 */
export interface PlanningContext {
  goal: string;
  message?: Memory;
  state?: State;
  constraints?: Array<{
    type: 'time' | 'resource' | 'custom';
    value: string | number;
    description?: string;
  }>;
  availableActions?: string[];
  preferences?: {
    executionModel?: ExecutionModel;
    maxSteps?: number;
    timeoutMs?: number;
  };
}

/**
 * Plan state during execution.
 */
export interface PlanState {
  status: PlanStatus;
  currentStepIndex: number;
  startTime?: number;
  endTime?: number;
  error?: string;
}

/**
 * Result from plan execution.
 */
export interface PlanExecutionResult {
  planId: string;
  success: boolean;
  completedSteps: number;
  totalSteps: number;
  results: ActionResult[];
  error?: string;
  duration?: number;
}

/**
 * Working memory interface for plan execution.
 */
export interface WorkingMemoryData {
  [key: string]: unknown;
}

/**
 * Planning service interface.
 */
export interface IPlanningService {
  createSimplePlan(goal: string, message?: Memory, state?: State): Promise<ExtendedActionPlan>;
  createComprehensivePlan(context: PlanningContext): Promise<ExtendedActionPlan>;
  executePlan(plan: ExtendedActionPlan, message: Memory, state: State, callback?: HandlerCallback): Promise<PlanExecutionResult>;
  validatePlan(plan: ExtendedActionPlan): Promise<{ valid: boolean; errors: string[]; warnings: string[] }>;
  cancelPlan(planId: string): Promise<boolean>;
  getPlanStatus(planId: string): Promise<PlanState | null>;
  adaptPlan(planId: string, newContext: PlanningContext, reason: string): Promise<ExtendedActionPlan | null>;
}

/**
 * Strategy specification for planning.
 */
export interface StrategySpec {
  goal: string;
  requirements: string[];
  constraints: Record<string, unknown>;
  expectedOutcome: string;
}

/**
 * Execution step in a plan.
 */
export interface ExecutionStep {
  id: string;
  action: string;
  inputs: Record<string, unknown>;
  dependencies: string[];
  optional: boolean;
}

/**
 * Directed Acyclic Graph representation for plan execution.
 */
export interface ExecutionDAG {
  steps: ExecutionStep[];
  edges: Array<[string, string]>;
  metadata: Record<string, unknown>;
}

/**
 * Execution result from a plan run.
 */
export interface ExecutionResult {
  dagId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
  completedSteps: string[];
  failedSteps: string[];
  results: Record<string, unknown>;
  errors: Record<string, string>;
}

/**
 * Required capability for a plan.
 */
export interface RequiredCapability {
  type: 'action' | 'provider' | 'service' | 'model';
  name: string;
  description?: string;
  required: boolean;
}

/**
 * Gap in capabilities identified during planning.
 */
export interface CapabilityGap {
  capability: RequiredCapability;
  suggestions: string[];
  canGenerate: boolean;
}

/**
 * Method for generating missing capabilities.
 */
export interface GenerationMethod {
  type: 'plugin' | 'mcp' | 'n8n' | 'custom';
  confidence: number;
  estimatedTime: number;
}

/**
 * Classification of incoming messages.
 */
export enum MessageClassification {
  SIMPLE = 'simple',
  STRATEGIC = 'strategic',
  CAPABILITY_REQUEST = 'capability_request',
  RESEARCH_NEEDED = 'research_needed',
}

/**
 * Planning context for comprehensive planning.
 */
export interface PlanningContextExtended {
  goal: string;
  constraints: Array<{
    type: 'time' | 'resource' | 'custom';
    value: string | number;
    description?: string;
  }>;
  availableActions: string[];
  availableProviders?: string[];
  preferences?: {
    executionModel?: 'sequential' | 'parallel' | 'dag';
    maxSteps?: number;
    timeoutMs?: number;
  };
}

/**
 * Working memory for plan execution.
 */
export interface PlanWorkingMemoryData {
  [key: string]: unknown;
}

/**
 * Plan execution tracking.
 */
export interface PlanExecutionState {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  startTime?: number;
  endTime?: number;
  currentStepIndex?: number;
  error?: Error;
}

/**
 * Retry policy for action steps.
 */
export interface RetryPolicy {
  maxRetries: number;
  backoffMs: number;
  backoffMultiplier: number;
  onError: 'abort' | 'continue' | 'skip';
}

/**
 * Extended action step with retry policy.
 */
export interface ActionStepExtended {
  id: UUID;
  actionName: string;
  parameters: Record<string, unknown>;
  dependencies: UUID[];
  retryPolicy?: RetryPolicy;
  onError?: 'abort' | 'continue' | 'skip';
}

/**
 * Message classification result.
 */
export interface ClassificationResult {
  classification: string;
  confidence: number;
  complexity: string;
  planningType: string;
  planningRequired: boolean;
  capabilities: string[];
  stakeholders: string[];
  constraints: string[];
  dependencies: string[];
}

