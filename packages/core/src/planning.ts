import { v4 } from 'uuid';
import type {
  ActionPlan,
  ActionStep,
  PlanState,
  WorkingMemory,
  ActionResult,
  ActionContext,
  PlanExecutionResult,
  PlanningContext,
  Constraint,
} from './types/planning';
import type { Memory, State, UUID } from './types';
import type { IAgentRuntime } from './types/runtime';
import { composePromptFromState, parseKeyValueXml } from './utils';
import { ModelType } from './types/model';
import logger from './logger';

/**
 * Implementation of WorkingMemory for maintaining state across actions
 */
export class WorkingMemoryImpl implements WorkingMemory {
  private memory: Map<string, any> = new Map();

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
    const result: Record<string, any> = {};
    for (const [key, value] of this.memory) {
      result[key] = value;
    }
    return result;
  }
}

/**
 * Context for executing a plan
 */
export class PlanExecutionContext {
  private plan: ActionPlan;
  private workingMemory: WorkingMemory;
  private results: ActionResult[] = [];
  private errors: Error[] = [];
  private startTime: number;
  private aborted: boolean = false;
  private adaptations: string[] = [];

  constructor(plan: ActionPlan) {
    this.plan = plan;
    this.workingMemory = new WorkingMemoryImpl();
    this.startTime = Date.now();
  }

  shouldAbort(): boolean {
    return this.aborted;
  }

  abort(): void {
    this.aborted = true;
  }

  hasError(): boolean {
    return this.errors.length > 0;
  }

  addResult(stepId: UUID, result: ActionResult): void {
    this.results.push(result);
    // Store result in working memory for access by subsequent steps
    this.workingMemory.set(`result_${stepId}`, result);
  }

  addError(error: Error): void {
    this.errors.push(error);
  }

  addAdaptation(description: string): void {
    this.adaptations.push(description);
  }

  getActionContext(stepId: UUID): ActionContext {
    return {
      planId: this.plan.id,
      stepId,
      workingMemory: this.workingMemory,
      previousResults: [...this.results],
      abortSignal: {
        aborted: this.aborted,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
        onabort: null,
        reason: undefined,
        throwIfAborted: () => {
          if (this.aborted) throw new Error('Aborted');
        },
      } as unknown as AbortSignal,
      updateMemory: (key: string, value: any) => {
        this.workingMemory.set(key, value);
      },
      getMemory: (key: string) => {
        return this.workingMemory.get(key);
      },
      getPreviousResult: (stepId: UUID) => {
        return this.workingMemory.get(`result_${stepId}`) as ActionResult | undefined;
      },
      requestReplanning: async () => {
        // This would trigger replanning logic
        this.addAdaptation('Replanning requested');
        return this.plan;
      },
    };
  }

  getResult(): PlanExecutionResult {
    const completedSteps = this.results.length;
    // Consider success if all steps completed, even if some had recoverable errors
    // Only fail if we aborted or didn't complete all steps
    const success = completedSteps === this.plan.steps.length && !this.aborted;

    return {
      planId: this.plan.id,
      success,
      completedSteps,
      totalSteps: this.plan.steps.length,
      results: this.results,
      errors: this.errors.length > 0 ? this.errors : undefined,
      duration: Date.now() - this.startTime,
      adaptations: this.adaptations.length > 0 ? this.adaptations : undefined,
    };
  }
}

/**
 * Planning prompt template
 */
const planningPromptTemplate = `
You are an intelligent planning system. Your task is to create an action plan to achieve the given goal.

# Goal
{{goal}}

# Available Actions
{{#each availableActions}}
- {{this}}
{{/each}}

# Available Providers (for context)
{{#each availableProviders}}
- {{this}}
{{/each}}

# Constraints
{{#each constraints}}
- {{this.type}}: {{this.description}}
{{/each}}

# Current Context
{{stateText}}

Create a detailed action plan with the following structure:
<plan>
<goal>{{goal}}</goal>
<steps>
{{#each steps}}
<step>
<id>{{id}}</id>
<action>{{actionName}}</action>
<parameters>{{parameters}}</parameters>
<dependencies>{{dependencies}}</dependencies>
<expectedOutcome>{{expectedOutcome}}</expectedOutcome>
</step>
{{/each}}
</steps>
<executionModel>sequential|parallel|dag</executionModel>
<estimatedDuration>{{duration}}</estimatedDuration>
</plan>

Guidelines:
1. Use only available actions
2. Consider dependencies between steps
3. Choose appropriate execution model
4. Provide realistic time estimates
5. Ensure the plan achieves the stated goal
`;

