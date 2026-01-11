import {
  type ActionContext,
  type ActionResult,
  asUUID,
  type Content,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseKeyValueXml,
  Service,
  type State,
  type UUID,
} from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import type { PlanningContext as LocalPlanningContext, RetryPolicy } from "../types";

// Local type definitions for the planning service
interface ActionStep {
  id?: string;
  action?: string;
  actionName?: string;
  status?: "pending" | "completed" | "failed";
  error?: string;
  result?: ActionResult;
  parameters?: Record<string, unknown>;
  dependencies?: (string | UUID)[];
  retryPolicy?: RetryPolicy;
  onError?: "abort" | "continue" | "skip";
  _originalId?: string;
  _dependencyStrings?: string[];
}

interface ActionPlan {
  id?: string;
  goal?: string;
  thought: string;
  totalSteps: number;
  currentStep: number;
  steps: ActionStep[];
  executionModel?: "sequential" | "parallel" | "dag";
  createdAt?: number;
  state?: PlanState;
  metadata?: Record<string, unknown>;
}

interface PlanningContext extends LocalPlanningContext {
  availableProviders?: string[];
}

interface PlanState {
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  currentStepIndex?: number;
  startTime?: number;
  endTime?: number;
  error?: string;
}

interface PlanExecutionResult {
  planId: string;
  success: boolean;
  completedSteps: number;
  totalSteps: number;
  results: ActionResult[];
  errors?: (string | Error)[];
  error?: string | Error;
  duration?: number;
}

interface WorkingMemory {
  [key: string]: unknown;
}

/**
 * Working Memory Implementation for Plan Execution
 */
class PlanWorkingMemory {
  private memory = new Map<string, unknown>();
  [key: string]: unknown;

  set(key: string, value: unknown): void {
    this.memory.set(key, value);
  }

  get(key: string): unknown {
    return this.memory.get(key);
  }

  has(key: string): boolean {
    return this.memory.has(key);
  }

  delete(key: string): boolean {
    return this.memory.delete(key);
  }

  clear(): void {
    this.memory.clear();
  }

  entries(): IterableIterator<[string, unknown]> {
    return this.memory.entries();
  }

  serialize(): Record<string, unknown> {
    return Object.fromEntries(this.memory);
  }
}

/**
 * Production-Ready Planning Service Implementation
 * Provides unified planning capabilities with full runtime integration
 */
export class PlanningService extends Service {
  static serviceType = "planning";

  serviceType = "planning";
  capabilityDescription = "Provides comprehensive planning and action coordination capabilities";

  private activePlans = new Map<UUID, ActionPlan>();
  private planExecutions = new Map<
    UUID,
    {
      state: PlanState;
      workingMemory: WorkingMemory;
      results: ActionResult[];
      abortController?: AbortController;
    }
  >();

  static async start(runtime: IAgentRuntime): Promise<PlanningService> {
    const service = new PlanningService(runtime);
    logger.info("PlanningService started successfully");
    return service;
  }

