/**
 * Unit tests for workflow branching/next pointer functionality
 */

import { createWorkflow, createStep, z } from "../index";

// Mock Desktop for unit tests
const mockDesktop = {
    locator: jest.fn(),
    openApplication: jest.fn(),
    delay: jest.fn(),
} as any;

describe("Workflow Branching Tests", () => {
    describe("Static next pointer", () => {
        test("jumps to specified step by ID", async () => {
            const executionOrder: string[] = [];

            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async () => {
                    executionOrder.push("step1");
                    return { state: { step1: true } };
                },
                next: "step3", // Skip step2
            });

            const step2 = createStep({
                id: "step2",
                name: "Step 2",
                execute: async () => {
                    executionOrder.push("step2");
                    return { state: { step2: true } };
                },
            });

            const step3 = createStep({
                id: "step3",
                name: "Step 3",
                execute: async () => {
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
            expect(executionOrder).toEqual(["step1", "step3"]);
        });

        test("throws error for unknown next step ID", async () => {
            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async () => {
                    return { state: {} };
                },
                next: "nonexistent_step",
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1],
            });

            const result = await workflow.run({}, mockDesktop);

            expect(result.status).toBe("execution_error");
            expect(result.message).toContain(
                "references unknown next step: 'nonexistent_step'",
            );
        });
    });

    describe("Dynamic next pointer (function)", () => {
        test("conditionally branches based on state", async () => {
            const executionOrder: string[] = [];

            const checkStep = createStep({
                id: "check",
                name: "Check Condition",
                execute: async () => {
                    executionOrder.push("check");
                    return { state: { isDuplicate: true } };
                },
                next: ({ context }) =>
                    context.state.isDuplicate ? "handle_dupe" : "process",
            });

            const handleDupe = createStep({
                id: "handle_dupe",
                name: "Handle Duplicate",
                execute: async () => {
                    executionOrder.push("handle_dupe");
                    return { state: { handled: true } };
                },
                next: "done", // Skip to done, avoiding process
            });

            const process = createStep({
                id: "process",
                name: "Process Normal",
                execute: async () => {
                    executionOrder.push("process");
                    return { state: { processed: true } };
                },
                next: "done",
            });

            const done = createStep({
                id: "done",
                name: "Done",
                execute: async () => {
                    executionOrder.push("done");
                    return { state: { done: true } };
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [checkStep, handleDupe, process, done],
            });

            const result = await workflow.run({}, mockDesktop);

            expect(result.status).toBe("executed_without_error");
            expect(executionOrder).toEqual(["check", "handle_dupe", "done"]);
        });

        test("branches to different path when condition is false", async () => {
            const executionOrder: string[] = [];

            const checkStep = createStep({
                id: "check",
                name: "Check Condition",
                execute: async () => {
                    executionOrder.push("check");
                    return { state: { isDuplicate: false } };
                },
                next: ({ context }) =>
                    context.state.isDuplicate ? "handle_dupe" : "process",
            });

            const handleDupe = createStep({
                id: "handle_dupe",
                name: "Handle Duplicate",
                execute: async () => {
                    executionOrder.push("handle_dupe");
                    return { state: { handled: true } };
                },
                next: "done",
            });

            const process = createStep({
                id: "process",
                name: "Process Normal",
                execute: async () => {
                    executionOrder.push("process");
                    return { state: { processed: true } };
                },
                next: "done",
            });

            const done = createStep({
                id: "done",
                name: "Done",
                execute: async () => {
                    executionOrder.push("done");
                    return { state: { done: true } };
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [checkStep, handleDupe, process, done],
            });

            const result = await workflow.run({}, mockDesktop);

            expect(result.status).toBe("executed_without_error");
            expect(executionOrder).toEqual(["check", "process", "done"]);
        });

        test("continues sequentially when next function returns undefined", async () => {
            const executionOrder: string[] = [];

            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async () => {
                    executionOrder.push("step1");
                    return { state: { skip: false } };
                },
                next: ({ context }) =>
                    context.state.skip ? "step3" : undefined,
            });

            const step2 = createStep({
                id: "step2",
                name: "Step 2",
                execute: async () => {
                    executionOrder.push("step2");
                    return { state: {} };
                },
            });

            const step3 = createStep({
                id: "step3",
                name: "Step 3",
                execute: async () => {
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
            expect(executionOrder).toEqual(["step1", "step2", "step3"]);
        });
    });

    describe("Loops", () => {
        test("supports retry loop with counter", async () => {
            const executionOrder: string[] = [];
            let retryCount = 0;

            const attemptStep = createStep({
                id: "attempt",
                name: "Attempt Operation",
                execute: async () => {
                    retryCount++;
                    executionOrder.push(`attempt_${retryCount}`);
                    const success = retryCount >= 3;
                    return { state: { retries: retryCount, success } };
                },
                next: ({ context }) => {
                    if (context.state.success) return "complete";
                    if (context.state.retries < 3) return "attempt";
                    return "fail";
                },
            });

            const complete = createStep({
                id: "complete",
                name: "Complete",
                execute: async () => {
                    executionOrder.push("complete");
                    return { state: { completed: true } };
                },
                next: "end", // Skip fail step
            });

            const fail = createStep({
                id: "fail",
                name: "Fail",
                execute: async () => {
                    executionOrder.push("fail");
                    return { state: { failed: true } };
                },
                next: "end",
            });

            const end = createStep({
                id: "end",
                name: "End",
                execute: async () => {
                    executionOrder.push("end");
                    return { state: {} };
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [attemptStep, complete, fail, end],
            });

            const result = await workflow.run({}, mockDesktop);

            expect(result.status).toBe("executed_without_error");
            expect(executionOrder).toEqual([
                "attempt_1",
                "attempt_2",
                "attempt_3",
                "complete",
                "end",
            ]);
            expect(retryCount).toBe(3);
        });

        test("detects infinite loops and throws error", async () => {
            const step1 = createStep({
                id: "step1",
                name: "Infinite Loop Step",
                execute: async () => {
                    return { state: {} };
                },
                next: "step1", // Always loop back to itself
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1],
            });

            const result = await workflow.run({}, mockDesktop);

            expect(result.status).toBe("execution_error");
            expect(result.message).toContain("maximum iterations");
            expect(result.message).toContain("infinite loop");
        });
    });

    describe("Complex branching scenarios", () => {
        test("multiple branches converging", async () => {
            const executionOrder: string[] = [];

            const start = createStep({
                id: "start",
                name: "Start",
                execute: async () => {
                    executionOrder.push("start");
                    return { state: { path: "a" } };
                },
                next: ({ context }) =>
                    context.state.path === "a" ? "branch_a" : "branch_b",
            });

            const branchA = createStep({
                id: "branch_a",
                name: "Branch A",
                execute: async () => {
                    executionOrder.push("branch_a");
                    return { state: { fromA: true } };
                },
                next: "merge",
            });

            const branchB = createStep({
                id: "branch_b",
                name: "Branch B",
                execute: async () => {
                    executionOrder.push("branch_b");
                    return { state: { fromB: true } };
                },
                next: "merge",
            });

            const merge = createStep({
                id: "merge",
                name: "Merge",
                execute: async ({ context }) => {
                    executionOrder.push("merge");
                    return {
                        state: {
                            merged: true,
                            source: context.state.fromA ? "A" : "B",
                        },
                    };
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [start, branchA, branchB, merge],
            });

            const result = await workflow.run({}, mockDesktop);

            expect(result.status).toBe("executed_without_error");
            expect(executionOrder).toEqual(["start", "branch_a", "merge"]);
        });

        test("early exit from workflow", async () => {
            const executionOrder: string[] = [];

            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async () => {
                    executionOrder.push("step1");
                    return { state: { shouldExit: true } };
                },
                next: ({ context }) =>
                    context.state.shouldExit ? "exit" : "step2",
            });

            const step2 = createStep({
                id: "step2",
                name: "Step 2",
                execute: async () => {
                    executionOrder.push("step2");
                    return { state: {} };
                },
            });

            // Exit is the last step, so workflow ends after it
            const exit = createStep({
                id: "exit",
                name: "Exit",
                execute: async () => {
                    executionOrder.push("exit");
                    return { state: { exited: true } };
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1, step2, exit],
            });

            const result = await workflow.run({}, mockDesktop);

            expect(result.status).toBe("executed_without_error");
            expect(executionOrder).toEqual(["step1", "exit"]);
        });

        test("branching based on input", async () => {
            const executionOrder: string[] = [];

            const router = createStep<{ env: string }>({
                id: "router",
                name: "Route by Environment",
                execute: async () => {
                    executionOrder.push("router");
                    return { state: {} };
                },
                next: ({ input }) =>
                    input.env === "prod" ? "prod_flow" : "test_flow",
            });

            const prodFlow = createStep<{ env: string }>({
                id: "prod_flow",
                name: "Production Flow",
                execute: async () => {
                    executionOrder.push("prod_flow");
                    return { state: { env: "prod" } };
                },
                next: "finish",
            });

            const testFlow = createStep<{ env: string }>({
                id: "test_flow",
                name: "Test Flow",
                execute: async () => {
                    executionOrder.push("test_flow");
                    return { state: { env: "test" } };
                },
                next: "finish",
            });

            const finish = createStep<{ env: string }>({
                id: "finish",
                name: "Finish",
                execute: async () => {
                    executionOrder.push("finish");
                    return { state: {} };
                },
            });

            const workflow = createWorkflow({
                input: z.object({ env: z.string() }),
                steps: [router, prodFlow, testFlow, finish],
            });

            // Test with prod
            const prodResult = await workflow.run({ env: "prod" }, mockDesktop);
            expect(prodResult.status).toBe("executed_without_error");
            expect(executionOrder).toEqual(["router", "prod_flow", "finish"]);

            // Reset and test with test env
            executionOrder.length = 0;
            const testResult = await workflow.run({ env: "test" }, mockDesktop);
            expect(testResult.status).toBe("executed_without_error");
            expect(executionOrder).toEqual(["router", "test_flow", "finish"]);
        });
    });

    describe("Backward compatibility", () => {
        test("workflows without next continue to work sequentially", async () => {
            const executionOrder: string[] = [];

            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async () => {
                    executionOrder.push("step1");
                    return { state: { a: 1 } };
                },
            });

            const step2 = createStep({
                id: "step2",
                name: "Step 2",
                execute: async () => {
                    executionOrder.push("step2");
                    return { state: { b: 2 } };
                },
            });

            const step3 = createStep({
                id: "step3",
                name: "Step 3",
                execute: async () => {
                    executionOrder.push("step3");
                    return { state: { c: 3 } };
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1, step2, step3],
            });

            const result = await workflow.run({}, mockDesktop);

            expect(result.status).toBe("executed_without_error");
            expect(executionOrder).toEqual(["step1", "step2", "step3"]);
        });

        test("condition and next work together", async () => {
            const executionOrder: string[] = [];

            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async () => {
                    executionOrder.push("step1");
                    return { state: { skip: true } };
                },
            });

            const skippable = createStep({
                id: "skippable",
                name: "Skippable Step",
                execute: async () => {
                    executionOrder.push("skippable");
                    return { state: {} };
                },
                condition: ({ context }) => !context.state.skip,
            });

            const step3 = createStep({
                id: "step3",
                name: "Step 3",
                execute: async () => {
                    executionOrder.push("step3");
                    return { state: {} };
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1, skippable, step3],
            });

            const result = await workflow.run({}, mockDesktop);

            expect(result.status).toBe("executed_without_error");
            expect(executionOrder).toEqual(["step1", "step3"]);
        });
    });

    describe("State tracking with branching", () => {
        test("lastStepId reflects actual execution path", async () => {
            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async () => ({ state: {} }),
                next: "step3",
            });

            const step2 = createStep({
                id: "step2",
                name: "Step 2 (skipped)",
                execute: async () => ({ state: {} }),
            });

            const step3 = createStep({
                id: "step3",
                name: "Step 3",
                execute: async () => ({ state: {} }),
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1, step2, step3],
            });

            const result = await workflow.run({}, mockDesktop);

            expect(result.status).toBe("executed_without_error");
            expect(result.lastStepId).toBe("step3");
        });
    });
});