/**
 * Parse plan from LLM response
 */
export function parsePlan(response: string): ActionPlan {
  // Extract the plan XML block
  const planMatch = response.match(/<plan>([\s\S]*?)<\/plan>/);
  if (!planMatch) {
    throw new Error('Invalid plan format: no <plan> block found');
  }

  const planContent = planMatch[1];

  // Extract goal
  const goalMatch = planContent.match(/<goal>([\s\S]*?)<\/goal>/);
  const goal = goalMatch ? goalMatch[1].trim() : '';

  // Extract execution model
  const executionModelMatch = planContent.match(/<executionModel>([\s\S]*?)<\/executionModel>/);
  const executionModel = executionModelMatch ? executionModelMatch[1].trim() : 'sequential';

  // Extract estimated duration
  const durationMatch = planContent.match(/<estimatedDuration>([\s\S]*?)<\/estimatedDuration>/);
  const estimatedDuration = durationMatch ? durationMatch[1].trim() : undefined;

  // Extract steps
  const stepsMatch = planContent.match(/<steps>([\s\S]*?)<\/steps>/);
  if (!stepsMatch) {
    throw new Error('Invalid plan format: no <steps> block found');
  }

  const stepsContent = stepsMatch[1];
  const steps: ActionStep[] = [];

  // Parse individual steps
  const stepPattern = /<step>([\s\S]*?)<\/step>/g;
  let stepMatch;

  while ((stepMatch = stepPattern.exec(stepsContent)) !== null) {
    const stepContent = stepMatch[1];

    // Extract step fields
    const idMatch = stepContent.match(/<id>([\s\S]*?)<\/id>/);
    const actionMatch = stepContent.match(/<action>([\s\S]*?)<\/action>/);
    const parametersMatch = stepContent.match(/<parameters>([\s\S]*?)<\/parameters>/);
    const dependenciesMatch = stepContent.match(/<dependencies>([\s\S]*?)<\/dependencies>/);
    const expectedOutcomeMatch = stepContent.match(
      /<expectedOutcome>([\s\S]*?)<\/expectedOutcome>/
    );

    // Parse parameters as JSON if possible
    let parameters = {};
    if (parametersMatch && parametersMatch[1].trim()) {
      try {
        // Try to parse as JSON
        parameters = JSON.parse(parametersMatch[1].trim());
      } catch {
        // If not JSON, try key=value format
        const paramStr = parametersMatch[1].trim();
        if (paramStr.includes('=')) {
          const pairs = paramStr.split(',');
          parameters = pairs.reduce((acc: any, pair) => {
            const [key, value] = pair.split('=').map((s) => s.trim());
            acc[key] = value;
            return acc;
          }, {});
        } else {
          // Otherwise treat as a single value
          parameters = { value: paramStr };
        }
      }
    }

    // Parse dependencies
    let dependencies: UUID[] = [];
    if (dependenciesMatch && dependenciesMatch[1].trim()) {
      dependencies = dependenciesMatch[1]
        .split(',')
        .map((d) => d.trim())
        .filter((d) => d.length > 0) as UUID[];
    }

    steps.push({
      id: (idMatch ? idMatch[1].trim() : v4()) as UUID,
      actionName: actionMatch ? actionMatch[1].trim() : '',
      parameters,
      dependencies,
      expectedOutcome: expectedOutcomeMatch
        ? {
            success: true,
            data: { outcome: expectedOutcomeMatch[1].trim() },
          }
        : undefined,
    });
  }

  return {
    id: v4() as UUID,
    goal,
    steps,
    executionModel: executionModel as 'sequential' | 'parallel' | 'dag',
    state: {
      status: 'pending',
      startTime: Date.now(),
    },
    metadata: {
      createdAt: Date.now(),
      estimatedDuration: estimatedDuration ? parseInt(estimatedDuration, 10) : undefined,
      priority: 1,
      constraints: [],
      tags: [],
    },
  };
}

/**
 * Compose planning prompt from context and state
 */
export function composePlanningPrompt(context: PlanningContext, state: State): string {
  const data = {
    goal: context.goal,
    availableActions: context.availableActions,
    availableProviders: context.availableProviders,
    constraints: context.constraints,
    stateText: state.text || '',
    steps: [], // Template placeholder
  };

  return composePromptFromState({
    state: { ...state, values: data },
    template: planningPromptTemplate,
  });
}

/**
 * Validate that a plan is feasible
 */
