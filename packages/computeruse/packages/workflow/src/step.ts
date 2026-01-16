import {
    Step,
    StepConfig,
    StepContext,
    ErrorContext,
    ErrorRecoveryResult,
    ExpectationContext,
    ExpectationResult,
    ExecuteError,
    StepResult,
    isWorkflowSuccess,
    isRetry,
    isNextStep,
} from "./types";

/**
 * Creates a workflow step with optional type inference for state
 *
 * @example
 * ```typescript
 * // Basic step with automatic retries (recommended for simple cases)
 * const clickButton = createStep({
 *   id: 'click_submit',
 *   name: 'Click Submit Button',
 *   retries: 3,        // Retry up to 3 times on failure
 *   retryDelayMs: 1000, // Start with 1s delay (doubles each retry)
 *   execute: async ({ desktop }) => {
 *     await desktop.locator('role:button[name="Submit"]').click();
 *   }
 * });
 *
 * // Step with custom error handling (for complex recovery logic)
 * const login = createStep({
 *   id: 'login',
 *   name: 'Login to Application',
 *   execute: async ({ desktop, input }) => {
 *     await desktop.locator('role:textbox').fill(input.username);
 *     await desktop.locator('role:button').click();
 *   },
 *   onError: async ({ error, retry, logger }) => {
 *     if (error.message.includes('Session conflict')) {
 *       logger.info('Session conflict detected, retrying...');
 *       return retry();
 *     }
 *     return { recoverable: false, reason: error.message };
 *   }
 * });
 *
 * // Step with typed state
 * const processData = createStep<MyInput, MyOutput, { userId: string }, { processedCount: number }>({
 *   id: 'process',
 *   name: 'Process Data',
 *   execute: async ({ context }) => {
 *     const id = context.state.userId; // TypeScript knows this is a string
 *     return { state: { processedCount: 42 } };
 *   }
 * });
 * ```
 */
export function createStep<
    TInput = any,
    TOutput = any,
    TStateIn extends Record<string, any> = Record<string, any>,
    TStateOut extends Record<string, any> = Record<string, any>,
