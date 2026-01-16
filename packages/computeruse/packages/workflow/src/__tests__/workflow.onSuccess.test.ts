/**
 * Tests for onSuccess handler in Workflow SDK
 * Tests both direct pattern (steps array) and builder pattern
 */

import { Desktop } from "@mediar-ai/computeruse";
import { createWorkflow, createStep, z } from "../index";
import type { WorkflowErrorContext } from "../types";

// Mock Desktop to avoid needing real automation
jest.mock("@mediar-ai/computeruse", () => ({
    Desktop: jest.fn().mockImplementation(() => ({
        locator: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({}),
        click: jest.fn().mockResolvedValue(undefined),
        delay: jest.fn().mockResolvedValue(undefined),
    })),
}));

describe("Workflow onSuccess Handler", () => {
    let desktop: Desktop;

    beforeEach(() => {
        desktop = new Desktop();
    });

    describe("Direct Pattern (steps array)", () => {
        test("onSuccess is called after all steps complete", async () => {
            const onSuccessMock = jest.fn().mockReturnValue({
                summary: "# Success",
                success: true,
            });

            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async () => ({ state: { value1: "hello" } }),
            });

            const step2 = createStep({
                id: "step2",
                name: "Step 2",
                execute: async () => ({ state: { value2: "world" } }),
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1, step2],
                onSuccess: onSuccessMock,
            });

            const result = await workflow.run({}, desktop);

            expect(result.status).toBe("executed_without_error");
            expect(onSuccessMock).toHaveBeenCalledTimes(1);
        });

        test("onSuccess receives full context with accumulated state", async () => {
            let capturedContext: any = null;

            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async () => ({
                    state: { userId: "123", userName: "John" },
                }),
            });

            const step2 = createStep({
                id: "step2",
                name: "Step 2",
                execute: async () => ({ state: { processedCount: 42 } }),
            });

            const workflow = createWorkflow({
                input: z.object({ sourceFile: z.string() }),
                steps: [step1, step2],
                onSuccess: async ({ context, input }) => {
                    capturedContext = { context, input };
                    return { success: true };
                },
            });

            await workflow.run({ sourceFile: "test.csv" }, desktop);

            expect(capturedContext).not.toBeNull();
            expect(capturedContext.context.state.userId).toBe("123");
            expect(capturedContext.context.state.userName).toBe("John");
            expect(capturedContext.context.state.processedCount).toBe(42);
            expect(capturedContext.input.sourceFile).toBe("test.csv");
        });

        test("onSuccess receives lastStepId and lastStepIndex", async () => {
            let capturedLastStep: { id?: string; index?: number } = {};

            const step1 = createStep({
                id: "first_step",
                name: "First Step",
                execute: async () => ({ state: { done1: true } }),
            });

            const step2 = createStep({
                id: "second_step",
                name: "Second Step",
                execute: async () => ({ state: { done2: true } }),
            });

            const step3 = createStep({
                id: "final_step",
                name: "Final Step",
                execute: async () => ({ state: { done3: true } }),
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1, step2, step3],
                onSuccess: async ({ lastStepId, lastStepIndex }) => {
                    capturedLastStep = { id: lastStepId, index: lastStepIndex };
                    return { success: true };
                },
            });

            await workflow.run({}, desktop);

            expect(capturedLastStep.id).toBe("final_step");
            expect(capturedLastStep.index).toBe(2);
        });

        test("onSuccess return value becomes context.data (workflow output)", async () => {
            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async () => ({ state: { file_name: "report.xlsx" } }),
            });

            const step2 = createStep({
                id: "step2",
                name: "Step 2",
                execute: async () => ({
                    state: { outlet_code: "ABC123", date: "2024-01-15" },
                }),
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1, step2],
                onSuccess: async ({ context }) => {
                    const { file_name, outlet_code, date } = context.state;
                    return {
                        summary: `# Report Generated\n- File: ${file_name}\n- Outlet: ${outlet_code}\n- Date: ${date}`,
                        success: true,
                        data: { file_name, outlet_code, date },
                    };
                },
            });

            const result = await workflow.run({}, desktop);

            expect(result.status).toBe("executed_without_error");
            expect(result.data).toEqual({
                summary: "# Report Generated\n- File: report.xlsx\n- Outlet: ABC123\n- Date: 2024-01-15",
                success: true,
                data: {
                    file_name: "report.xlsx",
                    outlet_code: "ABC123",
                    date: "2024-01-15",
                },
            });
        });

        test("onSuccess receives logger", async () => {
            const loggedMessages: string[] = [];

            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async () => ({ state: { done: true } }),
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1],
                onSuccess: async ({ logger }) => {
                    logger.info("onSuccess handler called");
                    loggedMessages.push("logged");
                    return { success: true };
                },
            });

            await workflow.run({}, desktop);

            expect(loggedMessages).toContain("logged");
        });

        test("onSuccess receives duration", async () => {
            let capturedDuration: number | undefined;

            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async () => {
                    await new Promise((r) => setTimeout(r, 50));
                    return { state: { done: true } };
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1],
                onSuccess: async ({ duration }) => {
                    capturedDuration = duration;
                    return { success: true };
                },
            });

            await workflow.run({}, desktop);

            expect(capturedDuration).toBeDefined();
            expect(capturedDuration).toBeGreaterThanOrEqual(50);
        });

        test("onSuccess is NOT called when step fails", async () => {
            const onSuccessMock = jest.fn();
            const onErrorMock = jest.fn();

            const failingStep = createStep({
                id: "failing",
                name: "Failing Step",
                execute: async (): Promise<{
                    state: Record<string, unknown>;
                }> => {
                    throw new Error("Step failed");
                },
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [failingStep],
                onSuccess: onSuccessMock,
                onError: async (ctx: WorkflowErrorContext) => {
                    onErrorMock(ctx.error.message);
                },
            });

            const result = await workflow.run({}, desktop);

            expect(result.status).toBe("execution_error");
            expect(onSuccessMock).not.toHaveBeenCalled();
            expect(onErrorMock).toHaveBeenCalledWith("Step failed");
        });

        test("onSuccess with async handler", async () => {
            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async () => ({ state: { value: 1 } }),
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1],
                onSuccess: async ({ context }) => {
                    // Simulate async operation
                    await new Promise((r) => setTimeout(r, 10));
                    return {
                        computed: (context.state.value as number) * 2,
                    };
                },
            });

            const result = await workflow.run({}, desktop);

            expect(result.status).toBe("executed_without_error");
            expect(result.data).toEqual({ computed: 2 });
        });

        test("onSuccess with sync handler (returns plain value)", async () => {
            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async () => ({ state: { value: 10 } }),
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1],
                onSuccess: ({ context }) => ({
                    // Sync return - no async
                    result: context.state.value,
                }),
            });

            const result = await workflow.run({}, desktop);

            expect(result.status).toBe("executed_without_error");
            expect(result.data).toEqual({ result: 10 });
        });

        test("onSuccess with undefined return preserves step data", async () => {
            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async () => ({ data: { fromStep: true } }),
            });

            const onSuccessCalled = jest.fn();

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1],
                onSuccess: async () => {
                    onSuccessCalled();
                    // Return undefined - should preserve existing context.data
                    return undefined;
                },
            });

            const result = await workflow.run({}, desktop);

            expect(result.status).toBe("executed_without_error");
            expect(onSuccessCalled).toHaveBeenCalled();
            // context.data should still have step data
            expect(result.data).toEqual({ step1: { fromStep: true } });
        });
    });

    describe("Builder Pattern", () => {
        test("builder onSuccess works same as direct pattern", async () => {
            let capturedState: any = null;

            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async () => ({ state: { accumulated: "data" } }),
            });

            const workflow = createWorkflow({
                input: z.object({}),
            })
                .step(step1)
                .onSuccess(({ context }) => {
                    capturedState = context.state;
                    return { summary: "Done!", success: true };
                })
                .build();

            const result = await workflow.run({}, desktop);

            expect(result.status).toBe("executed_without_error");
            expect(capturedState).toEqual({ accumulated: "data" });
            expect(result.data).toEqual({ summary: "Done!", success: true });
        });
    });

    describe("Conditional Steps with onSuccess", () => {
        test("onSuccess knows which step was last when steps are skipped", async () => {
            let lastExecutedStep: string | undefined;

            const step1 = createStep({
                id: "always_runs",
                name: "Always Runs",
                execute: async () => ({ state: { skipNext: true } }),
            });

            const step2 = createStep({
                id: "conditional_step",
                name: "Conditional Step",
                condition: ({ context }) => !context.state.skipNext,
                execute: async () => ({ state: { ran: true } }),
            });

            const step3 = createStep({
                id: "final_step",
                name: "Final Step",
                execute: async () => ({ state: { finalized: true } }),
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1, step2, step3],
                onSuccess: async ({ lastStepId, context }) => {
                    lastExecutedStep = lastStepId;
                    return {
                        lastStep: lastStepId,
                        state: context.state,
                    };
                },
            });

            const result = await workflow.run({}, desktop);

            expect(result.status).toBe("executed_without_error");
            expect(lastExecutedStep).toBe("final_step");
            // step2 was skipped, so skipNext should be true but ran should be undefined
            expect(result.data.state.skipNext).toBe(true);
            expect(result.data.state.ran).toBeUndefined();
            expect(result.data.state.finalized).toBe(true);
        });

        test("onSuccess handles early exit (all remaining steps skipped)", async () => {
            let capturedLastStepId: string | undefined;
            let capturedLastStepIndex: number | undefined;

            const step1 = createStep({
                id: "step1",
                name: "Step 1",
                execute: async () => ({ state: { earlyExit: true } }),
            });

            const step2 = createStep({
                id: "step2",
                name: "Step 2",
                condition: ({ context }) => !context.state.earlyExit,
                execute: async () => ({ state: { step2Done: true } }),
            });

            const step3 = createStep({
                id: "step3",
                name: "Step 3",
                condition: ({ context }) => !context.state.earlyExit,
                execute: async () => ({ state: { step3Done: true } }),
            });

            const workflow = createWorkflow({
                input: z.object({}),
                steps: [step1, step2, step3],
                onSuccess: async ({ lastStepId, lastStepIndex, context }) => {
                    capturedLastStepId = lastStepId;
                    capturedLastStepIndex = lastStepIndex;
                    return {
                        summary: `Workflow ended at step ${lastStepId}`,
                        earlyExit: context.state.earlyExit,
                    };
                },
            });

            const result = await workflow.run({}, desktop);

            expect(result.status).toBe("executed_without_error");
            // Last actually executed step was step1 (index 0)
            expect(capturedLastStepId).toBe("step1");
            expect(capturedLastStepIndex).toBe(0);
            expect(result.data.earlyExit).toBe(true);
        });
    });

    describe("Real-world Use Case: SAP Journal Entry", () => {
        test("onSuccess generates human-readable summary from accumulated state", async () => {
            const parseFile = createStep({
                id: "parse_file",
                name: "Parse Excel File",
                execute: async () => ({
                    state: {
                        file_name: "sales_2024_01.xlsx",
                        outlet_code: "SG-001",
                        date: "2024-01-15",
                        total_amount: 15420.5,
                    },
                }),
            });

            const loginSAP = createStep({
                id: "login_sap",
                name: "Login to SAP",
                execute: async () => ({
                    state: { sap_logged_in: true },
                }),
            });

            const postJournal = createStep({
                id: "post_journal",
                name: "Post Journal Entry",
                execute: async () => ({
                    state: {
                        journal_posted: true,
                        document_number: "SAP-2024-00123",
                    },
                }),
            });

            const workflow = createWorkflow({
                input: z.object({ file_path: z.string() }),
                steps: [parseFile, loginSAP, postJournal],
                onSuccess: async ({ context, input }) => {
                    const {
                        file_name,
                        outlet_code,
                        date,
                        total_amount,
                        journal_posted,
                        document_number,
                    } = context.state as {
                        file_name: string;
                        outlet_code: string;
                        date: string;
                        total_amount: number;
                        journal_posted: boolean;
                        document_number: string;
                    };

                    return {
                        summary: `# SAP Journal Entry - Success

| Field | Value |
|-------|-------|
| File | ${file_name} |
| Outlet | ${outlet_code} |
| Date | ${date} |
| Amount | $${total_amount.toLocaleString()} |
| Posted | ${journal_posted ? "Yes" : "No"} |
| Document # | ${document_number} |

Source: \`${input.file_path}\``,
                        success: true,
                        data: {
                            file_name,
                            outlet_code,
                            date,
                            total_amount,
                            document_number,
                        },
                    };
                },
            });

            const result = await workflow.run(
                { file_path: "/data/sales_2024_01.xlsx" },
                desktop,
            );

            expect(result.status).toBe("executed_without_error");
            expect(result.data.summary).toContain(
                "# SAP Journal Entry - Success",
            );
            expect(result.data.summary).toContain("SG-001");
            expect(result.data.summary).toContain("SAP-2024-00123");
            expect(result.data.success).toBe(true);
            expect(result.data.data.document_number).toBe("SAP-2024-00123");
        });
    });
});