  /**
   * Creates a simple plan for basic message handling (backwards compatibility)
   */
  async createSimplePlan(
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    responseContent?: Content
  ): Promise<ActionPlan | null> {
    try {
      logger.debug("[PlanningService] Creating simple plan for message handling");

      let actions: string[] = [];
      if (responseContent?.actions && responseContent.actions.length > 0) {
        actions = responseContent.actions;
      } else {
        const text = message.content.text?.toLowerCase() || "";
        logger.debug(`[PlanningService] Analyzing text: "${text}"`);
        if (text.includes("email")) {
          actions = ["SEND_EMAIL"];
        } else if (
          text.includes("research") &&
          (text.includes("send") || text.includes("summary"))
        ) {
          actions = ["SEARCH", "REPLY"];
        } else if (text.includes("search") || text.includes("find") || text.includes("research")) {
          actions = ["SEARCH"];
        } else if (text.includes("analyze")) {
          actions = ["THINK", "REPLY"];
        } else {
          actions = ["REPLY"];
        }
      }

      if (actions.length === 0) {
        return null;
      }

      const planId = asUUID(uuidv4());
      const stepIds: UUID[] = [];
      const steps: ActionStep[] = actions.map((actionName, index) => {
        const stepId = asUUID(uuidv4());
        stepIds.push(stepId);
        return {
          id: stepId,
          actionName,
          parameters: {
            message: responseContent?.text || message.content.text,
            thought: responseContent?.thought,
            providers: responseContent?.providers || [],
          },
          dependencies: index > 0 ? [stepIds[index - 1]] : [],
        };
      });

      const plan: ActionPlan = {
        id: planId,
        goal: responseContent?.text || `Execute actions: ${actions.join(", ")}`,
        thought: responseContent?.thought || `Executing ${actions.length} action(s)`,
        totalSteps: steps.length,
        currentStep: 0,
        steps,
        executionModel: "sequential",
        state: { status: "pending" },
        metadata: {
          createdAt: Date.now(),
          estimatedDuration: steps.length * 5000,
          priority: 1,
          tags: ["simple", "message-handling"],
        },
      };

      this.activePlans.set(planId, plan);
      logger.debug(`[PlanningService] Created simple plan ${planId} with ${steps.length} steps`);

      return plan;
    } catch (error) {
      logger.error("[PlanningService] Error creating simple plan:", error);
      return null;
    }
  }

  /**
   * Creates a comprehensive multi-step plan using LLM planning
   */
  async createComprehensivePlan(
    runtime: IAgentRuntime,
    context: PlanningContext,
    message?: Memory,
    state?: State
  ): Promise<ActionPlan> {
    try {
      if (!context.goal || context.goal.trim() === "") {
        throw new Error("Planning context must have a non-empty goal");
      }
      if (!Array.isArray(context.constraints)) {
        throw new Error("Planning context constraints must be an array");
      }
      if (!Array.isArray(context.availableActions)) {
        throw new Error("Planning context availableActions must be an array");
      }
      if (!context.preferences || typeof context.preferences !== "object") {
        throw new Error("Planning context preferences must be an object");
      }

      logger.info(`[PlanningService] Creating comprehensive plan for goal: ${context.goal}`);

      const planningPrompt = this.buildPlanningPrompt(context, runtime, message, state);

      const planningResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: planningPrompt,
        temperature: 0.3,
        maxTokens: 2000,
      });

      const parsedPlan = this.parsePlanningResponse(planningResponse as string, context);
      const enhancedPlan = await this.enhancePlan(runtime, parsedPlan, context);

      if (!enhancedPlan.id) {
        throw new Error("Enhanced plan missing id");
      }

      this.activePlans.set(enhancedPlan.id as UUID, enhancedPlan);

      logger.info(
        `[PlanningService] Created comprehensive plan ${enhancedPlan.id} with ${enhancedPlan.steps.length} steps`
      );

