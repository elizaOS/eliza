/**
 * Unit tests for context.setState() functionality
 */

import { createWorkflow, createStep, z } from "../index";
import type { StepResult } from "../types";

// Mock Desktop for unit tests
const mockDesktop = {
    locator: jest.fn(),
    openApplication: jest.fn(),
    delay: jest.fn(),
} as any;

describe("setState Tests", () => {
    describe("setState in workflow steps", () => {
        test("setState updates are visible in subsequent steps", async () => {
            const capturedStates: any[] = [];

            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async ({ context }) => {
                    context.setState({ userId: "user123" });
                    capturedStates.push({ ...context.state });
                },
            });

            const step2 = createStep({
                id: "step2",
                name: "Step 2",
                execute: async ({ context }) => {
                    capturedStates.push({ ...context.state });
                    context.setState({ userName: "John" });
                },
            });

            const step3 = createStep({
                id: "step3",
                name: "Step 3",
                execute: async ({ context }) => {
                    capturedStates.push({ ...context.state });
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1, step2, step3],
            });

            await workflow.run({}, mockDesktop);

            expect(capturedStates[0]).toEqual({ userId: "user123" });
            expect(capturedStates[1]).toEqual({ userId: "user123" });
            expect(capturedStates[2]).toEqual({ userId: "user123", userName: "John" });
        });

        test("setState with functional update works correctly", async () => {
            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async ({ context }) => {
                    context.setState({ count: 0 });
                },
            });

            const step2 = createStep({
                id: "step2",
                name: "Step 2",
                execute: async ({ context }) => {
                    context.setState((prev: any) => ({ count: prev.count + 1 }));
                    context.setState((prev: any) => ({ count: prev.count + 1 }));
                    context.setState((prev: any) => ({ count: prev.count + 1 }));
                },
            });

            let finalState: any;
            const step3 = createStep({
                id: "step3",
                name: "Step 3",
                execute: async ({ context }) => {
                    finalState = { ...context.state };
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1, step2, step3],
            });

            await workflow.run({}, mockDesktop);

            expect(finalState.count).toBe(3);
        });

        test("setState and return { state } both work and accumulate", async () => {
            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async ({ context }): Promise<StepResult> => {
                    // Use setState
                    context.setState({ fromSetState: "value1" });
                    // Also return state (both should work)
                    return { state: { fromReturn: "value2" } };
                },
            });

            let finalState: any;
            const step2 = createStep({
                id: "step2",
                name: "Step 2",
                execute: async ({ context }) => {
                    finalState = { ...context.state };
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1, step2],
            });

            await workflow.run({}, mockDesktop);

            // Both setState and return { state } should be in final state
            expect(finalState).toEqual({
                fromSetState: "value1",
                fromReturn: "value2",
            });
        });

        test("setState is accessible in onSuccess handler", async () => {
            let stateInOnSuccess: any;

            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async ({ context }) => {
                    context.setState({ processedCount: 42 });
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1],
                onSuccess: async ({ context }) => {
                    stateInOnSuccess = { ...context.state };
                    return { message: "Done" };
                },
            });

            await workflow.run({}, mockDesktop);

            expect(stateInOnSuccess).toEqual({ processedCount: 42 });
        });
    });
});
