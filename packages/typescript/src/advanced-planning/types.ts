import type {
  ActionParameters,
  ActionResult,
  HandlerCallback,
  Memory,
  State,
  UUID,
} from "../types/index.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ExecutionModel = "sequential" | "parallel" | "dag";

export type PlanStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

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

export interface RetryPolicy {
  maxRetries: number;
  backoffMs: number;
  backoffMultiplier: number;
  onError: "abort" | "continue" | "skip";
}

export interface ActionStepExtended {
  id: UUID;
  actionName: string;
  parameters: ActionParameters;
  dependencies: UUID[];
  retryPolicy?: RetryPolicy;
  onError?: "abort" | "continue" | "skip";
}

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

export interface PlanExecutionResult {
  planId: string;
  success: boolean;
  completedSteps: number;
  totalSteps: number;
  results: ActionResult[];
  error?: string;
  duration?: number;
}

export interface PlanState {
  status: PlanStatus;
  currentStepIndex: number;
  startTime?: number;
  endTime?: number;
  error?: string;
}

export interface IPlanningService {
  createSimplePlan(
    goal: string,
    message?: Memory,
    state?: State,
  ): Promise<ExtendedActionPlan>;
  createComprehensivePlan(
    context: PlanningContext,
  ): Promise<ExtendedActionPlan>;
  executePlan(
    plan: ExtendedActionPlan,
    message: Memory,
    state: State,
    callback?: HandlerCallback,
  ): Promise<PlanExecutionResult>;
  validatePlan(
    plan: ExtendedActionPlan,
  ): Promise<{ valid: boolean; errors: string[]; warnings: string[] }>;
  cancelPlan(planId: string): Promise<boolean>;
  getPlanStatus(planId: string): Promise<PlanState | null>;
  adaptPlan(
    planId: string,
    newContext: PlanningContext,
    reason: string,
  ): Promise<ExtendedActionPlan | null>;
}
