/**
 * Unit tests for workflow success() early exit functionality
 */

import { createWorkflow, createStep, z, success } from "../index";
import type { StepResult } from "../types";

// Mock Desktop for unit tests
const mockDesktop = {
    locator: jest.fn(),
    openApplication: jest.fn(),
    delay: jest.fn(),
} as any;

describe("Workflow Success Tests", () => {
    describe("success() early exit", () => {
        test("exits workflow early with success when success() is returned", async () => {
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
                name: "Step 2 - exits early",
                execute: async () => {
                    executionOrder.push("step2");
                    return success({
                        message: "No files to process",
                        data: { filesChecked: 0 },
                    });
                },
            });

            const step3 = createStep({
                id: "step3",
                name: "Step 3 - should not run",
                execute: async (): Promise<StepResult> => {
                    executionOrder.push("step3");
                    return { state: { step3: true } };
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1, step2, step3],
            });

            const result = await workflow.run({}, mockDesktop);

            expect(result.status).toBe("executed_without_error");
            expect(result.message).toBe("No files to process");
            expect(result.data).toEqual({
                message: "No files to process",
                data: { filesChecked: 0 },
            });
            expect(executionOrder).toEqual(["step1", "step2"]);
            // step3 should NOT have run
            expect(executionOrder).not.toContain("step3");
        });

        test("success() bypasses onSuccess handler", async () => {
            let onSuccessCalled = false;

            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async () => {
                    return success({
                        message: "Early exit",
                        success: true,
                    });
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1],
                onSuccess: async () => {
                    onSuccessCalled = true;
                    return { message: "onSuccess ran" };
                },
            });

            const result = await workflow.run({}, mockDesktop);

            expect(result.status).toBe("executed_without_error");
            expect(result.message).toBe("Early exit");
            expect(onSuccessCalled).toBe(false);
        });

        test("success() with custom data fields", async () => {
            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async () => {
                    return success({
                        message: "Custom completion",
                        summary: "# Summary\nNo work needed",
                        data: {
                            outlet: "TEST",
                            date: "2025-01-01",
                        },
                        customField: "customValue",
                    });
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1],
            });

            const result = await workflow.run({}, mockDesktop);

            expect(result.status).toBe("executed_without_error");
            expect(result.data.summary).toBe("# Summary\nNo work needed");
            expect(result.data.data.outlet).toBe("TEST");
            expect(result.data.customField).toBe("customValue");
        });

        test("success() sets correct lastStepId and lastStepIndex", async () => {
            const step1 = createStep({
                id: "first_step",
                name: "First Step",
                execute: async (): Promise<StepResult> => {
                    return { state: {} };
                },
            });

            const step2 = createStep({
                id: "second_step",
                name: "Second Step",
                execute: async () => {
                    return success({ message: "Done early" });
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1, step2],
            });

            const result = await workflow.run({}, mockDesktop);

            expect(result.status).toBe("executed_without_error");
            expect(result.lastStepId).toBe("second_step");
            expect(result.lastStepIndex).toBe(1);
        });
    });
});
