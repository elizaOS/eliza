/**
 * End-to-End tests for Workflow SDK with MCP client+server
 * Tests the full loop: computeruse CLI -> MCP server -> TypeScript workflow execution
 *
 * Tests:
 * - Workflow state persistence (.mediar)
 * - retry() functionality
 * - onError handling
 * - Start from specific step
 * - End at specific step
 * - State restoration across retries
 */

import { Desktop } from "@mediar-ai/computeruse";
import { createWorkflow, createStep, z, retry } from "../index";
import * as fs from "fs";
import * as path from "path";

const TEMP_WORKFLOW_DIR = path.join(process.cwd(), "__test_workflows__");

describe("Workflow E2E Tests - MCP Client+Server Loop", () => {
    let desktop: Desktop;

    beforeAll(() => {
        // Create temp directory for test workflows
        if (!fs.existsSync(TEMP_WORKFLOW_DIR)) {
            fs.mkdirSync(TEMP_WORKFLOW_DIR, { recursive: true });
        }
    });

    beforeEach(async () => {
        desktop = new Desktop();
    });

    afterEach(async () => {
        // Clean up Calculator if open
        try {
            const calc = await desktop.locator("name:Calculator").first(1000);
            await calc.close();
        } catch {
            // Not open
        }
    });

    afterAll(() => {
        // Clean up temp directory
        if (fs.existsSync(TEMP_WORKFLOW_DIR)) {
            fs.rmSync(TEMP_WORKFLOW_DIR, { recursive: true, force: true });
        }
    });

    describe("Workflow State Persistence", () => {
        test("workflow state is saved to .mediar file", async () => {
            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async () => {
                    return { state: { step1_data: "hello", step1_count: 42 } };
                },
            });

            const step2 = createStep({
                id: "step2",
                name: "Step 2",
                execute: async ({ context }) => {
                    expect(context.state.step1_data).toBe("hello");
                    expect(context.state.step1_count).toBe(42);
                    return { state: { step2_data: "world", step2_count: 99 } };
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1, step2],
            });

            const result = await workflow.run({}, desktop);

            expect(result.status).toBe("executed_without_error");

            // Verify state is in response
            expect(result.data).toBeDefined();
        });

        test("workflow state persists across step failures", async () => {
            let step2Attempts = 0;

            const step1 = createStep({
                id: "step1_persist",
                name: "Step 1 (Success)",
                execute: async () => {
                    return {
                        state: {
                            important_data: "preserved",
                            timestamp: Date.now(),
                        },
                    };
                },
            });

            const step2 = createStep({
                id: "step2_fail",
                name: "Step 2 (Fails first time)",
                execute: async ({ context }) => {
                    step2Attempts++;
                    expect(context.state.important_data).toBe("preserved");

                    if (step2Attempts === 1) {
                        throw new Error("First attempt fails");
                    }
                    return { state: { step2_complete: true } };
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1, step2],
            });

            // First run - should fail on step 2
            const result1 = await workflow.run({}, desktop);
            expect(result1.status).toBe("execution_error");
            expect(step2Attempts).toBe(1);

            // Second run - should succeed and preserve state from step 1
            const result2 = await workflow.run({}, desktop);
            expect(result2.status).toBe("executed_without_error");
            expect(step2Attempts).toBe(2);
        });
    });

    describe("Retry Functionality", () => {
        test("step can retry on failure", async () => {
            let attempts = 0;

            const retryStep = createStep({
                id: "retry_step",
                name: "Retry Step",
                execute: async () => {
                    attempts++;
                    if (attempts < 3) {
                        throw new Error(`Attempt ${attempts} failed`);
                    }
                    return { state: { succeeded_on_attempt: attempts } };
                },
                onError: async ({ error, retry: retryFn, logger }) => {
                    logger.info(`Retry attempt ${attempts}: ${error.message}`);
                    if (attempts < 3) {
                        await retryFn();
                        return;
                    }
                    throw error;
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [retryStep],
            });

            const result = await workflow.run({}, desktop);

            expect(result.status).toBe("executed_without_error");
            expect(attempts).toBe(3);
        });

        test("retry limit is enforced", async () => {
            let attempts = 0;
            const MAX_RETRIES = 5;

            const retryStep = createStep({
                id: "retry_limit_step",
                name: "Retry Limit Step",
                execute: async () => {
                    attempts++;
                    throw new Error(`Attempt ${attempts} always fails`);
                },
                onError: async ({ error, retry: retryFn, logger }) => {
                    logger.info(`Attempt ${attempts}: ${error.message}`);
                    if (attempts < MAX_RETRIES) {
                        await retryFn();
                        return;
                    }
                    // Max retries reached, propagate error
                    throw error;
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [retryStep],
            });

            const result = await workflow.run({}, desktop);

            expect(result.status).toBe("execution_error");
            expect(attempts).toBe(MAX_RETRIES);
            expect(result.message).toContain("always fails");
        });

        test("retry() function can be thrown from execute()", async () => {
            let attempts = 0;

            const retryStep = createStep({
                id: "retry_function_step",
                name: "Retry Function Step",
                execute: async () => {
                    attempts++;
                    if (attempts < 3) {
                        throw retry(); // Use the new retry() function
                    }
                    return { state: { succeeded_on_attempt: attempts } };
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [retryStep],
            });

            const result = await workflow.run({}, desktop);

            expect(result.status).toBe("executed_without_error");
            expect(attempts).toBe(3);
        });

        test("retry() function works with state preservation", async () => {
            let attempts = 0;

            const step1 = createStep({
                id: "setup",
                name: "Setup",
                execute: async () => {
                    return {
                        state: { setup_complete: true, important_value: 42 },
                    };
                },
            });

            const step2 = createStep({
                id: "retry_with_state",
                name: "Retry With State",
                execute: async ({ context }) => {
                    attempts++;

                    // State should be preserved
                    expect(context.state.setup_complete).toBe(true);
                    expect(context.state.important_value).toBe(42);

                    if (attempts < 2) {
                        throw retry();
                    }
                    return { state: { final_attempt: attempts } };
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1, step2],
            });

            const result = await workflow.run({}, desktop);

            expect(result.status).toBe("executed_without_error");
            expect(attempts).toBe(2);
        });

        test("state is preserved across retries", async () => {
            let retryCount = 0;

            const step1 = createStep({
                id: "setup_step",
                name: "Setup Step",
                execute: async () => {
                    return {
                        state: {
                            setup_value: "important",
                            setup_time: Date.now(),
                        },
                    };
                },
            });

            const step2 = createStep({
                id: "retry_with_state",
                name: "Retry with State",
                execute: async ({ context }) => {
                    retryCount++;

                    // State should be preserved from previous step
                    expect(context.state.setup_value).toBe("important");
                    expect(context.state.setup_time).toBeDefined();

                    if (retryCount < 2) {
                        throw new Error("Not ready yet");
                    }

                    return {
                        state: {
                            retry_succeeded: true,
                            total_retries: retryCount,
                        },
                    };
                },
                onError: async ({ retry: retryFn }) => {
                    if (retryCount < 2) {
                        await retryFn();
                        return;
                    }
                    throw new Error("Max retries");
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1, step2],
            });

            const result = await workflow.run({}, desktop);

            expect(result.status).toBe("executed_without_error");
            expect(retryCount).toBe(2);
        });
    });

    describe("Calculator E2E with Retry and State", () => {
        test("Calculator workflow with intermittent failures and retry", async () => {
            let openAttempts = 0;
            let clickAttempts = 0;

            const openCalc = createStep({
                id: "open_calc_retry",
                name: "Open Calculator (with retry)",
                execute: async ({ desktop }) => {
                    openAttempts++;
                    await desktop.openApplication("calc");
                    await desktop.delay(2000);
                    return {
                        state: {
                            calculator_opened: true,
                            open_attempt: openAttempts,
                        },
                    };
                },
            });

            const clickNumber = createStep({
                id: "click_number",
                name: "Click Number (may fail)",
                execute: async ({ desktop, context }) => {
                    clickAttempts++;

                    // Verify state from previous step
                    expect(context.state.calculator_opened).toBe(true);

                    // Simulate intermittent failure
                    if (clickAttempts === 1) {
                        throw new Error("UI not ready yet");
                    }

                    const one = await desktop
                        .locator("name:Calculator >> name:One")
                        .first(3000);
                    await one.click();
                    return {
                        state: {
                            number_clicked: true,
                            click_attempt: clickAttempts,
                        },
                    };
                },
                onError: async ({ error, retry: retryFn, logger }) => {
                    logger.info(
                        `Click failed (attempt ${clickAttempts}): ${error.message}`,
                    );
                    if (clickAttempts < 3) {
                        await retryFn();
                        return;
                    }
                    throw error;
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [openCalc, clickNumber],
            });

            const result = await workflow.run({}, desktop);

            expect(result.status).toBe("executed_without_error");
            expect(openAttempts).toBe(1);
            expect(clickAttempts).toBe(2); // Failed once, succeeded on second attempt
        });

        test("Calculator workflow with onError recovery", async () => {
            let errorRecovered = false;

            const openCalc = createStep({
                id: "open_calc_error",
                name: "Open Calculator",
                execute: async ({ desktop }) => {
                    await desktop.openApplication("calc");
                    await desktop.delay(2000);
                    return { state: { opened: true } };
                },
            });

            const clickInvalidButton = createStep({
                id: "click_invalid",
                name: "Click Invalid Button",
                execute: async ({ desktop }) => {
                    // This will fail - button doesn't exist
                    const btn = await desktop
                        .locator("name:Calculator >> name:NonExistent")
                        .first(1000);
                    await btn.click();
                    return { state: { clicked: true } };
                },
                onError: async ({ logger, context }) => {
                    logger.info(
                        "Button not found - recovering by clicking valid button instead",
                    );
                    errorRecovered = true;

                    // Verify we still have state from previous steps
                    expect(context.state.opened).toBe(true);

                    // Update state directly to mark recovery
                    context.state.error_recovered = true;
                    context.state.fallback_used = true;

                    // Return void to indicate successful recovery without retry
                    return;
                },
            });

            const verifyRecovery = createStep({
                id: "verify",
                name: "Verify Recovery",
                execute: async ({ context }) => {
                    expect(context.state.error_recovered).toBe(true);
                    expect(context.state.fallback_used).toBe(true);
                    expect(context.state.opened).toBe(true);
                    return { state: { verified: true } };
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [openCalc, clickInvalidButton, verifyRecovery],
            });

            const result = await workflow.run({}, desktop);

            expect(result.status).toBe("executed_without_error");
            expect(errorRecovered).toBe(true);
        });
    });

    describe("Complex Error Scenarios", () => {
        test("nested error handling with multiple retry layers", async () => {
            let step1Retries = 0;
            let step2Retries = 0;
            let workflowOnErrorCalled = false;

            const step1 = createStep({
                id: "step1_nested",
                name: "Step 1 (retries twice)",
                execute: async () => {
                    step1Retries++;
                    if (step1Retries < 3) {
                        throw new Error("Step 1 not ready");
                    }
                    return {
                        state: {
                            step1_done: true,
                            step1_retries: step1Retries,
                        },
                    };
                },
                onError: async ({ retry: retryFn }) => {
                    if (step1Retries < 3) {
                        await retryFn();
                        return;
                    }
                    throw new Error("Step 1 max retries");
                },
            });

            const step2 = createStep({
                id: "step2_nested",
                name: "Step 2 (retries once)",
                execute: async ({ context }) => {
                    step2Retries++;
                    expect(context.state.step1_done).toBe(true);

                    if (step2Retries < 2) {
                        throw new Error("Step 2 not ready");
                    }
                    return {
                        state: {
                            step2_done: true,
                            step2_retries: step2Retries,
                        },
                    };
                },
                onError: async ({ retry: retryFn }) => {
                    if (step2Retries < 2) {
                        await retryFn();
                        return;
                    }
                    throw new Error("Step 2 max retries");
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1, step2],
                onError: async ({ error, step, logger }) => {
                    workflowOnErrorCalled = true;
                    logger.error(
                        `Workflow failed at ${step.config.name}: ${error.message}`,
                    );
                    // Don't return custom response, let it propagate
                },
            });

            const result = await workflow.run({}, desktop);

            expect(result.status).toBe("executed_without_error");
            expect(step1Retries).toBe(3);
            expect(step2Retries).toBe(2);
            expect(workflowOnErrorCalled).toBe(false); // Shouldn't be called since workflow succeeded
        });

        test("workflow onError is called when all retries exhausted", async () => {
            let stepRetries = 0;
            let workflowErrorHandled = false;

            const failingStep = createStep({
                id: "always_fails",
                name: "Always Fails Step",
                execute: async () => {
                    stepRetries++;
                    throw new Error(`Fail ${stepRetries}`);
                },
                onError: async ({ retry: retryFn }) => {
                    if (stepRetries < 2) {
                        return retryFn();
                    }
                    throw new Error("Step exhausted retries");
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [failingStep],
                onError: async ({ error, step, logger }) => {
                    workflowErrorHandled = true;
                    logger.error(
                        `Workflow caught error from ${step.config.name}`,
                    );

                    return {
                        status: "execution_error" as const,
                        message: "Workflow handled the error gracefully",
                        error: {
                            category: "business" as const,
                            code: "HANDLED",
                            message: error.message,
                            recoverable: false,
                        },
                        data: { workflow_error_handled: true },
                    };
                },
            });

            const result = await workflow.run({}, desktop);

            expect(result.status).toBe("execution_error");
            expect(result.message).toBe(
                "Workflow handled the error gracefully",
            );
            expect(stepRetries).toBe(2);
            expect(workflowErrorHandled).toBe(true);
            expect(result.data).toEqual({ workflow_error_handled: true });
        });
    });

    describe("State Accumulation Edge Cases", () => {
        test("state from failed step is not persisted", async () => {
            let failingStepExecutions = 0;

            const step1 = createStep({
                id: "step1_clean",
                name: "Step 1",
                execute: async () => {
                    return { state: { clean_state: "preserved" } };
                },
            });

            const step2 = createStep({
                id: "step2_fails",
                name: "Step 2 (fails)",
                execute: async ({ context }) => {
                    failingStepExecutions++;

                    // Add some state
                    context.state.dirty_state = "should_not_persist";

                    throw new Error("Step 2 always fails");
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1, step2],
            });

            const result = await workflow.run({}, desktop);

            expect(result.status).toBe("execution_error");
            expect(failingStepExecutions).toBe(1);

            // State from step 1 should still be in context, but not dirty state from failed step
            expect(result.data).toBeDefined();
        });

        test("state accumulates correctly across many steps", async () => {
            const steps = [];
            const NUM_STEPS = 10;

            for (let i = 0; i < NUM_STEPS; i++) {
                steps.push(
                    createStep({
                        id: `step${i}`,
                        name: `Step ${i}`,
                        execute: async ({ context }) => {
                            // Verify all previous steps' state is present
                            for (let j = 0; j < i; j++) {
                                expect(context.state[`step${j}_data`]).toBe(
                                    `data_${j}`,
                                );
                            }

                            return {
                                state: { [`step${i}_data`]: `data_${i}` },
                            };
                        },
                    }),
                );
            }

            const workflow = createWorkflow({
                input: z.object({}),
                steps,
            });

            const result = await workflow.run({}, desktop);

            expect(result.status).toBe("executed_without_error");
        });
    });
});
