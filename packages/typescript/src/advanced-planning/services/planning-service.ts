import { v4 as uuidv4 } from "uuid";
import { logger } from "../../logger.ts";
import {
  type ActionContext,
  type ActionParameters,
  type ActionResult,
  asUUID,
  type Content,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  ModelType,
  Service,
  type State,
  type UUID,
} from "../../types/index.ts";
import { parseKeyValueXml } from "../../utils.ts";
import type { JsonValue, PlanningContext, RetryPolicy } from "../types.ts";

type ExtendedHandlerOptions = HandlerOptions & {
  abortSignal?: AbortSignal;
  previousResults?: ActionResult[];
  context?: {
    workingMemory: Record<string, JsonValue>;
  };
};

interface ActionStep {
  id?: UUID;
  actionName?: string;
  status?: "pending" | "completed" | "failed";
  error?: string;
  result?: ActionResult;
  parameters?: ActionParameters;
  dependencies?: UUID[];
  retryPolicy?: RetryPolicy;
  onError?: "abort" | "continue" | "skip";
  _dependencyStrings?: string[];
}

interface PlanState {
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  currentStepIndex?: number;
  startTime?: number;
  endTime?: number;
  error?: string;
}

interface ActionPlan {
  id?: UUID;
  goal?: string;
  thought: string;
  totalSteps: number;
  currentStep: number;
  steps: ActionStep[];
  executionModel?: "sequential" | "parallel" | "dag";
  state?: PlanState;
  metadata?: Record<string, JsonValue>;
}

interface PlanExecutionResult {
  planId: UUID;
  success: boolean;
  completedSteps: number;
  totalSteps: number;
  results: ActionResult[];
  errors?: Error[];
  duration?: number;
}

type WorkingMemory = Record<string, JsonValue>;
type RuntimeAction = IAgentRuntime["actions"][number];

class PlanWorkingMemory {
  private memory = new Map<string, JsonValue>();

  set(key: string, value: JsonValue): void {
    this.memory.set(key, value);
  }

  get(key: string): JsonValue | undefined {
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

  entries(): IterableIterator<[string, JsonValue]> {
    return this.memory.entries();
  }

  serialize(): Record<string, JsonValue> {
    return Object.fromEntries(this.memory);
  }
}

export class PlanningService extends Service {
  static serviceType = "planning";

  serviceType = "planning";
  capabilityDescription = "Planning and action coordination";

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

  async createSimplePlan(
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    responseContent?: Content,
  ): Promise<ActionPlan | null> {
    try {
      let actions: string[] = [];
      if (responseContent?.actions && responseContent.actions.length > 0) {
        actions = responseContent.actions;
      } else {
        const text = message.content.text?.toLowerCase() || "";
        if (text.includes("email")) {
          actions = ["SEND_EMAIL"];
        } else if (
          text.includes("research") &&
          (text.includes("send") || text.includes("summary"))
        ) {
          actions = ["SEARCH", "REPLY"];
        } else if (
          text.includes("search") ||
          text.includes("find") ||
          text.includes("research")
        ) {
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
            message: responseContent?.text || message.content.text || "",
            thought: responseContent?.thought || "",
            providers: responseContent?.providers || [],
          } satisfies ActionParameters,
          dependencies: index > 0 ? [stepIds[index - 1]] : [],
        };
      });

      const plan: ActionPlan = {
        id: planId,
        goal: responseContent?.text || `Execute actions: ${actions.join(", ")}`,
        thought:
          responseContent?.thought || `Executing ${actions.length} action(s)`,
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
      return plan;
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.error(
        { src: "service:planning", err },
        "Error creating simple plan",
      );
      return null;
    }
  }

