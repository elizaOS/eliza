import { Workflow, WorkflowContext, Logger, ConsoleLogger, isWorkflowSuccess, isNextStep } from './types';
import { emit } from './events';
import { Desktop } from '@mediar-ai/computeruse';

export interface WorkflowRunnerOptions {
  workflow: Workflow;
  inputs: any;
  startFromStep?: string;
  endAtStep?: string;
  restoredState?: WorkflowState;
}

export interface WorkflowState {
  context: WorkflowContext;
  stepResults: Record<string, { status: string; result?: any; error?: string }>;
  lastStepId?: string;
  lastStepIndex: number;
}

export class WorkflowRunner {
  private workflow: Workflow;
  private inputs: any;
  private startFromStep?: string;
  private endAtStep?: string;
  private state: WorkflowState;
  private desktop: Desktop;
  private logger: Logger;

  constructor(options: WorkflowRunnerOptions) {
    this.workflow = options.workflow;
    this.inputs = options.inputs;
    this.startFromStep = options.startFromStep;
    this.endAtStep = options.endAtStep;
    this.logger = new ConsoleLogger();

    // Initialize or restore state
    if (options.restoredState) {
      // Rehydrate context with setState method (lost during serialization)
      const restored = options.restoredState.context || {};
      const context: WorkflowContext = {
        data: restored.data || {},
        state: restored.state || {},
        variables: restored.variables ?? this.inputs,
        setState(update) {
          const updates = typeof update === "function" ? update(this.state) : update;
          Object.assign(this.state, updates);
        },
      };
      this.state = {
        ...options.restoredState,
        context,
        stepResults: options.restoredState.stepResults || {},
      };
      this.logger.info('🔄 Restored state from previous run');
    } else {
      const context: WorkflowContext = {
        data: {},
        state: {},
        variables: this.inputs,
        setState(update) {
          const updates = typeof update === "function" ? update(this.state) : update;
          Object.assign(this.state, updates);
        },
      };
      this.state = {
        context,
        stepResults: {},
        lastStepIndex: -1,
      };
    }

    this.desktop = new Desktop();
  }

  async run(): Promise<{ status: string; lastStepId?: string; lastStepIndex: number; error?: string }> {
    const steps = this.workflow.steps;

    // Find start and end indices
    let startIndex = 0;
    if (this.startFromStep) {
      startIndex = steps.findIndex(s => s.config.id === this.startFromStep);
      if (startIndex === -1) {
        const error = `Start step '${this.startFromStep}' not found`;
        this.logger.error(error);
        throw new Error(error);
      }
      this.logger.info(`📍 Starting from step: ${this.startFromStep} (index ${startIndex})`);
    }

    let endIndex = steps.length - 1;
    if (this.endAtStep) {
      endIndex = steps.findIndex(s => s.config.id === this.endAtStep);
      if (endIndex === -1) {
        const error = `End step '${this.endAtStep}' not found`;
        this.logger.error(error);
        throw new Error(error);
      }
      this.logger.info(`🎯 Stopping at step: ${this.endAtStep} (index ${endIndex})`);
    }

    // Execute steps (using while loop to support next() jumps)
    let i = startIndex;
    while (i <= endIndex) {
      const step = steps[i];

      this.logger.info(`\n[${i + 1}/${steps.length}] ${step.config.name}`);
      const totalSteps = steps.length;
      const stepStartTime = Date.now();
      emit.stepStarted(step.config.id, step.config.name, i + 1, totalSteps);

      try {
        // Check if step has condition
        if (step.config.condition) {
          const shouldRun = step.config.condition({
            input: this.inputs,
            context: this.state.context,
          });

          if (!shouldRun) {
            this.logger.info('⏭️  Skipping step (condition not met)');
            this.state.stepResults[step.config.id] = {
              status: 'skipped',
            };
            i++;
            continue;
          }
        }

        // Execute step
        const result = await step.run({
          desktop: this.desktop,
          input: this.inputs,
          context: this.state.context,
          logger: this.logger,
        });

        // Check for early success return
        if (isWorkflowSuccess(result)) {
          this.logger.success(`✅ Workflow completed early`);
          this.state.context.data = result.result;
          this.state.lastStepId = step.config.id;
          this.state.lastStepIndex = i;
          return {
            status: 'executed_without_error',
            lastStepId: this.state.lastStepId,
            lastStepIndex: this.state.lastStepIndex,
          };
        }

        // Check for runtime next() navigation
        if (isNextStep(result)) {
          const nextIndex = steps.findIndex(s => s.config.id === result.stepId);
          if (nextIndex === -1) {
            throw new Error(`Step '${step.config.id}' called next('${result.stepId}') but step not found`);
          }
          // Only allow jumping within the execution range
          if (nextIndex < startIndex || nextIndex > endIndex) {
            this.logger.warn(`⚠️ next('${result.stepId}') jumps outside execution range, ignoring`);
            i++;
            continue;
          }
          this.logger.info(`  → next('${result.stepId}')`);
          this.state.lastStepId = step.config.id;
          this.state.lastStepIndex = i;
          i = nextIndex;
          continue;
        }

        // Process state updates from step result
        // Steps can return { state: {...}, set_env: {...} } to update context.state
        if (result && typeof result === 'object') {
          // Merge result.state into context.state
          if (result.state && typeof result.state === 'object') {
            console.log(`[runner] merging result.state keys: ${Object.keys(result.state).join(', ')}`);
            this.state.context.state = {
              ...this.state.context.state,
              ...result.state,
            };
          }
          // Also support set_env (YAML workflow compat) - merge into context.state
          if (result.set_env && typeof result.set_env === 'object') {
            console.log(`[runner] merging result.set_env keys: ${Object.keys(result.set_env).join(', ')}`);
            this.state.context.state = {
              ...this.state.context.state,
              ...result.set_env,
            };
          }
        }

        // Save step result
        emit.stepCompleted(step.config.id, step.config.name, Date.now() - stepStartTime, i + 1, totalSteps);
        this.state.stepResults[step.config.id] = {
          status: 'executed_without_error',
          result,
        };
        this.state.lastStepId = step.config.id;
        this.state.lastStepIndex = i;
        i++;

      } catch (error: any) {
        this.logger.error(`❌ Step failed: ${error.message}`);
        emit.stepFailed(step.config.id, step.config.name, error.message, Date.now() - stepStartTime);

        // Save step error
        this.state.stepResults[step.config.id] = {
          status: 'executed_with_error',
          error: error.message,
        };
        this.state.lastStepId = step.config.id;
        this.state.lastStepIndex = i;

        // Return error result
        return {
          status: 'executed_with_error',
          lastStepId: this.state.lastStepId,
          lastStepIndex: this.state.lastStepIndex,
          error: error.message,
        };
      }
    }

    return {
      status: 'executed_without_error',
      lastStepId: this.state.lastStepId,
      lastStepIndex: this.state.lastStepIndex,
    };
  }

  getState(): WorkflowState {
    return this.state;
  }
}

export function createWorkflowRunner(options: WorkflowRunnerOptions): WorkflowRunner {
  return new WorkflowRunner(options);
}