>(
    config: StepConfig<TInput, TOutput, TStateIn, TStateOut>,
): Step<TInput, TOutput, TStateIn, TStateOut> {
    return {
        config,

        async run(
            context: StepContext<TInput, TStateIn>,
        ): Promise<TOutput | void> {
            const { logger } = context;
            const startTime = Date.now();

            try {
                // Check condition if provided
                if (config.condition) {
                    const shouldRun = config.condition({
                        input: context.input,
                        context: context.context,
                    });

                    if (!shouldRun) {
                        logger.info(
                            `⏭️  Skipping step: ${config.name} (condition not met)`,
                        );
                        return;
                    }
                }

                logger.info(`▶️  Executing step: ${config.name}`);

                // Execute with timeout if specified
                let result: StepResult<TOutput> | TOutput | void;

                if (config.timeout) {
                    result = await Promise.race([
                        config.execute(context),
                        new Promise<never>((_, reject) =>
                            setTimeout(
                                () =>
                                    reject(
                                        new Error(
                                            `Step timeout after ${config.timeout}ms`,
                                        ),
                                    ),
                                config.timeout,
                            ),
                        ),
                    ]);
                } else {
                    result = await config.execute(context);
                }


                // Check for early workflow success - return immediately without normalization
                if (isWorkflowSuccess(result)) {
                    const duration = Date.now() - startTime;
                    logger.success(`✅ Completed step: ${config.name} (${duration}ms)`);
                    return result as any;
                }

                // Check for retry marker - re-execute step
                if (isRetry(result)) {
                    logger.info(`🔄 Retry requested, re-executing: ${config.name}...`);
                    return await this.run(context);
                }

                // Check for next step marker - return it to workflow for handling
                if (isNextStep(result)) {
                    const duration = Date.now() - startTime;
                    logger.success(`✅ Completed step: ${config.name} (${duration}ms)`);
                    return result as any;
                }
                // Normalize result to StepResult format
                let normalizedResult: StepResult<TOutput, TStateOut> | void;

                if (result === undefined || result === null) {
                    normalizedResult = undefined;
                } else if (
                    typeof result === "object" &&
                    ("data" in result || "state" in result)
                ) {
                    // Already a StepResult
                    normalizedResult = result as StepResult<TOutput, TStateOut>;
                } else {
                    // Plain object - wrap it as state updates for backward compatibility
                    normalizedResult = { state: result as any };
                }

                // Merge state updates into context
                if (normalizedResult && normalizedResult.state) {
                    Object.assign(
                        context.context.state,
                        normalizedResult.state,
                    );
                }

                // Store data in context.data keyed by step id
                if (normalizedResult && normalizedResult.data !== undefined) {
                    context.context.data[config.id] = normalizedResult.data;
                }

                // Run expectation validation if provided
                if (config.expect) {
                    logger.info(
                        `🔍 Validating expectations for: ${config.name}`,
                    );

                    const expectContext: ExpectationContext<
                        TInput,
                        TOutput,
                        TStateIn
                    > = {
                        desktop: context.desktop,
                        input: context.input,
                        result: normalizedResult?.data as TOutput,
                        context: context.context,
                        logger: context.logger,
                    };

                    const expectResult = await config.expect(expectContext);

                    if (!expectResult.success) {
                        const errorMsg =
                            expectResult.message || "Expectation not met";
                        logger.error(`❌ Expectation failed: ${errorMsg}`);
                        throw new Error(`Expectation failed: ${errorMsg}`);
                    }

                    logger.success(
                        `✅ Expectations met: ${expectResult.message || "Success"}`,
                    );
                }

                const duration = Date.now() - startTime;
                logger.success(
                    `✅ Completed step: ${config.name} (${duration}ms)`,
                );

                return normalizedResult?.data as TOutput;
            } catch (error: any) {
                const duration = Date.now() - startTime;
                logger.error(`❌ Step failed: ${config.name} (${duration}ms)`);
                logger.error(`   Error: ${error.message}`);

                // Enrich error with step metadata if not already present
                if (!error.metadata) {
                    error.metadata = {
                        step: config.name,
                        stepId: config.id,
                        duration,
                        timestamp: new Date().toISOString(),
                    };
                }

                // Track attempt count for retries
                const currentAttempt = (error._retryAttempt as number) || 0;

                // Handle automatic retries (sugar for onError + retry pattern)
                if (config.retries && config.retries > 0 && !config.onError) {
                    if (currentAttempt < config.retries) {
                        const delayMs =
                            (config.retryDelayMs || 1000) *
                            Math.pow(2, currentAttempt);
                        logger.info(
                            `🔄 Retry ${currentAttempt + 1}/${config.retries} for ${config.name} (waiting ${delayMs}ms)...`,
                        );

                        await new Promise((resolve) =>
                            setTimeout(resolve, delayMs),
                        );

                        // Mark attempt count for next iteration
                        const retryError = new Error(error.message);
                        (retryError as any)._retryAttempt = currentAttempt + 1;
                        Object.assign(retryError, error);

                        // Re-run the step
                        try {
                            return await this.run(context);
                        } catch (retryErr: any) {
                            // If retry also fails, propagate with updated attempt count
                            if (!retryErr._retryAttempt) {
                                retryErr._retryAttempt = currentAttempt + 1;
                            }
                            throw retryErr;
                        }
                    } else {
                        logger.error(
                            `❌ Max retries (${config.retries}) exceeded for ${config.name}`,
                        );
                        error.recoverable = false;
                        error.code = "MAX_RETRIES_EXCEEDED";
                        throw error;
                    }
                }

                // Try error recovery if handler provided
                if (config.onError) {
                    const errorContext: ErrorContext<
                        TInput,
                        TOutput,
                        TStateIn
                    > = {
                        error,
                        desktop: context.desktop,
                        input: context.input,
                        context: context.context,
                        logger: context.logger,
                        attempt: currentAttempt,
                        retry: async () => {
                            logger.info(`🔄 Retrying step: ${config.name}...`);
                            const result = await this.run(context);
                            return result as TOutput;
                        },
                    };

                    const recoveryResult = await config.onError(errorContext);

                    if (recoveryResult && !recoveryResult.recoverable) {
                        logger.error(
                            `❌ Cannot recover: ${recoveryResult.reason || "Unknown"}`,
                        );

                        // Enrich error with recovery information
                        error.recoverable = false;
                        if (recoveryResult.reason && !error.code) {
                            error.code = "RECOVERY_FAILED";
                        }

                        throw error;
                    }

                    // If onError returned void or recoverable: true, it handled the retry
                    return;
                }

                // No error handler - mark as non-recoverable and rethrow
                if (error.recoverable === undefined) {
                    error.recoverable = false;
                }

                throw error;
            }
        },

        getMetadata() {
            return {
                id: config.id,
                name: config.name,
                description: config.description,
            };
        },
    };
}
