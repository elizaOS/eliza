import { z } from "zod";
import { Desktop } from "@mediar-ai/computeruse";
import * as fs from "fs";
import * as path from "path";
import type {
    Workflow,
    WorkflowConfig,
    ResolvedWorkflowConfig,
    Step,
    WorkflowContext,
    WorkflowSuccessContext,
    WorkflowErrorContext,
    Logger,
    ExecutionResponse,
    ExecutionStatus,
    SuccessResult,
} from "./types";
import { ConsoleLogger, isWorkflowSuccess, isNextStep } from "./types";
import { createWorkflowRunner } from "./runner";
import { emit } from "./events";

/**
 * Workflow builder that accumulates state types
 * Reads workflow metadata from package.json in the current working directory
 */
function readPackageJson(): {
    name?: string;
    version?: string;
    description?: string;
} {
    try {
        const packageJsonPath = path.join(process.cwd(), "package.json");
        if (fs.existsSync(packageJsonPath)) {
            const content = fs.readFileSync(packageJsonPath, "utf-8");
            const pkg = JSON.parse(content);
            return {
                name: pkg.name,
                version: pkg.version,
                description: pkg.description,
            };
        }
    } catch {
        // Silently ignore errors reading package.json
    }
    return {};
}

/**
 * Resolves workflow config by adding name/version/description from package.json
 */
function resolveConfig<TInput>(
    config: WorkflowConfig<TInput>,
): ResolvedWorkflowConfig<TInput> {
    const pkgInfo = readPackageJson();

    return {
        ...config,
        name: pkgInfo.name || "Unnamed Workflow",
        version: pkgInfo.version,
        description: pkgInfo.description,
    };
}

/**
 * Workflow builder that accumulates state types
 * @template TInput - Type of workflow input
 * @template TState - Accumulated state type from all previous steps
 */
export class WorkflowBuilder<
    TInput = any,
    TState extends Record<string, any> = {},
> {
    private config: ResolvedWorkflowConfig<TInput>;
    private steps: Step[] = [];
    private successHandler?: (
        context: WorkflowSuccessContext<TInput, TState>,
    ) => Promise<any>;
    private errorHandler?: (
        context: WorkflowErrorContext<TInput, TState>,
    ) => Promise<void>;

    constructor(config: ResolvedWorkflowConfig<TInput>) {
        this.config = config;
    }

    /**
     * Add a step to the workflow - accumulates state types
     * @template TStepState - State updates produced by this step
     */
    step<TStepState extends Record<string, any> = {}>(
        step: Step<TInput, any, TState, TStepState>,
    ): WorkflowBuilder<TInput, TState & TStepState> {
        this.steps.push(step as Step);
        // Return new builder with accumulated state type
        return this as any as WorkflowBuilder<TInput, TState & TStepState>;
    }

    /**
     * Set success handler that returns workflow result data
     * The returned value will be set as context.data (workflow output)
     *
     * @example
     * ```typescript
     * .onSuccess(({ input, context }) => ({
     *   accountEmail: input.email,
     *   completed: true,
     * }))
     * ```
     */
    onSuccess<TSuccess = any>(
        handler: (
            context: Omit<WorkflowSuccessContext<TInput, TState>, "duration">,
        ) => TSuccess | Promise<TSuccess>,
    ): this {
        this.successHandler = async (ctx) => {
            const result = await Promise.resolve(
                handler({
                    input: ctx.input,
                    context: ctx.context,
                    logger: ctx.logger,
                }),
            );
            return result;
        };
        return this;
    }

    /**
     * Set error handler with typed state
     */
    onError(
        handler: (
            context: WorkflowErrorContext<TInput, TState>,
        ) => Promise<void>,
    ): this {
        this.errorHandler = handler;
        return this;
    }

    /**
     * Build the workflow
     */
    build(): Workflow<TInput> {
        return createWorkflowInstance(
            resolveConfig(this.config),
            this.steps,
            this.successHandler as any,
            this.errorHandler as any,
        );
    }
}

/**
 * Workflow builder that accumulates state types
 * Creates a workflow instance
 */
