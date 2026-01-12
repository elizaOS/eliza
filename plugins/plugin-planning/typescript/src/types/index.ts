import type { ActionResult, HandlerCallback, Memory, State, UUID } from "@elizaos/core";

export type ExecutionModel = "sequential" | "parallel" | "dag";

export type PlanStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

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

export interface PlanningContext {
  goal: string;
  message?: Memory;
  state?: State;
  constraints?: Array<{
    type: "time" | "resource" | "custom";
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

export interface PlanExecutionResult {
  planId: string;
  success: boolean;
  completedSteps: number;
  totalSteps: number;
  results: ActionResult[];
  error?: string;
  duration?: number;
}

export interface WorkingMemoryData {
  [key: string]: unknown;
}

export interface IPlanningService {
  createSimplePlan(goal: string, message?: Memory, state?: State): Promise<ExtendedActionPlan>;
  createComprehensivePlan(context: PlanningContext): Promise<ExtendedActionPlan>;
  executePlan(
    plan: ExtendedActionPlan,
    message: Memory,
    state: State,
    callback?: HandlerCallback
  ): Promise<PlanExecutionResult>;
  validatePlan(
    plan: ExtendedActionPlan
  ): Promise<{ valid: boolean; errors: string[]; warnings: string[] }>;
  cancelPlan(planId: string): Promise<boolean>;
  getPlanStatus(planId: string): Promise<PlanState | null>;
  adaptPlan(
    planId: string,
    newContext: PlanningContext,
    reason: string
  ): Promise<ExtendedActionPlan | null>;
}

export interface StrategySpec {
  goal: string;
  requirements: string[];
  constraints: Record<string, unknown>;
  expectedOutcome: string;
}

export interface ExecutionStep {
  id: string;
  action: string;
  inputs: Record<string, unknown>;
  dependencies: string[];
  optional: boolean;
}

export interface ExecutionDAG {
  steps: ExecutionStep[];
  edges: Array<[string, string]>;
  metadata: Record<string, unknown>;
}

export interface ExecutionResult {
  dagId: string;
  status: "pending" | "running" | "completed" | "failed" | "aborted";
  completedSteps: string[];
  failedSteps: string[];
  results: Record<string, unknown>;
  errors: Record<string, string>;
}

export interface RequiredCapability {
  type: "action" | "provider" | "service" | "model";
  name: string;
  description?: string;
  required: boolean;
}

export interface CapabilityGap {
  capability: RequiredCapability;
  suggestions: string[];
  canGenerate: boolean;
}

export interface GenerationMethod {
  type: "plugin" | "mcp" | "n8n" | "custom";
  confidence: number;
  estimatedTime: number;
}

export enum MessageClassification {
  SIMPLE = "simple",
  STRATEGIC = "strategic",
  CAPABILITY_REQUEST = "capability_request",
  RESEARCH_NEEDED = "research_needed",
}

export interface PlanningContextExtended {
  goal: string;
  constraints: Array<{
    type: "time" | "resource" | "custom";
    value: string | number;
    description?: string;
  }>;
  availableActions: string[];
  availableProviders?: string[];
  preferences?: {
    executionModel?: "sequential" | "parallel" | "dag";
    maxSteps?: number;
    timeoutMs?: number;
  };
}

export interface PlanWorkingMemoryData {
  [key: string]: unknown;
}

export interface PlanExecutionState {
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  startTime?: number;
  endTime?: number;
  currentStepIndex?: number;
  error?: Error;
}

export interface RetryPolicy {
  maxRetries: number;
  backoffMs: number;
  backoffMultiplier: number;
  onError: "abort" | "continue" | "skip";
}

export interface ActionStepExtended {
  id: UUID;
  actionName: string;
  parameters: Record<string, unknown>;
  dependencies: UUID[];
  retryPolicy?: RetryPolicy;
  onError?: "abort" | "continue" | "skip";
}

export interface ClassificationResult
  extends Record<
    string,
    string | number | boolean | null | undefined | string[] | Record<string, unknown>
  > {
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
