/**
 * Unit tests for workflow navigation: next() and retry()
 */

import { createWorkflow, createStep, z, next, retry } from "../index";
import type { StepResult } from "../types";

// Mock Desktop for unit tests
const mockDesktop = {
    locator: jest.fn(),
    openApplication: jest.fn(),
    delay: jest.fn(),
} as any;

describe("Workflow Navigation Tests", () => {
    describe("next() runtime navigation", () => {
        test("jumps to specified step when next() is returned", async () => {
            const executionOrder: string[] = [];

            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async (): Promise<StepResult> => {
                    executionOrder.push("step1");
                    return { state: { step1: true } };
                },
            });

            const step2 = createStep({
                id: "step2",
                name: "Step 2 - jumps to step4",
                execute: async () => {
                    executionOrder.push("step2");
                    return next("step4");
                },
            });

            const step3 = createStep({
                id: "step3",
                name: "Step 3 - should be skipped",
                execute: async (): Promise<StepResult> => {
                    executionOrder.push("step3");
                    return { state: { step3: true } };
                },
            });

            const step4 = createStep({
                id: "step4",
                name: "Step 4 - target",
                execute: async (): Promise<StepResult> => {
                    executionOrder.push("step4");
                    return { state: { step4: true } };
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1, step2, step3, step4],
            });

            const result = await workflow.run({}, mockDesktop);

            expect(result.status).toBe("executed_without_error");
            expect(executionOrder).toEqual(["step1", "step2", "step4"]);
            // step3 should NOT have run
            expect(executionOrder).not.toContain("step3");
        });

        test("next() can jump backwards for loops", async () => {
            const executionOrder: string[] = [];
            let counter = 0;

            const step1 = createStep({
                id: "step1",
                name: "Step 1 - increment counter",
                execute: async () => {
                    executionOrder.push(`step1-${counter}`);
                    counter++;
                    if (counter < 3) {
                        return next("step1"); // loop back
                    }
                    return { state: { counter } };
                },
            });

            const step2 = createStep({
                id: "step2",
                name: "Step 2 - after loop",
                execute: async (): Promise<StepResult> => {
                    executionOrder.push("step2");
                    return { state: { done: true } };
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1, step2],
            });

            const result = await workflow.run({}, mockDesktop);

            expect(result.status).toBe("executed_without_error");
            expect(executionOrder).toEqual(["step1-0", "step1-1", "step1-2", "step2"]);
            expect(counter).toBe(3);
        });

        test("next() throws error for unknown step", async () => {
            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async () => {
                    return next("nonexistent_step");
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1],
            });

            const result = await workflow.run({}, mockDesktop);

            expect(result.status).toBe("execution_error");
            expect(result.error?.message).toContain("nonexistent_step");
            expect(result.error?.message).toContain("not found");
        });

        test("next() conditional jump based on state", async () => {
            const executionOrder: string[] = [];

            const step1 = createStep({
                id: "check",
                name: "Check condition",
                execute: async ({ context }) => {
                    executionOrder.push("check");
                    const shouldSkip = true; // simulate condition
                    if (shouldSkip) {
                        context.state.skipped = true;
                        return next("final");
                    }
                    return { state: { skipped: false } };
                },
            });

            const step2 = createStep({
                id: "process",
                name: "Process - should be skipped",
                execute: async (): Promise<StepResult> => {
                    executionOrder.push("process");
                    return { state: { processed: true } };
                },
            });

            const step3 = createStep({
                id: "final",
                name: "Final step",
                execute: async (): Promise<StepResult> => {
                    executionOrder.push("final");
                    return { state: { finalized: true } };
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1, step2, step3],
            });

            const result = await workflow.run({}, mockDesktop);

            expect(result.status).toBe("executed_without_error");
            expect(executionOrder).toEqual(["check", "final"]);
        });
    });

    describe("retry() return-based", () => {
        test("re-executes step when retry() is returned", async () => {
            const executionOrder: string[] = [];
            let attempts = 0;

            const step1 = createStep({
                id: "step1",
                name: "Step 1 - retry twice",
                execute: async (): Promise<StepResult | ReturnType<typeof retry>> => {
                    attempts++;
                    executionOrder.push(`step1-attempt-${attempts}`);
                    if (attempts < 3) {
                        return retry();
                    }
                    return { state: { attempts } };
                },
            });

            const step2 = createStep({
                id: "step2",
                name: "Step 2",
                execute: async (): Promise<StepResult> => {
                    executionOrder.push("step2");
                    return { state: { done: true } };
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1, step2],
            });

            const result = await workflow.run({}, mockDesktop);

            expect(result.status).toBe("executed_without_error");
            expect(attempts).toBe(3);
            expect(executionOrder).toEqual([
                "step1-attempt-1",
                "step1-attempt-2",
                "step1-attempt-3",
                "step2",
            ]);
        });

        test("retry() works with conditional logic", async () => {
            let counter = 0;
            const executionOrder: string[] = [];

            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async () => {
                    counter++;
                    executionOrder.push(`attempt-${counter}`);

                    // Simulate finding element on 3rd attempt
                    const elementFound = counter >= 3;
                    if (!elementFound) {
                        return retry();
                    }
                    return { state: { found: true } };
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1],
            });

            const result = await workflow.run({}, mockDesktop);

            expect(result.status).toBe("executed_without_error");
            expect(counter).toBe(3);
            expect(executionOrder).toEqual(["attempt-1", "attempt-2", "attempt-3"]);
        });
    });

    describe("next() and retry() combined", () => {
        test("retry then next pattern", async () => {
            const executionOrder: string[] = [];
            let retryCount = 0;

            const step1 = createStep({
                id: "step1",
                name: "Step 1 - retry then jump",
                execute: async () => {
                    retryCount++;
                    executionOrder.push(`step1-${retryCount}`);

                    if (retryCount < 2) {
                        return retry();
                    }
                    // After retries, jump to step3
                    return next("step3");
                },
            });

            const step2 = createStep({
                id: "step2",
                name: "Step 2 - skipped",
                execute: async (): Promise<StepResult> => {
                    executionOrder.push("step2");
                    return { state: {} };
                },
            });

            const step3 = createStep({
                id: "step3",
                name: "Step 3 - target",
                execute: async (): Promise<StepResult> => {
                    executionOrder.push("step3");
                    return { state: {} };
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1, step2, step3],
            });

            const result = await workflow.run({}, mockDesktop);

            expect(result.status).toBe("executed_without_error");
            expect(executionOrder).toEqual(["step1-1", "step1-2", "step3"]);
        });
    });
});
