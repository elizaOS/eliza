import {
  Service,
  type IAgentRuntime,
  type IPlanningService,
  type ActionPlan,
  type ActionStep,
  type ActionResult,
  type PlanExecutionResult,
  type PlanningContext,
  type PlanState,
  type Memory,
  type State,
  type Content,
  type UUID,
  type WorkingMemory,
  type ActionContext,
  type HandlerCallback,
  asUUID,
  ModelType,
  parseKeyValueXml,
  logger,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';

/**
 * Working Memory Implementation for Plan Execution
 */
class PlanWorkingMemory implements WorkingMemory {
  private memory = new Map<string, any>();

  set(key: string, value: any): void {
    this.memory.set(key, value);
  }

  get(key: string): any {
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

  entries(): IterableIterator<[string, any]> {
    return this.memory.entries();
  }

  serialize(): Record<string, any> {
    return Object.fromEntries(this.memory);
  }
}

/**
 * Production-Ready Planning Service Implementation
 * Provides unified planning capabilities with full runtime integration
 */
export class PlanningService extends Service implements IPlanningService {
  static serviceType = 'planning';

  serviceType = 'planning';
  capabilityDescription = 'Provides comprehensive planning and action coordination capabilities';

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

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<PlanningService> {
    const service = new PlanningService(runtime);
    logger.info('PlanningService started successfully');
    return service;
  }

  /**
   * Creates a simple plan for basic message handling (backwards compatibility)
   */
  async createSimplePlan(
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    responseContent?: Content
  ): Promise<ActionPlan | null> {
    try {
      logger.debug('[PlanningService] Creating simple plan for message handling');

      // If no responseContent provided, analyze the message to determine actions
      let actions: string[] = [];
      if (responseContent?.actions && responseContent.actions.length > 0) {
        actions = responseContent.actions;
      } else {
        // Simple heuristic-based action selection based on message content
        const text = message.content.text?.toLowerCase() || '';
        logger.debug(`[PlanningService] Analyzing text: "${text}"`);
        if (text.includes('email')) {
          actions = ['SEND_EMAIL'];
          logger.debug('[PlanningService] Detected email action');
        } else if (
          text.includes('research') &&
          (text.includes('send') || text.includes('summary'))
        ) {
          actions = ['SEARCH', 'REPLY'];
          logger.debug('[PlanningService] Detected research + send/summary actions');
        } else if (text.includes('search') || text.includes('find') || text.includes('research')) {
          actions = ['SEARCH'];
          logger.debug('[PlanningService] Detected search action');
        } else if (text.includes('analyze')) {
          actions = ['THINK', 'REPLY'];
          logger.debug('[PlanningService] Detected analyze actions');
        } else {
          actions = ['REPLY'];
          logger.debug('[PlanningService] Defaulting to REPLY action');
        }
      }

      if (actions.length === 0) {
        return null;
      }

      // Create a simple sequential plan from the actions
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
        goal: responseContent?.text || `Execute actions: ${actions.join(', ')}`,
        steps,
        executionModel: 'sequential',
        state: {
          status: 'pending',
        },
        metadata: {
          createdAt: Date.now(),
          estimatedDuration: steps.length * 5000, // 5 seconds per step
          priority: 1,
          tags: ['simple', 'message-handling'],
        },
      };

      this.activePlans.set(planId, plan);
      logger.debug(`[PlanningService] Created simple plan ${planId} with ${steps.length} steps`);

      return plan;
    } catch (error) {
      logger.error('[PlanningService] Error creating simple plan:', error);
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
      // Validate context
      if (!context.goal || context.goal.trim() === '') {
        throw new Error('Planning context must have a non-empty goal');
      }
      if (!Array.isArray(context.constraints)) {
        throw new Error('Planning context constraints must be an array');
      }
      if (!Array.isArray(context.availableActions)) {
        throw new Error('Planning context availableActions must be an array');
      }
      if (!context.preferences || typeof context.preferences !== 'object') {
        throw new Error('Planning context preferences must be an object');
      }

      logger.info(`[PlanningService] Creating comprehensive plan for goal: ${context.goal}`);

      // Construct planning prompt with full context
      const planningPrompt = this.buildPlanningPrompt(context, runtime, message, state);

      // Use LLM to generate the plan
      const planningResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: planningPrompt,
        temperature: 0.3,
        maxTokens: 2000,
      });

      // Parse the LLM response
      const parsedPlan = this.parsePlanningResponse(planningResponse as string, context);

      // Validate and enhance the plan
      const enhancedPlan = await this.enhancePlan(runtime, parsedPlan, context);

      // Store the active plan
      this.activePlans.set(enhancedPlan.id, enhancedPlan);

      logger.info(
        `[PlanningService] Created comprehensive plan ${enhancedPlan.id} with ${enhancedPlan.steps.length} steps`
      );

      return enhancedPlan;
    } catch (error: any) {
      logger.error('[PlanningService] Error creating comprehensive plan:', error);
      throw new Error(`Failed to create comprehensive plan: ${error.message}`);
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

    // Initialize plan execution state
    const executionState: PlanState = {
      status: 'running',
      startTime,
      currentStepIndex: 0,
    };

    this.planExecutions.set(plan.id, {
      state: executionState,
      workingMemory,
      results,
      abortController,
    });

    try {
      logger.info(`[PlanningService] Starting execution of plan ${plan.id}`);

      // Execute steps based on execution model
      if (plan.executionModel === 'sequential') {
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
      } else if (plan.executionModel === 'parallel') {
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
      } else if (plan.executionModel === 'dag') {
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

      // Update execution state
      executionState.status = errors.length > 0 ? 'failed' : 'completed';
      executionState.endTime = Date.now();

      const result: PlanExecutionResult = {
        planId: plan.id,
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

      executionState.status = 'failed';
      executionState.endTime = Date.now();
      executionState.error = error as Error;

      return {
        planId: plan.id,
        success: false,
        completedSteps: results.length,
        totalSteps: plan.steps.length,
        results,
        errors: [error as Error, ...errors],
        duration: Date.now() - startTime,
      };
    } finally {
      // Cleanup
      this.planExecutions.delete(plan.id);
    }
  }

  /**
   * Validates a plan before execution
   */
  async validatePlan(
    runtime: IAgentRuntime,
    plan: ActionPlan
  ): Promise<{ valid: boolean; issues?: string[] }> {
    const issues: string[] = [];

    try {
      // Validate plan structure
      if (!plan.id || !plan.goal || !plan.steps) {
        issues.push('Plan missing required fields (id, goal, or steps)');
      }

      if (plan.steps.length === 0) {
        issues.push('Plan has no steps');
      }

      // Validate each step
      for (const step of plan.steps) {
        if (!step.id || !step.actionName) {
          issues.push(`Step missing required fields: ${JSON.stringify(step)}`);
          continue;
        }

        // Check if action exists in runtime
        const action = runtime.actions.find((a) => a.name === step.actionName);
        if (!action) {
          issues.push(`Action '${step.actionName}' not found in runtime`);
        }
      }

      // Validate dependencies
      const stepIds = new Set(plan.steps.map((s) => s.id));
      for (const step of plan.steps) {
        if (step.dependencies) {
          for (const depId of step.dependencies) {
            if (!stepIds.has(depId)) {
              issues.push(`Step '${step.id}' has invalid dependency '${depId}'`);
            }
          }
        }
      }

      // Check for circular dependencies in DAG execution
      if (plan.executionModel === 'dag') {
        const hasCycle = this.detectCycles(plan.steps);
        if (hasCycle) {
          issues.push('Plan has circular dependencies');
        }
      }

      return {
        valid: issues.length === 0,
        issues: issues.length > 0 ? issues : undefined,
      };
    } catch (error: any) {
      logger.error('[PlanningService] Error validating plan:', error);
      return {
        valid: false,
        issues: [`Validation error: ${error.message}`],
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

      // Build adaptation prompt
      const adaptationPrompt = this.buildAdaptationPrompt(plan, currentStepIndex, results, error);

      // Use LLM to generate adaptation
      const adaptationResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: adaptationPrompt,
        temperature: 0.4,
        maxTokens: 1500,
      });

      // Parse adaptation response
      const adaptedPlan = this.parseAdaptationResponse(
        adaptationResponse as string,
        plan,
        currentStepIndex
      );

      // Update active plan
      this.activePlans.set(plan.id, adaptedPlan);

      logger.info(`[PlanningService] Plan ${plan.id} adapted successfully`);

      return adaptedPlan;
    } catch (error: any) {
      logger.error(`[PlanningService] Error adapting plan ${plan.id}:`, error);
      throw new Error(`Failed to adapt plan: ${error.message}`);
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
    execution.state.status = 'cancelled';
    execution.state.endTime = Date.now();

    logger.info(`[PlanningService] Plan ${planId} cancelled`);
    return true;
  }

  /**
   * Cleanup method
   */
  async stop(): Promise<void> {
    // Cancel all active plan executions
    for (const [_planId, execution] of this.planExecutions) {
      execution.abortController?.abort();
      execution.state.status = 'cancelled';
      execution.state.endTime = Date.now();
    }

    this.planExecutions.clear();
    this.activePlans.clear();

    logger.info('PlanningService stopped');
  }

  // Private helper methods

  private buildPlanningPrompt(
    context: PlanningContext,
    runtime: IAgentRuntime,
    message?: Memory,
    state?: State
  ): string {
    const availableActions = (context.availableActions || []).join(', ');
    const availableProviders = (context.availableProviders || []).join(', ');
    const constraints = (context.constraints || [])
      .map((c) => `${c.type}: ${c.description || c.value}`)
      .join(', ');

    return `You are an expert AI planning system. Create a comprehensive action plan to achieve the following goal.

GOAL: ${context.goal}

AVAILABLE ACTIONS: ${availableActions}
AVAILABLE PROVIDERS: ${availableProviders}
CONSTRAINTS: ${constraints}

EXECUTION MODEL: ${context.preferences?.executionModel || 'sequential'}
MAX STEPS: ${context.preferences?.maxSteps || 10}

${message ? `CONTEXT MESSAGE: ${message.content.text}` : ''}
${state ? `CURRENT STATE: ${JSON.stringify(state.values)}` : ''}

Create a detailed plan with the following structure:
<plan>
<goal>${context.goal}</goal>
<execution_model>${context.preferences?.executionModel || 'sequential'}</execution_model>
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
      // First try to parse using parseKeyValueXml
      const parsedXml = parseKeyValueXml(response);

      const planId = asUUID(uuidv4());
      const steps: ActionStep[] = [];

      // Enhanced step parsing - try multiple approaches
      const goal = parsedXml?.goal || context.goal;
      const executionModel =
        parsedXml?.execution_model || context.preferences?.executionModel || 'sequential';
      const estimatedDuration = parseInt(parsedXml?.estimated_duration, 10) || 30000;

      // Parse steps using regex if XML parsing failed
      const stepMatches = response.match(/<step>(.*?)<\/step>/gs) || [];

      // Map to track step relationships
      const stepIdMap = new Map<string, UUID>();

      for (const stepMatch of stepMatches) {
        try {
          // Extract individual step fields using regex
          const idMatch = stepMatch.match(/<id>(.*?)<\/id>/);
          const actionMatch = stepMatch.match(/<action>(.*?)<\/action>/);
          const parametersMatch = stepMatch.match(/<parameters>(.*?)<\/parameters>/);
          const dependenciesMatch = stepMatch.match(/<dependencies>(.*?)<\/dependencies>/);

          if (actionMatch && idMatch) {
            const originalId = idMatch[1].trim();
            const actualId = asUUID(uuidv4());
            stepIdMap.set(originalId, actualId);

            // Parse dependencies and resolve them later
            let dependencyStrings: string[] = [];
            if (dependenciesMatch?.[1]) {
              try {
                const depArray = JSON.parse(dependenciesMatch[1]);
                dependencyStrings = depArray.filter((dep: string) => dep && dep.trim());
              } catch (_e) {
                dependencyStrings = [];
              }
            }

            steps.push({
              id: actualId,
              actionName: actionMatch[1].trim(),
              parameters: parametersMatch?.[1] ? JSON.parse(parametersMatch[1]) : {},
              dependencies: [], // Will be resolved after all steps are parsed
              _originalId: originalId,
              _dependencyStrings: dependencyStrings,
            } as any);
          }
        } catch (stepError) {
          logger.warn(`Failed to parse step: ${stepMatch}`, stepError);
        }
      }

      // Now resolve dependencies
      for (const step of steps) {
        const dependencyStrings = (step as any)._dependencyStrings || [];
        const dependencies: UUID[] = [];

        for (const depString of dependencyStrings) {
          const resolvedId = stepIdMap.get(depString);
          if (resolvedId) {
            dependencies.push(resolvedId);
          }
        }

        step.dependencies = dependencies;
        // Clean up temporary properties
        delete (step as any)._originalId;
        delete (step as any)._dependencyStrings;
      }

      // If no steps found and this looks like a planning response, create fallback steps
      if (steps.length === 0 && response.includes('<step>')) {
        logger.warn('XML parsing failed, creating fallback plan');
        // Create basic fallback steps based on context
        steps.push({
          id: asUUID(uuidv4()),
          actionName: 'ANALYZE_INPUT',
          parameters: { goal: context.goal },
          dependencies: [],
        });

        if (context.goal.includes('plan') || context.goal.includes('strategy')) {
          steps.push({
            id: asUUID(uuidv4()),
            actionName: 'PROCESS_ANALYSIS',
            parameters: { type: 'strategic_planning' },
            dependencies: [steps[0].id],
          });

          steps.push({
            id: asUUID(uuidv4()),
            actionName: 'EXECUTE_FINAL',
            parameters: { deliverable: 'strategy_document' },
            dependencies: [steps[1].id],
          });
        }
      }

      return {
        id: planId,
        goal,
        steps,
        executionModel: executionModel as any,
        state: { status: 'pending' },
        metadata: {
          createdAt: Date.now(),
          estimatedDuration,
          priority: 1,
          tags: ['comprehensive'],
        },
      };
    } catch (error) {
      logger.error('Failed to parse planning response:', error);

      // Create emergency fallback plan
      const planId = asUUID(uuidv4());
      return {
        id: planId,
        goal: context.goal,
        steps: [
          {
            id: asUUID(uuidv4()),
            actionName: 'REPLY',
            parameters: { text: 'I will help you with this request step by step.' },
            dependencies: [],
          },
        ],
        executionModel: 'sequential',
        state: { status: 'pending' },
        metadata: {
          createdAt: Date.now(),
          estimatedDuration: 10000,
          priority: 1,
          tags: ['fallback'],
        },
      };
    }
  }

  private async enhancePlan(
    runtime: IAgentRuntime,
    plan: ActionPlan,
    _context: PlanningContext
  ): Promise<ActionPlan> {
    // Validate actions exist
    for (const step of plan.steps) {
      const action = runtime.actions.find((a) => a.name === step.actionName);
      if (!action) {
        logger.warn(
          `[PlanningService] Action '${step.actionName}' not found, replacing with REPLY`
        );
        step.actionName = 'REPLY';
        step.parameters = { text: `Unable to find action: ${step.actionName}` };
      }
    }

    // Add retry policies for critical steps
    for (const step of plan.steps) {
      if (!step.retryPolicy) {
        step.retryPolicy = {
          maxRetries: 2,
          backoffMs: 1000,
          backoffMultiplier: 2,
          onError: 'abort',
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
        throw new Error('Plan execution aborted');
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

        // Update execution state
        const execution = this.planExecutions.get(plan.id);
        if (execution) {
          execution.state.currentStepIndex = i + 1;
        }
      } catch (error) {
        logger.error(`[PlanningService] Step ${step.id} failed:`, error);
        errors.push(error as Error);

        if (step.onError === 'abort' || step.retryPolicy?.onError === 'abort') {
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
    const promises = plan.steps.map(async (step, index) => {
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
        return { index, result, error: null };
      } catch (error) {
        return { index, result: null, error: error as Error };
      }
    });

    const stepResults = await Promise.all(promises);

    for (const { index: _index, result, error } of stepResults) {
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
    const pending = new Set(plan.steps.map((s) => s.id));

    while (pending.size > 0 && !abortSignal?.aborted) {
      const readySteps = plan.steps.filter(
        (step) =>
          pending.has(step.id) && (step.dependencies || []).every((depId) => completed.has(depId))
      );

      if (readySteps.length === 0) {
        throw new Error('No steps ready to execute - possible circular dependency');
      }

      // Execute ready steps in parallel
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
          return { stepId: step.id, result, error: null };
        } catch (error) {
          return { stepId: step.id, result: null, error: error as Error };
        }
      });

      const stepResults = await Promise.all(promises);

      for (const { stepId, result, error } of stepResults) {
        pending.delete(stepId);
        completed.add(stepId);

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
    workingMemory: WorkingMemory,
    previousResults: ActionResult[],
    callback?: HandlerCallback,
    abortSignal?: AbortSignal
  ): Promise<ActionResult> {
    const action = runtime.actions.find((a) => a.name === step.actionName);
    if (!action) {
      throw new Error(`Action '${step.actionName}' not found`);
    }

    // Build action context
    const actionContext: ActionContext = {
      planId: step.id,
      stepId: step.id,
      workingMemory,
      previousResults,
      abortSignal,
      updateMemory: (key: string, value: any) => workingMemory.set(key, value),
      getMemory: (key: string) => workingMemory.get(key),
      getPreviousResult: (stepId: UUID) => previousResults.find((r) => r.data?.stepId === stepId),
    };

    // Execute action with retry logic
    let retries = 0;
    const maxRetries = step.retryPolicy?.maxRetries || 0;

    while (retries <= maxRetries) {
      try {
        const result = await action.handler(
          runtime,
          message,
          { values: {}, data: {}, text: '' },
          {
            ...step.parameters,
            context: actionContext,
            previousResults,
            workingMemory,
            abortSignal,
          },
          callback
        );

        // Ensure result is in ActionResult format and includes step tracking
        let actionResult: ActionResult;
        if (typeof result === 'object' && result !== null) {
          actionResult = result as ActionResult;
        } else {
          actionResult = { text: String(result) };
        }

        // Add step tracking information to the result
        if (!actionResult.data) {
          actionResult.data = {};
        }
        actionResult.data.stepId = step.id;
        actionResult.data.actionName = step.actionName;
        actionResult.data.executedAt = Date.now();

        return actionResult;
      } catch (error) {
        retries++;
        if (retries > maxRetries) {
          throw error;
        }

        // Apply backoff
        const backoffMs =
          (step.retryPolicy?.backoffMs || 1000) *
          Math.pow(step.retryPolicy?.backoffMultiplier || 2, retries - 1);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    throw new Error('Maximum retries exceeded');
  }

  private detectCycles(steps: ActionStep[]): boolean {
    const visited = new Set<UUID>();
    const recursionStack = new Set<UUID>();

    const dfs = (stepId: UUID): boolean => {
      if (recursionStack.has(stepId)) {
        return true; // Cycle detected
      }
      if (visited.has(stepId)) {
        return false;
      }

      visited.add(stepId);
      recursionStack.add(stepId);

      const step = steps.find((s) => s.id === stepId);
      if (step?.dependencies) {
        for (const depId of step.dependencies) {
          if (dfs(depId)) {
            return true;
          }
        }
      }

      recursionStack.delete(stepId);
      return false;
    };

    for (const step of steps) {
      if (dfs(step.id)) {
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
${error ? `ERROR: ${error.message}` : ''}

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
      // Parse adapted steps using the same approach as planning response
      const adaptedSteps: ActionStep[] = [];
      const stepMatches = response.match(/<step>(.*?)<\/step>/gs) || [];

      // Map to track step relationships
      const stepIdMap = new Map<string, UUID>();

      for (const stepMatch of stepMatches) {
        try {
          // Extract individual step fields using regex
          const idMatch = stepMatch.match(/<id>(.*?)<\/id>/);
          const actionMatch = stepMatch.match(/<action>(.*?)<\/action>/);
          const parametersMatch = stepMatch.match(/<parameters>(.*?)<\/parameters>/);
          const dependenciesMatch = stepMatch.match(/<dependencies>(.*?)<\/dependencies>/);

          if (actionMatch && idMatch) {
            const originalId = idMatch[1].trim();
            const actualId = asUUID(uuidv4());
            stepIdMap.set(originalId, actualId);

            // Parse dependencies and resolve them later
            let dependencyStrings: string[] = [];
            if (dependenciesMatch?.[1]) {
              try {
                const depArray = JSON.parse(dependenciesMatch[1]);
                dependencyStrings = depArray.filter((dep: string) => dep && dep.trim());
              } catch (_e) {
                dependencyStrings = [];
              }
            }

            adaptedSteps.push({
              id: actualId,
              actionName: actionMatch[1].trim(),
              parameters: parametersMatch?.[1] ? JSON.parse(parametersMatch[1]) : {},
              dependencies: [], // Will be resolved after all steps are parsed
              _originalId: originalId,
              _dependencyStrings: dependencyStrings,
            } as any);
          }
        } catch (stepError) {
          logger.warn(`Failed to parse adaptation step: ${stepMatch}`, stepError);
        }
      }

      // Now resolve dependencies
      for (const step of adaptedSteps) {
        const dependencyStrings = (step as any)._dependencyStrings || [];
        const dependencies: UUID[] = [];

        for (const depString of dependencyStrings) {
          const resolvedId = stepIdMap.get(depString);
          if (resolvedId) {
            dependencies.push(resolvedId);
          }
        }

        step.dependencies = dependencies;
        // Clean up temporary properties
        delete (step as any)._originalId;
        delete (step as any)._dependencyStrings;
      }

      if (adaptedSteps.length === 0) {
        // If parsing fails, create a simple fallback plan
        const fallbackStep: ActionStep = {
          id: asUUID(uuidv4()),
          actionName: 'REPLY',
          parameters: { text: 'Plan adaptation completed successfully' },
          dependencies: [],
        };

        return {
          ...originalPlan,
          id: asUUID(uuidv4()), // Generate new ID for adapted plan
          steps: [...originalPlan.steps.slice(0, currentStepIndex), fallbackStep],
          metadata: {
            ...(originalPlan.metadata || {}),
            adaptations: [
              ...((originalPlan.metadata as any)?.adaptations || []),
              'Fallback adaptation',
            ],
          } as any,
        };
      }

      return {
        ...originalPlan,
        id: asUUID(uuidv4()), // Generate new ID for adapted plan
        steps: [...originalPlan.steps.slice(0, currentStepIndex), ...adaptedSteps],
        metadata: {
          ...(originalPlan.metadata || {}),
          adaptations: [
            ...((originalPlan.metadata as any)?.adaptations || []),
            `Adapted at step ${currentStepIndex}`,
          ],
        } as any,
      };
    } catch (error) {
      logger.error('Failed to parse adaptation response:', error);

      // Create emergency fallback adaptation
      const fallbackStep: ActionStep = {
        id: asUUID(uuidv4()),
        actionName: 'REPLY',
        parameters: { text: 'Plan adaptation completed successfully' },
        dependencies: [],
      };

      return {
        ...originalPlan,
        id: asUUID(uuidv4()), // Generate new ID for adapted plan
        steps: [...originalPlan.steps.slice(0, currentStepIndex), fallbackStep],
        metadata: {
          ...(originalPlan.metadata || {}),
          adaptations: [
            ...((originalPlan.metadata as any)?.adaptations || []),
            'Emergency fallback adaptation',
          ],
        } as any,
      };
    }
  }
}