  async createComprehensivePlan(
    runtime: IAgentRuntime,
    context: PlanningContext,
    message?: Memory,
    state?: State,
  ): Promise<ActionPlan> {
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

    const planningPrompt = this.buildPlanningPrompt(context, message, state);

    const planningResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: planningPrompt,
      temperature: 0.3,
      maxTokens: 2000,
    });

    const parsedPlan = this.parsePlanningResponse(
      String(planningResponse),
      context,
    );
    const enhancedPlan = await this.enhancePlan(runtime, parsedPlan);

    if (!enhancedPlan.id) {
      throw new Error("Enhanced plan missing id");
    }

    this.activePlans.set(enhancedPlan.id, enhancedPlan);
    return enhancedPlan;
  }

  async executePlan(
    runtime: IAgentRuntime,
    plan: ActionPlan,
    message: Memory,
    callback?: HandlerCallback,
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

    if (!plan.id) {
      throw new Error("Plan missing id");
    }

    this.planExecutions.set(plan.id, {
      state: executionState,
      workingMemory: workingMemory.serialize(),
      results,
      abortController,
    });

    const actionByName = this.buildActionLookup(runtime);

    try {
      if (plan.executionModel === "sequential") {
        await this.executeSequential(
          runtime,
          actionByName,
          plan,
          message,
          workingMemory,
          results,
          errors,
          callback,
          abortController.signal,
        );
      } else if (plan.executionModel === "parallel") {
        await this.executeParallel(
          runtime,
          actionByName,
          plan,
          message,
          workingMemory,
          results,
          errors,
          callback,
          abortController.signal,
        );
      } else if (plan.executionModel === "dag") {
        await this.executeDAG(
          runtime,
          actionByName,
          plan,
          message,
          workingMemory,
          results,
          errors,
          callback,
          abortController.signal,
        );
      } else {
        throw new Error(`Unsupported execution model: ${plan.executionModel}`);
      }

      executionState.status = errors.length > 0 ? "failed" : "completed";
      executionState.endTime = Date.now();

      return {
        planId: plan.id,
        success: errors.length === 0,
        completedSteps: results.length,
        totalSteps: plan.steps.length,
        results,
        errors: errors.length > 0 ? errors : undefined,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      executionState.status = "failed";
      executionState.endTime = Date.now();
      executionState.error =
        error instanceof Error ? error.message : String(error);

      const err = error instanceof Error ? error : new Error(String(error));
      return {
        planId: plan.id,
        success: false,
        completedSteps: results.length,
        totalSteps: plan.steps.length,
        results,
        errors: [err, ...errors],
        duration: Date.now() - startTime,
      };
    } finally {
      this.planExecutions.delete(plan.id);
    }
  }

  async validatePlan(
    runtime: IAgentRuntime,
    plan: ActionPlan,
  ): Promise<{ valid: boolean; errors: string[]; warnings: string[] }> {
    const issues: string[] = [];
    const actionByName = this.buildActionLookup(runtime);

    if (!plan.id || !plan.goal || !plan.steps) {
      issues.push("Plan missing required fields (id, goal, or steps)");
    }

    if (plan.steps.length === 0) {
      issues.push("Plan has no steps");
    }

    for (const step of plan.steps) {
      if (!step.id || !step.actionName) {
        issues.push("Step missing required fields (id or actionName)");
        continue;
      }

      if (!actionByName.has(step.actionName)) {
        issues.push(`Action '${step.actionName}' not found in runtime`);
      }
    }

    const stepIds = new Set(
      plan.steps.map((s) => s.id).filter((id): id is UUID => Boolean(id)),
    );
    for (const step of plan.steps) {
      if (step.dependencies) {
        for (const depId of step.dependencies) {
          if (!stepIds.has(depId)) {
            issues.push(
              `Step '${String(step.id)}' has invalid dependency '${String(depId)}'`,
            );
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
      errors: issues,
      warnings: [],
    };
  }

  async adaptPlan(
    runtime: IAgentRuntime,
    plan: ActionPlan,
    currentStepIndex: number,
    results: ActionResult[],
    error?: Error,
  ): Promise<ActionPlan> {
    const adaptationPrompt = this.buildAdaptationPrompt(
      plan,
      currentStepIndex,
      results,
      error,
    );
    const adaptationResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: adaptationPrompt,
      temperature: 0.4,
      maxTokens: 1500,
    });

    const adaptedPlan = this.parseAdaptationResponse(
      String(adaptationResponse),
      plan,
      currentStepIndex,
    );
    if (plan.id) {
      this.activePlans.set(plan.id, adaptedPlan);
    }
    return adaptedPlan;
  }

  async getPlanStatus(planId: UUID): Promise<PlanState | null> {
    const execution = this.planExecutions.get(planId);
    return execution?.state || null;
  }

  async cancelPlan(planId: UUID): Promise<boolean> {
    const execution = this.planExecutions.get(planId);
    if (!execution) {
      return false;
    }

    execution.abortController?.abort();
    execution.state.status = "cancelled";
    execution.state.endTime = Date.now();
    return true;
  }

  async stop(): Promise<void> {
    for (const [, execution] of this.planExecutions) {
      execution.abortController?.abort();
      execution.state.status = "cancelled";
      execution.state.endTime = Date.now();
    }

    this.planExecutions.clear();
    this.activePlans.clear();
  }

  private buildPlanningPrompt(
    context: PlanningContext,
    message?: Memory,
    state?: State,
  ): string {
    const availableActions = (context.availableActions || []).join(", ");
    const constraints = (context.constraints || [])
      .map((c) => `${c.type}: ${c.description || c.value}`)
      .join(", ");

    return `You are an expert AI planning system. Create a comprehensive action plan to achieve the following goal.

GOAL: ${context.goal}

AVAILABLE ACTIONS: ${availableActions}
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

  private parsePlanningResponse(
    response: string,
    context: PlanningContext,
  ): ActionPlan {
    try {
      const parsedXml = parseKeyValueXml(response);

      const planId = asUUID(uuidv4());
      const steps: ActionStep[] = [];

      const goal =
        (typeof parsedXml?.goal === "string" ? parsedXml.goal : null) ||
        context.goal;
      const executionModel =
        (typeof parsedXml?.execution_model === "string"
          ? parsedXml.execution_model
          : null) ||
        context.preferences?.executionModel ||
        "sequential";

      const estimatedDurationRaw =
        typeof parsedXml?.estimated_duration === "string"
          ? parsedXml.estimated_duration
          : "30000";
      const estimatedDuration =
        Number.parseInt(estimatedDurationRaw, 10) || 30000;

      const stepMatches = response.match(/<step>(.*?)<\/step>/gs) || [];
      const stepIdMap = new Map<string, UUID>();

      for (const stepMatch of stepMatches) {
        const idMatch = stepMatch.match(/<id>(.*?)<\/id>/);
        const actionMatch = stepMatch.match(/<action>(.*?)<\/action>/);
        const parametersMatch = stepMatch.match(
          /<parameters>(.*?)<\/parameters>/,
        );
        const dependenciesMatch = stepMatch.match(
          /<dependencies>(.*?)<\/dependencies>/,
        );

        if (!actionMatch || !idMatch) {
          continue;
        }

        const originalId = idMatch[1].trim();
        const actualId = asUUID(uuidv4());
        stepIdMap.set(originalId, actualId);

        let dependencyStrings: string[] = [];
        if (dependenciesMatch?.[1]) {
          try {
            const depArray = JSON.parse(dependenciesMatch[1]) as string[];
            if (Array.isArray(depArray)) {
              dependencyStrings = depArray
                .map((dep) => String(dep).trim())
                .filter((dep) => dep.length > 0);
            }
          } catch {
            dependencyStrings = [];
          }
        }

        let parameters: ActionParameters = {};
        if (parametersMatch?.[1]) {
          try {
            const parsed = JSON.parse(parametersMatch[1]) as ActionParameters;
            if (
              parsed &&
              typeof parsed === "object" &&
              !Array.isArray(parsed)
            ) {
              parameters = parsed as ActionParameters;
            }
          } catch {
            parameters = {};
          }
        }

        steps.push({
          id: actualId,
          actionName: actionMatch[1].trim(),
          parameters,
          dependencies: [],
          _dependencyStrings: dependencyStrings,
        });
      }

      for (const step of steps) {
        const dependencyStrings = step._dependencyStrings || [];
        const dependencies: UUID[] = [];

        for (const depString of dependencyStrings) {
          const resolvedId = stepIdMap.get(depString);
          if (resolvedId) {
            dependencies.push(resolvedId);
          }
        }

        step.dependencies = dependencies;
        delete step._dependencyStrings;
      }

      if (steps.length === 0 && response.includes("<step>")) {
        const firstId = asUUID(uuidv4());
        steps.push({
          id: firstId,
          actionName: "ANALYZE_INPUT",
          parameters: { goal: context.goal },
          dependencies: [],
        });

        if (
          context.goal.toLowerCase().includes("plan") ||
          context.goal.toLowerCase().includes("strategy")
        ) {
          const secondId = asUUID(uuidv4());
          steps.push({
            id: secondId,
            actionName: "PROCESS_ANALYSIS",
            parameters: { type: "strategic_planning" },
            dependencies: [firstId],
          });

          steps.push({
            id: asUUID(uuidv4()),
            actionName: "EXECUTE_FINAL",
            parameters: { deliverable: "strategy_document" },
            dependencies: [secondId],
          });
        }
      }

      return {
        id: planId,
        goal,
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
    } catch {
      const planId = asUUID(uuidv4());
      return {
        id: planId,
        goal: context.goal,
        thought: "Fallback plan created due to parsing error",
        totalSteps: 1,
        currentStep: 0,
        steps: [
          {
            id: asUUID(uuidv4()),
            actionName: "REPLY",
            parameters: {
              text: "I will help you with this request step by step.",
            },
            dependencies: [],
          },
        ],
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
  ): Promise<ActionPlan> {
    for (const step of plan.steps) {
      const normalize = (s: string): string =>
        s.toLowerCase().replace(/_/g, "");
      const stepName = step.actionName ?? "";
      const stepNorm = normalize(stepName);
      const action = runtime.actions.find((a) => {
        const nameMatch = normalize(a.name) === stepNorm;
        const simileMatch = (a.similes ?? []).some(
          (s) => normalize(s) === stepNorm,
        );
        return nameMatch || simileMatch;
      });
      if (!action) {
        const missing = step.actionName ?? "";
        step.actionName = "REPLY";
        step.parameters = { text: `Unable to find action: ${missing}` };
      }
    }

    for (const step of plan.steps) {
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
    actionByName: Map<string, RuntimeAction>,
    plan: ActionPlan,
    message: Memory,
    workingMemory: PlanWorkingMemory,
    results: ActionResult[],
    errors: Error[],
    callback?: HandlerCallback,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    for (let i = 0; i < plan.steps.length; i++) {
      if (abortSignal?.aborted) {
        throw new Error("Plan execution aborted");
      }

      const step = plan.steps[i];
      try {
        const result = await this.executeStep(
          runtime,
          actionByName,
          step,
          message,
          workingMemory,
          results,
          callback,
          abortSignal,
        );
        results.push(result);

        if (plan.id) {
          const execution = this.planExecutions.get(plan.id);
          if (execution) {
            execution.state.currentStepIndex = i + 1;
          }
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        errors.push(err);

        const onError = step.onError ?? step.retryPolicy?.onError ?? "abort";
        if (onError === "abort") {
          throw err;
        }
      }
    }
  }

  private async executeParallel(
    runtime: IAgentRuntime,
    actionByName: Map<string, RuntimeAction>,
    plan: ActionPlan,
    message: Memory,
    workingMemory: PlanWorkingMemory,
    results: ActionResult[],
    errors: Error[],
    callback?: HandlerCallback,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const promises = plan.steps.map(async (step) => {
      try {
        const result = await this.executeStep(
          runtime,
          actionByName,
          step,
          message,
          workingMemory,
          results,
          callback,
          abortSignal,
        );
        return { result, error: null as Error | null };
      } catch (e) {
        return {
          result: null as ActionResult | null,
          error: e instanceof Error ? e : new Error(String(e)),
        };
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
    actionByName: Map<string, RuntimeAction>,
    plan: ActionPlan,
    message: Memory,
    workingMemory: PlanWorkingMemory,
    results: ActionResult[],
    errors: Error[],
    callback?: HandlerCallback,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const order = this.buildDagExecutionOrder(plan.steps);
    const stepById = new Map<UUID, ActionStep>();
    for (const step of plan.steps) {
      if (step.id) {
        stepById.set(step.id, step);
      }
    }

    for (const stepId of order) {
      if (abortSignal?.aborted) {
        throw new Error("Plan execution aborted");
      }
      const step = stepById.get(stepId);
      if (!step) continue;

      try {
        const result = await this.executeStep(
          runtime,
          actionByName,
          step,
          message,
          workingMemory,
          results,
          callback,
          abortSignal,
        );
        results.push(result);
      } catch (e) {
        errors.push(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  private async executeStep(
    runtime: IAgentRuntime,
    actionByName: Map<string, RuntimeAction>,
    step: ActionStep,
    message: Memory,
    workingMemory: PlanWorkingMemory,
    previousResults: ActionResult[],
    callback?: HandlerCallback,
    abortSignal?: AbortSignal,
  ): Promise<ActionResult> {
    if (!step.actionName) {
      throw new Error("Step missing actionName");
    }

    const action = actionByName.get(step.actionName);
    if (!action) {
      throw new Error(`Action '${step.actionName}' not found`);
    }

    const actionContext: ActionContext = {
      previousResults,
      getPreviousResult: (actionName: string) =>
        previousResults.find((r) => {
          const data = (r.data ?? {}) as Record<string, JsonValue>;
          return (
            data.actionName === actionName ||
            data.stepId === (step.id ? String(step.id) : "")
          );
        }),
    };

    let retries = 0;
    const maxRetries = step.retryPolicy?.maxRetries ?? 0;

    while (retries <= maxRetries) {
      if (abortSignal?.aborted) {
        throw new Error("Plan execution aborted");
      }

      try {
        const options = {
          actionContext,
          parameters: step.parameters,
          context: {
            workingMemory: workingMemory.serialize(),
          },
          abortSignal,
          previousResults,
        } satisfies ExtendedHandlerOptions;

        const result = await action.handler(
          runtime,
          message,
          { values: {}, data: {}, text: "" },
          options,
          callback,
        );

        const actionResult: ActionResult =
          typeof result === "object" && result !== null
            ? (result as ActionResult)
            : { text: String(result), success: true };

        if (!actionResult.data) {
          actionResult.data = {};
        }
        const data = actionResult.data as Record<string, JsonValue>;
        data.stepId = step.id ? String(step.id) : "";
        data.actionName = step.actionName;
        data.executedAt = Date.now();

        return actionResult;
      } catch (error) {
        retries++;
        if (retries > maxRetries) {
          throw error;
        }
        const backoffMs =
          (step.retryPolicy?.backoffMs ?? 1000) *
          (step.retryPolicy?.backoffMultiplier ?? 2) ** (retries - 1);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    throw new Error("Maximum retries exceeded");
  }

  private detectCycles(steps: ActionStep[]): boolean {
    const visited = new Set<UUID>();
    const recursionStack = new Set<UUID>();

    const dfs = (stepId: UUID): boolean => {
      if (recursionStack.has(stepId)) return true;
      if (visited.has(stepId)) return false;

      visited.add(stepId);
      recursionStack.add(stepId);

      const step = steps.find((s) => s.id === stepId);
      if (step?.dependencies) {
        for (const depId of step.dependencies) {
          if (dfs(depId)) return true;
        }
      }

      recursionStack.delete(stepId);
      return false;
    };

    for (const step of steps) {
      if (step.id && dfs(step.id)) {
        return true;
      }
    }
    return false;
  }

  private buildActionLookup(
    runtime: IAgentRuntime,
  ): Map<string, RuntimeAction> {
    const actionByName = new Map<string, RuntimeAction>();
    for (const action of runtime.actions) {
      actionByName.set(action.name, action);
    }
    return actionByName;
  }

  private buildDagExecutionOrder(steps: ActionStep[]): UUID[] {
    const depsRemaining = new Map<UUID, number>();
    const dependents = new Map<UUID, UUID[]>();
    const indexById = new Map<UUID, number>();

    for (let i = 0; i < steps.length; i += 1) {
      const id = steps[i]?.id;
      if (!id) continue;
      const dependencies = steps[i].dependencies ?? [];
      depsRemaining.set(id, dependencies.length);
      indexById.set(id, i);
      for (const dep of dependencies) {
        const list = dependents.get(dep);
        if (list) {
          list.push(id);
        } else {
          dependents.set(dep, [id]);
        }
      }
    }

    const readyHeap: number[] = [];
    for (const [id, idx] of indexById) {
      if ((depsRemaining.get(id) ?? 0) === 0) {
        this.pushReadyStep(readyHeap, idx);
      }
    }

    const order: UUID[] = [];
    while (readyHeap.length > 0) {
      const idx = this.popReadyStep(readyHeap);
      if (idx === undefined) break;
      const step = steps[idx];
      if (!step?.id) continue;
      const stepId = step.id;
      order.push(stepId);

      const nextSteps = dependents.get(stepId);
      if (!nextSteps) continue;
      for (const nextId of nextSteps) {
        const remaining = depsRemaining.get(nextId);
        if (remaining === undefined || remaining <= 0) continue;
        const updated = remaining - 1;
        depsRemaining.set(nextId, updated);
        if (updated === 0) {
          const nextIdx = indexById.get(nextId);
          if (nextIdx !== undefined) {
            this.pushReadyStep(readyHeap, nextIdx);
          }
        }
      }
    }

    if (order.length !== indexById.size) {
      throw new Error(
        "No steps ready to execute - possible circular dependency",
      );
    }

    return order;
  }

  private pushReadyStep(heap: number[], value: number): void {
    heap.push(value);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (heap[parent] <= heap[index]) break;
      const tmp = heap[parent];
      heap[parent] = heap[index];
      heap[index] = tmp;
      index = parent;
    }
  }

  private popReadyStep(heap: number[]): number | undefined {
    if (heap.length === 0) return undefined;
    const result = heap[0];
    const last = heap.pop();
    if (last === undefined || heap.length === 0) {
      return result;
    }
    heap[0] = last;
    let index = 0;
    const length = heap.length;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= length) break;
      let smallest = left;
      if (right < length && heap[right] < heap[left]) {
        smallest = right;
      }
      if (heap[index] <= heap[smallest]) break;
      const tmp = heap[index];
      heap[index] = heap[smallest];
      heap[smallest] = tmp;
      index = smallest;
    }
    return result;
  }

  private buildAdaptationPrompt(
    plan: ActionPlan,
    currentStepIndex: number,
    results: ActionResult[],
    error?: Error,
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
    currentStepIndex: number,
  ): ActionPlan {
    try {
      const adaptedSteps: ActionStep[] = [];
      const stepMatches = response.match(/<step>(.*?)<\/step>/gs) || [];

      for (const stepMatch of stepMatches) {
        const idMatch = stepMatch.match(/<id>(.*?)<\/id>/);
        const actionMatch = stepMatch.match(/<action>(.*?)<\/action>/);
        const parametersMatch = stepMatch.match(
          /<parameters>(.*?)<\/parameters>/,
        );

        if (!actionMatch || !idMatch) continue;

        let parameters: ActionParameters = {};
        if (parametersMatch?.[1]) {
          try {
            const parsed = JSON.parse(parametersMatch[1]) as ActionParameters;
            if (
              parsed &&
              typeof parsed === "object" &&
              !Array.isArray(parsed)
            ) {
              parameters = parsed as ActionParameters;
            }
          } catch {
            parameters = {};
          }
        }

        adaptedSteps.push({
          id: asUUID(uuidv4()),
          actionName: actionMatch[1].trim(),
          parameters,
          dependencies: [],
        });
      }

      if (adaptedSteps.length === 0) {
        adaptedSteps.push({
          id: asUUID(uuidv4()),
          actionName: "REPLY",
          parameters: { text: "Plan adaptation completed successfully" },
          dependencies: [],
        });
      }

      const prevMeta = originalPlan.metadata ?? {};
      const prevAdaptations = (prevMeta.adaptations ?? []) as JsonValue;
      const nextAdaptations = Array.isArray(prevAdaptations)
        ? [...prevAdaptations, `Adapted at step ${currentStepIndex}`]
        : [`Adapted at step ${currentStepIndex}`];

      return {
        ...originalPlan,
        id: asUUID(uuidv4()),
        steps: [
          ...originalPlan.steps.slice(0, currentStepIndex),
          ...adaptedSteps,
        ],
        metadata: {
          ...prevMeta,
          adaptations: nextAdaptations,
        },
      };
    } catch {
      return {
        ...originalPlan,
        id: asUUID(uuidv4()),
        steps: [
          ...originalPlan.steps.slice(0, currentStepIndex),
          {
            id: asUUID(uuidv4()),
            actionName: "REPLY",
            parameters: { text: "Plan adaptation completed successfully" },
            dependencies: [],
          },
        ],
      };
    }
  }
}