      return enhancedPlan;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("[PlanningService] Error creating comprehensive plan:", err.message);
      throw new Error(`Failed to create comprehensive plan: ${err.message}`);
    }
  }

  /**
   * Executes a plan with full runtime integration and error handling
   */
  async executePlan(
    runtime: IAgentRuntime,
    plan: ActionPlan,
    message: Memory,
    callback?: HandlerCallback
  ): Promise<PlanExecutionResult> {
    const startTime = Date.now();
    const workingMemory = new PlanWorkingMemory();
    const results: ActionResult[] = [];
    const errors: Error[] = [];
    const abortController = new AbortController();

    const executionState: PlanState = {
      status: "running",
      startTime,
      currentStepIndex: 0,
    };

    this.planExecutions.set(plan.id as UUID, {
      state: executionState,
      workingMemory,
      results,
      abortController,
    });

    try {
      logger.info(`[PlanningService] Starting execution of plan ${plan.id as string}`);

      if (plan.executionModel === "sequential") {
        await this.executeSequential(
          runtime,
          plan,
          message,
          workingMemory,
          results,
          errors,
          callback,
          abortController.signal
        );
      } else if (plan.executionModel === "parallel") {
        await this.executeParallel(
          runtime,
          plan,
          message,
          workingMemory,
          results,
          errors,
          callback,
          abortController.signal
        );
      } else if (plan.executionModel === "dag") {
        await this.executeDAG(
          runtime,
          plan,
          message,
          workingMemory,
          results,
          errors,
          callback,
          abortController.signal
        );
      } else {
        throw new Error(`Unsupported execution model: ${plan.executionModel}`);
      }

      executionState.status = errors.length > 0 ? "failed" : "completed";
      executionState.endTime = Date.now();

      const result: PlanExecutionResult = {
        planId: plan.id as UUID,
        success: errors.length === 0,
        completedSteps: results.length,
        totalSteps: plan.steps.length,
        results,
        errors: errors.length > 0 ? errors : undefined,
        duration: Date.now() - startTime,
      };

      logger.info(
        `[PlanningService] Plan ${plan.id} execution completed. Success: ${result.success}, Duration: ${result.duration}ms`
      );

      return result;
    } catch (error) {
      logger.error(`[PlanningService] Plan ${plan.id} execution failed:`, error);

      executionState.status = "failed";
      executionState.endTime = Date.now();
      executionState.error = error instanceof Error ? error.message : String(error);

      return {
        planId: plan.id as UUID,
        success: false,
        completedSteps: results.length,
        totalSteps: plan.steps.length,
        results,
        errors: [error instanceof Error ? error : new Error(String(error)), ...errors],
        duration: Date.now() - startTime,
      };
    } finally {
      this.planExecutions.delete(plan.id as UUID);
    }
  }

  /**
   * Validates a plan before execution
   */
  async validatePlan(
    runtime: IAgentRuntime,
    plan: ActionPlan
  ): Promise<{ valid: boolean; errors: string[]; warnings: string[] }> {
    const issues: string[] = [];

    try {
      if (!plan.id || !plan.goal || !plan.steps) {
        issues.push("Plan missing required fields (id, goal, or steps)");
      }

      if (plan.steps.length === 0) {
        issues.push("Plan has no steps");
      }

      for (const step of plan.steps) {
        if (!step.id || !step.actionName) {
          issues.push(`Step missing required fields: ${JSON.stringify(step)}`);
          continue;
        }

        const action = runtime.actions.find((a) => a.name === step.actionName);
        if (!action) {
          issues.push(`Action '${step.actionName}' not found in runtime`);
        }
      }

      const stepIds = new Set(plan.steps.map((s) => s.id as UUID));
      for (const step of plan.steps) {
        if (step.dependencies) {
          for (const depId of step.dependencies) {
            if (!stepIds.has(depId as UUID)) {
              issues.push(`Step '${step.id}' has invalid dependency '${depId}'`);
            }
          }
        }
      }

      if (plan.executionModel === "dag") {
        const hasCycle = this.detectCycles(plan.steps);
        if (hasCycle) {
          issues.push("Plan has circular dependencies");
        }
      }

      return {
        valid: issues.length === 0,
        errors: issues.length > 0 ? issues : [],
        warnings: [],
      };
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("[PlanningService] Error validating plan:", err.message);
      return {
        valid: false,
        errors: [`Validation error: ${err.message}`],
        warnings: [],
      };
    }
  }

  /**
   * Adapts a plan during execution based on results or errors
   */
  async adaptPlan(
    runtime: IAgentRuntime,
    plan: ActionPlan,
    currentStepIndex: number,
    results: ActionResult[],
    error?: Error
  ): Promise<ActionPlan> {
    try {
      logger.info(`[PlanningService] Adapting plan ${plan.id} at step ${currentStepIndex}`);

      const adaptationPrompt = this.buildAdaptationPrompt(plan, currentStepIndex, results, error);

      const adaptationResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: adaptationPrompt,
        temperature: 0.4,
        maxTokens: 1500,
      });

      const adaptedPlan = this.parseAdaptationResponse(
        adaptationResponse as string,
        plan,
        currentStepIndex
      );

      this.activePlans.set(plan.id as UUID, adaptedPlan);

      logger.info(`[PlanningService] Plan ${plan.id} adapted successfully`);

      return adaptedPlan;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`[PlanningService] Error adapting plan ${plan.id}:`, err.message);
      throw new Error(`Failed to adapt plan: ${err.message}`);
    }
  }

  /**
   * Gets the current execution status of a plan
   */
  async getPlanStatus(planId: UUID): Promise<PlanState | null> {
    const execution = this.planExecutions.get(planId);
    return execution?.state || null;
  }

  /**
   * Cancels plan execution
   */
  async cancelPlan(planId: UUID): Promise<boolean> {
    const execution = this.planExecutions.get(planId);
    if (!execution) {
      return false;
    }

    execution.abortController?.abort();
    execution.state.status = "cancelled";
    execution.state.endTime = Date.now();

    logger.info(`[PlanningService] Plan ${planId} cancelled`);
    return true;
  }

  /**
   * Cleanup method
   */
  async stop(): Promise<void> {
    for (const [, execution] of this.planExecutions) {
      execution.abortController?.abort();
      execution.state.status = "cancelled";
      execution.state.endTime = Date.now();
    }

    this.planExecutions.clear();
    this.activePlans.clear();

    logger.info("PlanningService stopped");
  }

  // Private helper methods

  private buildPlanningPrompt(
    context: PlanningContext,
    _runtime: IAgentRuntime,
    message?: Memory,
    state?: State
  ): string {
    const availableActions = (context.availableActions || []).join(", ");
    const availableProviders = (context.availableProviders || []).join(", ");
    const constraints = (context.constraints || [])
      .map((c) => `${c.type}: ${c.description || c.value}`)
      .join(", ");

    return `You are an expert AI planning system. Create a comprehensive action plan to achieve the following goal.

GOAL: ${context.goal}

AVAILABLE ACTIONS: ${availableActions}
AVAILABLE PROVIDERS: ${availableProviders}
CONSTRAINTS: ${constraints}

EXECUTION MODEL: ${context.preferences?.executionModel || "sequential"}
MAX STEPS: ${context.preferences?.maxSteps || 10}

${message ? `CONTEXT MESSAGE: ${message.content.text}` : ""}
${state ? `CURRENT STATE: ${JSON.stringify(state.values)}` : ""}

Create a detailed plan with the following structure:
<plan>
<goal>${context.goal}</goal>
<execution_model>${context.preferences?.executionModel || "sequential"}</execution_model>
<steps>
<step>
<id>step_1</id>
<action>ACTION_NAME</action>
<parameters>{"key": "value"}</parameters>
<dependencies>[]</dependencies>
<description>What this step accomplishes</description>
</step>
</steps>
<estimated_duration>Total estimated time in milliseconds</estimated_duration>
</plan>

Focus on:
1. Breaking down the goal into logical, executable steps
2. Ensuring each step uses available actions
3. Managing dependencies between steps
4. Providing realistic time estimates
5. Including error handling considerations`;
  }

  private parsePlanningResponse(response: string, context: PlanningContext): ActionPlan {
    try {
      const parsedXml = parseKeyValueXml(response);

      const planId = asUUID(uuidv4());
      const steps: ActionStep[] = [];

      const goal = (typeof parsedXml?.goal === "string" ? parsedXml.goal : null) || context.goal;
      const executionModel =
        (typeof parsedXml?.execution_model === "string" ? parsedXml.execution_model : null) ||
        context.preferences?.executionModel ||
        "sequential";
      const estimatedDuration =
        parseInt(
          typeof parsedXml?.estimated_duration === "string"
            ? parsedXml.estimated_duration
            : "30000",
          10
        ) || 30000;

      const stepMatches = response.match(/<step>(.*?)<\/step>/gs) || [];
      const stepIdMap = new Map<string, UUID>();

      for (const stepMatch of stepMatches) {
        try {
          const idMatch = stepMatch.match(/<id>(.*?)<\/id>/);
          const actionMatch = stepMatch.match(/<action>(.*?)<\/action>/);
          const parametersMatch = stepMatch.match(/<parameters>(.*?)<\/parameters>/);
          const dependenciesMatch = stepMatch.match(/<dependencies>(.*?)<\/dependencies>/);

          if (actionMatch && idMatch) {
            const originalId = idMatch[1].trim();
            const actualId = asUUID(uuidv4());
            stepIdMap.set(originalId, actualId);

            let dependencyStrings: string[] = [];
            if (dependenciesMatch?.[1]) {
              try {
                const depArray = JSON.parse(dependenciesMatch[1]);
                dependencyStrings = depArray.filter((dep: string) => dep?.trim());
              } catch {
                dependencyStrings = [];
              }
            }

            const step: ActionStep & { _originalId?: string; _dependencyStrings?: string[] } = {
              id: actualId,
              actionName: actionMatch[1].trim(),
              parameters: parametersMatch?.[1] ? JSON.parse(parametersMatch[1]) : {},
              dependencies: [],
              _originalId: originalId,
              _dependencyStrings: dependencyStrings,
            };
            steps.push(step);
          }
        } catch (stepError) {
          logger.warn(`Failed to parse step: ${stepMatch}`, stepError);
        }
      }

      // Resolve dependencies
      for (const step of steps) {
        const extendedStep = step as ActionStep & { _dependencyStrings?: string[] };
        const dependencyStrings = extendedStep._dependencyStrings || [];
        const dependencies: UUID[] = [];

        for (const depString of dependencyStrings) {
          const resolvedId = stepIdMap.get(depString);
          if (resolvedId) {
            dependencies.push(resolvedId);
          }
        }

        step.dependencies = dependencies;
        delete extendedStep._dependencyStrings;
        delete (step as ActionStep & { _originalId?: string })._originalId;
      }

      if (steps.length === 0 && response.includes("<step>")) {
        logger.warn("XML parsing failed, creating fallback plan");
        steps.push({
          id: asUUID(uuidv4()),
          actionName: "ANALYZE_INPUT",
          parameters: { goal: context.goal },
          dependencies: [],
        });

        if (context.goal.includes("plan") || context.goal.includes("strategy")) {
          steps.push({
            id: asUUID(uuidv4()),
            actionName: "PROCESS_ANALYSIS",
            parameters: { type: "strategic_planning" },
            dependencies: [steps[0].id as UUID],
          });

          steps.push({
            id: asUUID(uuidv4()),
            actionName: "EXECUTE_FINAL",
            parameters: { deliverable: "strategy_document" },
            dependencies: [steps[1].id as UUID],
          });
        }
      }

      return {
        id: planId,
        goal: goal as string,
        thought: `Plan to achieve: ${goal}`,
        totalSteps: steps.length,
        currentStep: 0,
        steps,
        executionModel: executionModel as "sequential" | "parallel" | "dag",
        state: { status: "pending" },
        metadata: {
          createdAt: Date.now(),
          estimatedDuration,
          priority: 1,
          tags: ["comprehensive"],
        },
      };
    } catch (error) {
      logger.error("Failed to parse planning response:", error);

      const planId = asUUID(uuidv4());
      const fallbackSteps = [
        {
          id: asUUID(uuidv4()),
          actionName: "REPLY",
          parameters: { text: "I will help you with this request step by step." },
          dependencies: [],
        },
      ];
      return {
        id: planId,
        goal: context.goal,
        thought: "Fallback plan created due to parsing error",
        totalSteps: fallbackSteps.length,
        currentStep: 0,
        steps: fallbackSteps,
        executionModel: "sequential",
        state: { status: "pending" },
        metadata: {
          createdAt: Date.now(),
          estimatedDuration: 10000,
          priority: 1,
          tags: ["fallback"],
        },
      };
    }
  }

  private async enhancePlan(
    runtime: IAgentRuntime,
    plan: ActionPlan,
    _context: PlanningContext
  ): Promise<ActionPlan> {
    for (const step of plan.steps) {
      const action = runtime.actions.find((a) => a.name === step.actionName);
      if (!action) {
        logger.warn(
          `[PlanningService] Action '${step.actionName}' not found, replacing with REPLY`
        );
        step.actionName = "REPLY";
        step.parameters = { text: `Unable to find action: ${step.actionName}` };
      }
    }

    const extendedSteps = plan.steps as Array<ActionStep & { retryPolicy?: RetryPolicy }>;
    for (const step of extendedSteps) {
      if (!step.retryPolicy) {
        step.retryPolicy = {
          maxRetries: 2,
          backoffMs: 1000,
          backoffMultiplier: 2,
          onError: "abort",
        };
      }
    }

    return plan;
  }

  private async executeSequential(
    runtime: IAgentRuntime,
    plan: ActionPlan,
    message: Memory,
    workingMemory: WorkingMemory,
    results: ActionResult[],
    errors: Error[],
    callback?: HandlerCallback,
    abortSignal?: AbortSignal
  ): Promise<void> {
    for (let i = 0; i < plan.steps.length; i++) {
      if (abortSignal?.aborted) {
        throw new Error("Plan execution aborted");
      }

      const step = plan.steps[i];

      try {
        const result = await this.executeStep(
          runtime,
          step,
          message,
          workingMemory,
          results,
          callback,
          abortSignal
        );
        results.push(result);

        const execution = this.planExecutions.get(plan.id as UUID);
        if (execution) {
          execution.state.currentStepIndex = i + 1;
        }
      } catch (error) {
        logger.error(`[PlanningService] Step ${step.id} failed:`, error);
        errors.push(error instanceof Error ? error : new Error(String(error)));

        const extendedStep = step as ActionStep & { onError?: string; retryPolicy?: RetryPolicy };
        if (extendedStep.onError === "abort" || extendedStep.retryPolicy?.onError === "abort") {
          throw error;
        }
      }
    }
  }

  private async executeParallel(
    runtime: IAgentRuntime,
    plan: ActionPlan,
    message: Memory,
    workingMemory: WorkingMemory,
    results: ActionResult[],
    errors: Error[],
    callback?: HandlerCallback,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const promises = plan.steps.map(async (step) => {
      try {
        const result = await this.executeStep(
          runtime,
          step,
          message,
          workingMemory,
          results,
          callback,
          abortSignal
        );
        return { result, error: null };
      } catch (error) {
        return { result: null, error: error as Error };
      }
    });

    const stepResults = await Promise.all(promises);

    for (const { result, error } of stepResults) {
      if (error) {
        errors.push(error);
      } else if (result) {
        results.push(result);
      }
    }
  }

  private async executeDAG(
    runtime: IAgentRuntime,
    plan: ActionPlan,
    message: Memory,
    workingMemory: WorkingMemory,
    results: ActionResult[],
    errors: Error[],
    callback?: HandlerCallback,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const completed = new Set<UUID>();
    const pending = new Set(plan.steps.map((s) => s.id as UUID));

    while (pending.size > 0 && !abortSignal?.aborted) {
      const readySteps = plan.steps.filter(
        (step) =>
          pending.has(step.id as UUID) &&
          (step.dependencies || []).every((depId) => completed.has(depId as UUID))
      );

      if (readySteps.length === 0) {
        throw new Error("No steps ready to execute - possible circular dependency");
      }

      const promises = readySteps.map(async (step) => {
        try {
          const result = await this.executeStep(
            runtime,
            step,
            message,
            workingMemory,
            results,
            callback,
            abortSignal
          );
          return { stepId: step.id as UUID, result, error: null };
        } catch (error) {
          return {
            stepId: step.id as UUID,
            result: null,
            error: error instanceof Error ? error : new Error(String(error)),
          };
        }
      });

      const stepResults = await Promise.all(promises);

      for (const { stepId, result, error } of stepResults) {
        pending.delete(stepId as UUID);
        completed.add(stepId as UUID);

        if (error) {
          errors.push(error);
        } else if (result) {
          results.push(result);
        }
      }
    }
  }

  private async executeStep(
    runtime: IAgentRuntime,
    step: ActionStep,
    message: Memory,
    _workingMemory: WorkingMemory,
    previousResults: ActionResult[],
    callback?: HandlerCallback,
    _abortSignal?: AbortSignal
  ): Promise<ActionResult> {
    const action = runtime.actions.find((a) => a.name === step.actionName);
    if (!action) {
      throw new Error(`Action '${step.actionName}' not found`);
    }

    const actionContext: ActionContext = {
      previousResults,
      getPreviousResult: (actionName: string) =>
        previousResults.find((r) => {
          const data = r.data as Record<string, unknown>;
          return data?.actionName === actionName || data?.stepId === step.id;
        }),
    };

    const extendedStep = step as ActionStep & { retryPolicy?: RetryPolicy };
    let retries = 0;
    const maxRetries = extendedStep.retryPolicy?.maxRetries || 0;

    while (retries <= maxRetries) {
      try {
        const result = await action.handler(
          runtime,
          message,
          { values: {}, data: {}, text: "" },
          {
            ...step.parameters,
            actionContext,
          } as HandlerOptions,
          callback
        );

        let actionResult: ActionResult;
        if (typeof result === "object" && result !== null) {
          actionResult = result as ActionResult;
        } else {
          actionResult = { text: String(result), success: true };
        }

        if (!actionResult.data) {
          actionResult.data = {};
        }
        const data = actionResult.data as Record<string, unknown>;
        data.stepId = step.id;
        data.actionName = step.actionName;
        data.executedAt = Date.now();

        return actionResult;
      } catch (error) {
        retries++;
        if (retries > maxRetries) {
          throw error;
        }

        const backoffMs =
          (extendedStep.retryPolicy?.backoffMs || 1000) *
          (extendedStep.retryPolicy?.backoffMultiplier || 2) ** (retries - 1);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    throw new Error("Maximum retries exceeded");
  }

  private detectCycles(steps: ActionStep[]): boolean {
    const visited = new Set<UUID>();
    const recursionStack = new Set<UUID>();

    const dfs = (stepId: UUID): boolean => {
      if (recursionStack.has(stepId)) {
        return true;
      }
      if (visited.has(stepId)) {
        return false;
      }

      visited.add(stepId);
      recursionStack.add(stepId);

      const step = steps.find((s) => s.id === stepId);
      if (step?.dependencies) {
        for (const depId of step.dependencies) {
          if (dfs(depId as UUID)) {
            return true;
          }
        }
      }

      recursionStack.delete(stepId);
      return false;
    };

    for (const step of steps) {
      if (step.id && dfs(step.id as UUID)) {
        return true;
      }
    }

    return false;
  }

  private buildAdaptationPrompt(
    plan: ActionPlan,
    currentStepIndex: number,
    results: ActionResult[],
    error?: Error
  ): string {
    return `You are an expert AI adaptation system. A plan execution has encountered an issue and needs adaptation.

ORIGINAL PLAN: ${JSON.stringify(plan, null, 2)}
CURRENT STEP INDEX: ${currentStepIndex}
COMPLETED RESULTS: ${JSON.stringify(results, null, 2)}
${error ? `ERROR: ${error.message}` : ""}

Analyze the situation and provide an adapted plan that:
1. Addresses the current issue
2. Maintains the original goal
3. Uses available actions effectively
4. Considers what has already been completed

Return the adapted plan in the same XML format as the original planning response.`;
  }

  private parseAdaptationResponse(
    response: string,
    originalPlan: ActionPlan,
    currentStepIndex: number
  ): ActionPlan {
    try {
      const adaptedSteps: ActionStep[] = [];
      const stepMatches = response.match(/<step>(.*?)<\/step>/gs) || [];
      const stepIdMap = new Map<string, UUID>();

      for (const stepMatch of stepMatches) {
        try {
          const idMatch = stepMatch.match(/<id>(.*?)<\/id>/);
          const actionMatch = stepMatch.match(/<action>(.*?)<\/action>/);
          const parametersMatch = stepMatch.match(/<parameters>(.*?)<\/parameters>/);
          const dependenciesMatch = stepMatch.match(/<dependencies>(.*?)<\/dependencies>/);

          if (actionMatch && idMatch) {
            const originalId = idMatch[1].trim();
            const actualId = asUUID(uuidv4());
            stepIdMap.set(originalId, actualId);

            let dependencyStrings: string[] = [];
            if (dependenciesMatch?.[1]) {
              try {
                const depArray = JSON.parse(dependenciesMatch[1]);
                dependencyStrings = depArray.filter((dep: string) => dep?.trim());
              } catch {
                dependencyStrings = [];
              }
            }

            const step: ActionStep & { _dependencyStrings?: string[] } = {
              id: actualId,
              actionName: actionMatch[1].trim(),
              parameters: parametersMatch?.[1] ? JSON.parse(parametersMatch[1]) : {},
              dependencies: [],
              _dependencyStrings: dependencyStrings,
            };
            adaptedSteps.push(step);
          }
        } catch (stepError) {
          logger.warn(`Failed to parse adaptation step: ${stepMatch}`, stepError);
        }
      }

      // Resolve dependencies
      for (const step of adaptedSteps) {
        const extendedStep = step as ActionStep & { _dependencyStrings?: string[] };
        const dependencyStrings = extendedStep._dependencyStrings || [];
        const dependencies: UUID[] = [];

        for (const depString of dependencyStrings) {
          const resolvedId = stepIdMap.get(depString);
          if (resolvedId) {
            dependencies.push(resolvedId);
          }
        }

        step.dependencies = dependencies;
        delete extendedStep._dependencyStrings;
      }

      if (adaptedSteps.length === 0) {
        const fallbackStep: ActionStep = {
          id: asUUID(uuidv4()),
          actionName: "REPLY",
          parameters: { text: "Plan adaptation completed successfully" },
          dependencies: [],
        };

        return {
          ...originalPlan,
          id: asUUID(uuidv4()),
          steps: [...originalPlan.steps.slice(0, currentStepIndex), fallbackStep],
          metadata: {
            ...originalPlan.metadata,
            adaptations: [
              ...(((originalPlan.metadata as Record<string, unknown>)?.adaptations as string[]) ||
                []),
              "Fallback adaptation",
            ],
          },
        };
      }

      return {
        ...originalPlan,
        id: asUUID(uuidv4()),
        steps: [...originalPlan.steps.slice(0, currentStepIndex), ...adaptedSteps],
        metadata: {
          ...originalPlan.metadata,
          adaptations: [
            ...(((originalPlan.metadata as Record<string, unknown>)?.adaptations as string[]) ||
              []),
            `Adapted at step ${currentStepIndex}`,
          ],
        },
      };
    } catch (error) {
      logger.error("Failed to parse adaptation response:", error);

      const fallbackStep: ActionStep = {
        id: asUUID(uuidv4()),
        actionName: "REPLY",
        parameters: { text: "Plan adaptation completed successfully" },
        dependencies: [],
      };

      return {
        ...originalPlan,
        id: asUUID(uuidv4()),
        steps: [...originalPlan.steps.slice(0, currentStepIndex), fallbackStep],
        metadata: {
          ...originalPlan.metadata,
          adaptations: [
            ...(((originalPlan.metadata as Record<string, unknown>)?.adaptations as string[]) ||
              []),
            "Emergency fallback adaptation",
          ],
        },
      };
    }
  }
}