function createWorkflowInstance<TInput = any>(
    config: ResolvedWorkflowConfig<TInput>,
    steps: Step[],
    successHandler?: (context: WorkflowSuccessContext<TInput>) => Promise<SuccessResult | void> | SuccessResult | void,
    errorHandler?: (context: WorkflowErrorContext<TInput>) => Promise<void>,
): Workflow<TInput> {
    return {
        config,
        steps,

        async run(
            input: TInput,
            desktop?: Desktop,
            logger?: Logger,
            options?: {
                startFromStep?: string;
                endAtStep?: string;
                restoredState?: any;
            },
        ): Promise<ExecutionResponse> {
            const log = logger || new ConsoleLogger();
            const startTime = Date.now();

            log.info("=".repeat(60));
            log.info(`🚀 Starting workflow: ${config.name}`);
            if (config.description) {
                log.info(`   ${config.description}`);
            }
            log.info("=".repeat(60));
            log.info("");

            // Validate input
            const validationResult = config.input.safeParse(input);
            if (!validationResult.success) {
                log.error("❌ Input validation failed:");
                log.error(
                    JSON.stringify(validationResult.error.format(), null, 2),
                );
                throw new Error("Input validation failed");
            }

            const validatedInput = validationResult.data;

            // Get desktop instance (either passed or create new one)
            const desktopInstance = desktop || new Desktop();

            // Debug logging to see what options are passed
            log.info(
                `[DEBUG] workflow.run() options: ${JSON.stringify(options)}`,
            );

            // If step control options are provided, use WorkflowRunner for proper state tracking
            if (
                options?.startFromStep ||
                options?.endAtStep ||
                options?.restoredState
            ) {
                log.info(
                    `[DEBUG] Using WorkflowRunner path with endAtStep: ${options?.endAtStep}`,
                );

                // Create a minimal workflow object for the runner
                const workflowForRunner: Workflow = {
                    config,
                    steps,
                    async run() {
                        throw new Error("Recursive run not supported");
                    },
                    getMetadata() {
                        return {
                            name: config.name,
                            description: config.description,
                            version: config.version,
                            input: config.input,
                            steps: steps.map((s) => ({
                                id: s.config.id,
                                name: s.config.name,
                                description: s.config.description,
                            })),
                            trigger: config.trigger,
                        };
                    },
                };
                const runner = createWorkflowRunner({
                    workflow: workflowForRunner,
                    inputs: validatedInput,
                    startFromStep: options?.startFromStep,
                    endAtStep: options?.endAtStep,
                    restoredState: options?.restoredState,
                });

                const runnerResult = await runner.run();

                log.info(
                    `[DEBUG] WorkflowRunner result: ${JSON.stringify(runnerResult)}`,
                );

                // Return runner result with proper lastStepId and lastStepIndex
                const response = {
                    status: runnerResult.status as ExecutionStatus,
                    message: runnerResult.error || "Workflow completed",
                    data: runner.getState().context.data,
                    lastStepId: runnerResult.lastStepId,
                    lastStepIndex: runnerResult.lastStepIndex,
                    state: runner.getState(),
                };

                log.info(
                    `[DEBUG] Returning response with lastStepId: ${response.lastStepId}, lastStepIndex: ${response.lastStepIndex}`,
                );
                return response;
            }

            // Initialize context for non-runner execution
            const context: WorkflowContext<TInput> = {
                data: {},
                state: {},
                variables: validatedInput,
                setState(update) {
                    const updates = typeof update === "function" ? update(this.state) : update;
                    Object.assign(this.state, updates);
                },
            };

            // Track last completed step
            let lastStepId: string | undefined;
            let lastStepIndex: number | undefined;

            // Max iterations to prevent infinite loops
            const MAX_ITERATIONS = 1000;
            let iterations = 0;
            let stepStartTime = 0;
            let currentStep: Step | undefined;
            // Move currentIndex outside try block so it's accessible in catch for error reporting
            let currentIndex = 0;

            try {
                // Execute steps with support for branching via 'next' pointer

                while (
                    currentIndex < steps.length &&
                    iterations < MAX_ITERATIONS
                ) {
                    iterations++;
                    const step = steps[currentIndex];
                    currentStep = step;

                    // Check condition
                    if (step.config.condition) {
                        const shouldRun = step.config.condition({
                            input: validatedInput,
                            context,
                        });
                        if (!shouldRun) {
                            log.info(
                                `[${currentIndex + 1}/${steps.length}] ${step.config.name} (skipped)`,
                            );
                            currentIndex++;
                            continue;
                        }
                    }

                    log.info(
                        `[${currentIndex + 1}/${steps.length}] ${step.config.name}`,
                    );
                    const totalSteps = steps.length;
                    stepStartTime = Date.now();
                    emit.stepStarted(step.config.id, step.config.name, currentIndex + 1, totalSteps);

                    const stepResult = await step.run({
                        desktop: desktopInstance,
                        input: validatedInput,
                        context,
                        logger: log,
                    });

                    // Check for early success return
                    if (isWorkflowSuccess(stepResult)) {
                        const duration = Date.now() - startTime;
                        log.info("");
                        log.info("=".repeat(60));
                        log.success(`✅ Workflow completed early! (${duration}ms)`);
                        log.info("=".repeat(60));
                        // Set context.data for consistency with state
                        context.data = stepResult.result;
                        return {
                            status: "executed_without_error",
                            message: stepResult.result.message || "Workflow completed early",
                            data: context.data,
                            lastStepId: step.config.id,
                            lastStepIndex: currentIndex,
                            state: { context, lastStepId: step.config.id, lastStepIndex: currentIndex },
                        };
                    }

                    // Check for runtime next() navigation
                    if (isNextStep(stepResult)) {
                        const nextIndex = steps.findIndex(
                            (s) => s.config.id === stepResult.stepId,
                        );
                        if (nextIndex === -1) {
                            throw new Error(
                                `Step '${step.config.id}' called next('${stepResult.stepId}') but step not found`,
                            );
                        }
                        log.info(`  → next('${stepResult.stepId}')`);
                        lastStepId = step.config.id;
                        lastStepIndex = currentIndex;
                        currentIndex = nextIndex;
                        continue;
                    }

                    // Track last completed step for state persistence
                    emit.stepCompleted(step.config.id, step.config.name, Date.now() - stepStartTime, currentIndex + 1, totalSteps);
                    lastStepId = step.config.id;
                    lastStepIndex = currentIndex;

                    log.info("");

                    // Handle 'next' pointer for branching (config-time)
                    if (step.config.next) {
                        const nextStepId =
                            typeof step.config.next === "function"
                                ? step.config.next({
                                      input: validatedInput,
                                      context,
                                  })
                                : step.config.next;

                        if (nextStepId) {
                            const nextIndex = steps.findIndex(
                                (s) => s.config.id === nextStepId,
                            );
                            if (nextIndex === -1) {
                                throw new Error(
                                    `Step '${step.config.id}' references unknown next step: '${nextStepId}'`,
                                );
                            }
                            log.info(`  → jumping to '${nextStepId}'`);
                            currentIndex = nextIndex;
                            continue;
                        }
                    }

                    // Default: move to next sequential step
                    currentIndex++;
                }

                // Check for infinite loop
                if (iterations >= MAX_ITERATIONS) {
                    throw new Error(
                        `Workflow exceeded maximum iterations (${MAX_ITERATIONS}). Possible infinite loop detected.`,
                    );
                }

                const duration = Date.now() - startTime;

                log.info("=".repeat(60));
                log.success(
                    `✅ Workflow completed successfully! (${duration}ms)`,
                );
                log.info("=".repeat(60));

                // Call success handler if provided
                if (successHandler) {
                    const result = await successHandler({
                        input: validatedInput,
                        context,
                        logger: log,
                        duration,
                        lastStepId,
                        lastStepIndex,
                    });
                    // Automatically set context.data with returned value
                    if (result !== undefined) {
                        context.data = result;
                    }
                }

                // Return success response with state tracking
                return {
                    status: "executed_without_error",
                    message: `Workflow completed successfully in ${duration}ms`,
                    data: context.data,
                    lastStepId,
                    lastStepIndex,
                    state: { context, lastStepId, lastStepIndex },
                };
            } catch (error: any) {

                // Emit step failed event
                if (currentStep) {
                    emit.stepFailed(currentStep.config.id, currentStep.config.name, error.message, Date.now() - stepStartTime);
                }
                const duration = Date.now() - startTime;

                log.info("");
                log.info("=".repeat(60));
                log.error(`❌ Workflow failed! (${duration}ms)`);
                log.info("=".repeat(60));

                // The failed step is currentIndex (the step that threw the error)
                // BUG FIX: Previously used lastStepIndex which was the PREVIOUS successfully completed step
                const failedStepIndex = currentIndex;
                log.info(`[DEBUG] Failed step index: ${failedStepIndex}, currentIndex: ${currentIndex}, lastStepIndex: ${lastStepIndex}`);

                const failedStep =
                    failedStepIndex >= 0 && failedStepIndex < steps.length
                        ? steps[failedStepIndex]
                        : steps[steps.length - 1];

                // Always update lastStepId and lastStepIndex to the failed step
                // This ensures the error response contains the correct failed step info
                lastStepId = failedStep.config.id;
                lastStepIndex = failedStepIndex >= 0 ? failedStepIndex : steps.length - 1;

                // Call workflow-level error handler from config
                // Skip onError if we're doing step control (testing specific steps)
                const usingStepControl =
                    options?.startFromStep || options?.endAtStep;

                if (config.onError && !usingStepControl) {
                    try {
                        const errorResponse = await config.onError({
                            desktop: desktopInstance,
                            error,
                            step: failedStep,
                            input: validatedInput,
                            context,
                            logger: log,
                        });

                        // If workflow onError returns a response, use it
                        if (errorResponse) {
                            return errorResponse;
                        }
                    } catch (handlerError) {
                        log.error(
                            `❌ Workflow error handler failed: ${handlerError}`,
                        );
                    }
                } else if (usingStepControl) {
                    log.info(`⏭️ Skipping onError handler (step control mode)`);
                }

                // Call legacy error handler if provided (for backward compat)
                if (errorHandler) {
                    try {
                        await errorHandler({
                            desktop: desktopInstance,
                            error,
                            step: failedStep,
                            input: validatedInput,
                            context,
                            logger: log,
                        });
                    } catch (handlerError) {
                        log.error(`❌ Error handler failed: ${handlerError}`);
                    }
                }

                // Return error response with state tracking
                return {
                    status: "execution_error",
                    message: error.message,
                    data: context.data,
                    error: {
                        category: error.category || "technical",
                        code: error.code || "UNKNOWN_ERROR",
                        message: error.message,
                        recoverable: error.recoverable,
                        metadata: error.metadata || {
                            step: failedStep.config.name,
                            stepId: failedStep.config.id,
                            timestamp: new Date().toISOString(),
                        },
                    },
                    lastStepId,
                    lastStepIndex,
                    state: { context, lastStepId, lastStepIndex },
                };
            }
        },

        getMetadata() {
            return {
                name: config.name,
                description: config.description,
                version: config.version,
                input: config.input,
                steps: steps.map((s) => s.getMetadata()),
                trigger: config.trigger,
            };
        },
    };
}