export async function validatePlan(
  plan: ActionPlan,
  runtime: IAgentRuntime
): Promise<{ valid: boolean; issues: string[] }> {
  const issues: string[] = [];
  const availableActions = new Set(runtime.actions.map((a) => a.name));

  // Check that all actions exist
  for (const step of plan.steps) {
    if (!availableActions.has(step.actionName)) {
      issues.push(`Unknown action: ${step.actionName}`);
    }
  }

  // Check dependencies
  const stepIds = new Set(plan.steps.map((s) => s.id));
  for (const step of plan.steps) {
    if (step.dependencies) {
      for (const dep of step.dependencies) {
        if (!stepIds.has(dep)) {
          issues.push(`Step ${step.id} depends on unknown step ${dep}`);
        }
      }
    }
  }

  // Check for circular dependencies
  if (hasCircularDependencies(plan)) {
    issues.push('Plan contains circular dependencies');
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Check for circular dependencies in plan
 */
function hasCircularDependencies(plan: ActionPlan): boolean {
  const visited = new Set<UUID>();
  const recursionStack = new Set<UUID>();

  function hasCycle(stepId: UUID): boolean {
    visited.add(stepId);
    recursionStack.add(stepId);

    const step = plan.steps.find((s) => s.id === stepId);
    if (step?.dependencies) {
      for (const dep of step.dependencies) {
        if (!visited.has(dep)) {
          if (hasCycle(dep)) return true;
        } else if (recursionStack.has(dep)) {
          return true;
        }
      }
    }

    recursionStack.delete(stepId);
    return false;
  }

  for (const step of plan.steps) {
    if (!visited.has(step.id)) {
      if (hasCycle(step.id)) return true;
    }
  }

  return false;
}

/**
 * Execute a single step in a plan
 */
export async function executeStep(
  step: ActionStep,
  context: PlanExecutionContext,
  runtime: IAgentRuntime,
  message: Memory,
  callback?: (content: any) => Promise<Memory[]>
): Promise<ActionResult> {
  const action = runtime.actions.find((a) => a.name === step.actionName);

  if (!action) {
    throw new Error(`Action ${step.actionName} not found`);
  }

  const actionContext = context.getActionContext(step.id);
  const state = await runtime.composeState(message);

  try {
    const result = await action.handler(
      runtime,
      message,
      state,
      { ...step.parameters, context: actionContext },
      callback
    );

    // Convert handler result to ActionResult
    let actionResult: ActionResult;

    if (typeof result === 'object' && result !== null && 'values' in result) {
      // Result is already an ActionResult
      actionResult = result as ActionResult;
    } else {
      // Result is void, boolean, or null - create default ActionResult
      actionResult = {
        values: {},
        data: { handlerResult: result },
        text: '',
      };
    }

    context.addResult(step.id, actionResult);
    return actionResult;
  } catch (error) {
    context.addError(error as Error);

    if (step.onError === 'abort') {
      context.abort();
      throw error;
    } else if (step.onError === 'skip' || step.onError === 'continue') {
      // Continue to next step - add a skipped result
      const skippedResult: ActionResult = {
        values: {},
        data: {
          skipped: true,
          error: error instanceof Error ? error.message : String(error),
        },
        text: 'Step skipped due to error',
      };
      context.addResult(step.id, skippedResult);
      return skippedResult;
    }

    throw error;
  }
}

/**
 * Get execution order for plan steps based on dependencies
 */
export function getExecutionOrder(plan: ActionPlan): UUID[][] {
  if (plan.executionModel === 'sequential') {
    return plan.steps.map((step) => [step.id]);
  }

  // For parallel and DAG execution, group by dependency levels
  const levels: UUID[][] = [];
  const processed = new Set<UUID>();

  function getLevel(stepId: UUID): number {
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step || !step.dependencies || step.dependencies.length === 0) {
      return 0;
    }

    const depLevels = step.dependencies.map((dep) => getLevel(dep));
    return Math.max(...depLevels) + 1;
  }

  // Group steps by level
  const stepLevels = new Map<UUID, number>();
  for (const step of plan.steps) {
    stepLevels.set(step.id, getLevel(step.id));
  }

  // Create execution groups
  const maxLevel = Math.max(...Array.from(stepLevels.values()));
  for (let level = 0; level <= maxLevel; level++) {
    const group: UUID[] = [];
    for (const [stepId, stepLevel] of stepLevels) {
      if (stepLevel === level) {
        group.push(stepId);
      }
    }
    if (group.length > 0) {
      levels.push(group);
    }
  }

  return levels;
}
