/**
 * Integration tests for Workflow SDK
 * Tests error handling, onError callback, and real Calculator automation
 */

import { Desktop } from "@mediar-ai/computeruse";
import { createWorkflow, createStep, z } from "../index";
import type { StepResult } from "../types";

describe("Workflow Integration Tests - Calculator", () => {
    let desktop: Desktop;

    beforeEach(async () => {
        desktop = new Desktop();
    });

    afterEach(async () => {
        // Clean up - close Calculator if it's open
        try {
            const calc = await desktop.locator("name:Calculator").first(2000);
            await calc.close();
        } catch {
            // Calculator wasn't open, that's fine
        }
    });

    describe("Error Handling", () => {
        test("onError callback is called when step fails", async () => {
            const errorHandler = jest.fn();
            let errorCaught = false;

            const failingStep = createStep({
                id: "failing_step",
                name: "Failing Step",
                execute: async (): Promise<StepResult> => {
                    throw new Error("Intentional test failure");
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [failingStep],
                onError: async ({ error, step, logger }: { error: Error; step: any; logger: any }) => {
                    errorCaught = true;
                    errorHandler(error, step.config.name);
                    logger.error(`Error handler called: ${error.message}`);
                },
            });

            const result = await workflow.run({}, desktop);

            expect(result.status).toBe("error");
            expect(result.message).toContain("Intentional test failure");
            expect(errorCaught).toBe(true);
            expect(errorHandler).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: "Intentional test failure",
                }),
                "Failing Step",
            );
        });

        test("onError can return custom error response", async () => {
            const failingStep = createStep({
                id: "failing_step",
                name: "Failing Step",
                execute: async (): Promise<StepResult> => {
                    throw new Error("Test error");
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [failingStep],
                onError: async (): Promise<any> => {
                    return {
                        status: "error" as const,
                        message: "Custom error message from handler",
                        error: {
                            category: "business" as const,
                            code: "CUSTOM_ERROR",
                            message: "Handled gracefully",
                            recoverable: true,
                        },
                        data: { customField: "custom value" },
                    };
                },
            });

            const result = await workflow.run({}, desktop);

            expect(result.status).toBe("error");
            expect(result.message).toBe("Custom error message from handler");
            expect(result.error?.code).toBe("CUSTOM_ERROR");
            expect(result.error?.category).toBe("business");
            expect(result.data).toEqual({ customField: "custom value" });
        });

        test("workflow continues if onError throws", async () => {
            const failingStep = createStep({
                id: "failing_step",
                name: "Failing Step",
                execute: async (): Promise<StepResult> => {
                    throw new Error("Step failure");
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [failingStep],
                onError: async (): Promise<void> => {
                    throw new Error("Error handler also fails");
                },
            });

            const result = await workflow.run({}, desktop);

            // Workflow should still return error response even if handler fails
            expect(result.status).toBe("error");
            expect(result.message).toBe("Step failure");
        });
    });

    describe("Calculator Automation", () => {
        test("open Calculator and verify window", async () => {
            const openStep = createStep({
                id: "open_calc",
                name: "Open Calculator",
                execute: async ({ desktop }) => {
                    await desktop.openApplication("calc");
                    await desktop.delay(2000);

                    const calc = await desktop
                        .locator("name:Calculator")
                        .first(3000);
                    return {
                        state: {
                            calculator_open: true,
                            window: calc,
                        },
                    };
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [openStep],
            });

            const result = await workflow.run({}, desktop);

            expect(result.status).toBe("success");
        });

        test("Calculator addition workflow", async () => {
            const openCalc = createStep({
                id: "open",
                name: "Open Calculator",
                execute: async ({ desktop }) => {
                    await desktop.openApplication("calc");
                    await desktop.delay(2000);
                    return { state: { opened: true } };
                },
            });

            const clickOne = createStep({
                id: "click_one",
                name: "Click 1",
                execute: async ({ desktop }) => {
                    const one = await desktop
                        .locator("name:Calculator >> name:One")
                        .first(3000);
                    await one.click();
                    return { state: { clicked_one: true } };
                },
            });

            const clickPlus = createStep({
                id: "click_plus",
                name: "Click Plus",
                execute: async ({ desktop }) => {
                    const plus = await desktop
                        .locator("name:Calculator >> name:Plus")
                        .first(3000);
                    await plus.click();
                    return { state: { clicked_plus: true } };
                },
            });

            const clickTwo = createStep({
                id: "click_two",
                name: "Click 2",
                execute: async ({ desktop }) => {
                    const two = await desktop
                        .locator("name:Calculator >> name:Two")
                        .first(3000);
                    await two.click();
                    return { state: { clicked_two: true } };
                },
            });

            const clickEquals = createStep({
                id: "click_equals",
                name: "Click Equals",
                execute: async ({ desktop }) => {
                    const equals = await desktop
                        .locator("name:Calculator >> name:Equals")
                        .first(3000);
                    await equals.click();
                    await desktop.delay(500);
                    return { state: { clicked_equals: true } };
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [openCalc, clickOne, clickPlus, clickTwo, clickEquals],
            });

            const result = await workflow.run({}, desktop);

            expect(result.status).toBe("success");
        });

        test("Calculator workflow with error recovery", async () => {
            let errorOccurred = false;
            let recoveryAttempted = false;

            const openCalc = createStep({
                id: "open",
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
                    // This should fail - button doesn't exist
                    const btn = await desktop
                        .locator("name:Calculator >> name:NonExistentButton")
                        .first(1000);
                    await btn.click();
                    return { state: { clicked: true } };
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [openCalc, clickInvalidButton],
                onError: async ({ error, logger }) => {
                    errorOccurred = true;
                    recoveryAttempted = true;
                    logger.info("Recovering from error...");

                    return {
                        status: "error" as const,
                        message: "Button not found - this is expected",
                        error: {
                            category: "technical" as const,
                            code: "BUTTON_NOT_FOUND",
                            message: error.message,
                            recoverable: false,
                        },
                        data: {},
                    };
                },
            });

            const result = await workflow.run({}, desktop);

            expect(result.status).toBe("error");
            expect(errorOccurred).toBe(true);
            expect(recoveryAttempted).toBe(true);
            expect(result.message).toContain("Button not found");
        });
    });

    describe("State Accumulation", () => {
        test("state accumulates across steps", async () => {
            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async () => {
                    return { state: { value1: "hello" } };
                },
            });

            const step2 = createStep({
                id: "step2",
                name: "Step 2",
                execute: async ({ context }) => {
                    expect(context.state.value1).toBe("hello");
                    return { state: { value2: "world" } };
                },
            });

            const step3 = createStep({
                id: "step3",
                name: "Step 3",
                execute: async ({ context }) => {
                    expect(context.state.value1).toBe("hello");
                    expect(context.state.value2).toBe("world");
                    return { state: { value3: "!" } };
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1, step2, step3],
            });

            const result = await workflow.run({}, desktop);

            expect(result.status).toBe("success");
        });
    });
});