/**
 * Creates a workflow builder or workflow instance with type-safe state accumulation
 *
 * If `steps` are provided in config, returns a Workflow directly.
 * Otherwise, returns a WorkflowBuilder for chaining with automatic state type tracking.
 *
 * @example
 * ```typescript
 * // Builder pattern with type-safe state accumulation
 * const workflow = createWorkflow({
 *   name: 'Data Processing',
 *   input: z.object({ sourceFile: z.string() }),
 * })
 *   .step(createStep({
 *     id: 'fetch',
 *     name: 'Fetch User Data',
 *     execute: async () => ({
 *       state: { userId: '123', userName: 'John' }
 *     })
 *   }))
 *   .step(createStep({
 *     id: 'process',
 *     name: 'Process Data',
 *     execute: async ({ context }) => {
 *       // TypeScript knows context.state has userId and userName!
 *       const id = context.state.userId;  // string (with IntelliSense)
 *       const name = context.state.userName;  // string (with IntelliSense)
 *       return { state: { processedCount: 42 } };
 *     }
 *   }))
 *   .step(createStep({
 *     id: 'finalize',
 *     name: 'Finalize',
 *     execute: async ({ context }) => {
 *       // TypeScript knows ALL accumulated state
 *       context.state.userId;  // string
 *       context.state.userName;  // string
 *       context.state.processedCount;  // number
 *     }
 *   }))
 *   .build();
 *
 * // Direct pattern
 * const workflow = createWorkflow({
 *   name: 'SAP Login',
 *   input: z.object({ username: z.string() }),
 *   steps: [loginStep, processStep],
 *   onError: async ({ error }) => ({ status: 'error', ... })
 * });
 * ```
 */

// Single signature that always returns WorkflowBuilder for builder pattern
export function createWorkflow<TInput = any>(
    config: Omit<WorkflowConfig<TInput>, "steps" | "onError">,
): WorkflowBuilder<TInput, {}>;

// Overload for direct pattern with steps array
export function createWorkflow<TInput = any>(
    config: WorkflowConfig<TInput> &
        Required<Pick<WorkflowConfig<TInput>, "steps">>,
): Workflow<TInput>;

// Implementation
export function createWorkflow<TInput = any>(
    config: WorkflowConfig<TInput>,
): WorkflowBuilder<TInput, {}> | Workflow<TInput> {
    // If steps are provided in config, create workflow directly
    if (config.steps && config.steps.length > 0) {
        // Wrap config.onSuccess to match the internal signature
        const successHandler = config.onSuccess
            ? async (ctx: WorkflowSuccessContext<TInput>) => {
                  return await Promise.resolve(config.onSuccess!(ctx));
              }
            : undefined;

        return createWorkflowInstance(
            resolveConfig(config),
            config.steps,
            successHandler,
        );
    }

    // Otherwise, return builder for chaining with type-safe state
    return new WorkflowBuilder<TInput, {}>(resolveConfig(config));
}
