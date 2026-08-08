/**
 * Verifies trajectory instrumentation failures remain observable diagnostics
 * without entering conversational RECENT_ERRORS output.
 */

import { describe, expect, it, vi } from "vitest";
import type { ReportedError } from "./errors";
import { recentErrorsProvider } from "./providers/recent-errors";
import { drainPostDeliveryTasks } from "./services/post-delivery-task-tracker";
import { runWithTrajectoryContext } from "./trajectory-context";
import {
	logActiveTrajectoryLlmCall,
	spawnWithTrajectoryLink,
	withActionStep,
} from "./trajectory-utils";
import type { ActionResult, IAgentRuntime, Memory, State } from "./types";

describe("trajectory diagnostic classification", () => {
	it("preserves a successful action when settlement normalization throws", async () => {
		const invalidDate = new Date(Number.NaN);
		const result = {
			success: true,
			data: { completedAt: invalidDate },
		};
		const trajectoryLogger = {
			isEnabled: () => true,
			startStep: vi.fn(() => "action-step"),
			completeStep: vi.fn(),
			flushWriteQueue: vi.fn(async () => {}),
			annotateStep: vi.fn(async () => {}),
		};
		const reportError = vi.fn();
		const runtime = {
			agentId: "agent-normalization",
			getService: vi.fn(() => trajectoryLogger),
			getServicesByType: vi.fn(() => [trajectoryLogger]),
			reportError,
		} as unknown as IAgentRuntime;

		await expect(
			runWithTrajectoryContext(
				{
					trajectoryId: "trajectory-1",
					trajectoryStepId: "parent-step",
				},
				() => withActionStep(runtime, "TEST_ACTION", async () => result),
			),
		).resolves.toBe(result);
		expect(trajectoryLogger.completeStep).not.toHaveBeenCalled();
		expect(reportError).toHaveBeenCalledWith(
			"TrajectoryActionStep.normalize",
			expect.any(RangeError),
			expect.objectContaining({ diagnosticOnly: true }),
		);
	});

	it("marks child, normalization, completion, and linkage failures diagnostic-only", async () => {
		const startError = new Error("start child failed");
		const completeError = new Error("complete child failed");
		const linkError = new Error("link child failed");
		let failStart = true;
		let failComplete = true;
		let failLink = false;
		const trajectoryLogger = {
			isEnabled: () => true,
			startStep: vi.fn(() => {
				if (failStart) throw startError;
				return "action-step";
			}),
			completeStep: vi.fn(() => {
				if (failComplete) throw completeError;
			}),
			flushWriteQueue: vi.fn(async () => {}),
			annotateStep: vi.fn(async () => {
				if (failLink) throw linkError;
			}),
		};
		const reportError = vi.fn();
		const runtime = {
			agentId: "agent-diagnostics",
			getService: vi.fn(() => trajectoryLogger),
			getServicesByType: vi.fn(() => [trajectoryLogger]),
			reportError,
		} as unknown as IAgentRuntime;
		const context = {
			trajectoryId: "trajectory-1",
			trajectoryStepId: "parent-step",
		};

		await runWithTrajectoryContext(context, () =>
			withActionStep(runtime, "TEST_ACTION", async () => ({ success: true })),
		);
		await drainPostDeliveryTasks(runtime);

		failStart = false;
		await runWithTrajectoryContext(context, () =>
			withActionStep(runtime, "TEST_ACTION", async () => ({ success: true })),
		);
		await drainPostDeliveryTasks(runtime);

		failComplete = false;
		await runWithTrajectoryContext(context, () =>
			withActionStep(runtime, "TEST_ACTION", async () => ({ success: true }), {
				projectResult: () => [] as unknown as ActionResult,
			}),
		);
		await drainPostDeliveryTasks(runtime);

		failLink = true;
		await runWithTrajectoryContext(context, () =>
			spawnWithTrajectoryLink(runtime, undefined, async (handle) => {
				expect(await handle.linkChild("spawned-child")).toBe(false);
			}),
		);

		const expectedScopes = [
			"TrajectoryChildStep.start",
			"TrajectoryActionStep.complete",
			"TrajectoryActionStep.normalize",
			"Trajectory.linkChild",
		];
		const diagnosticCalls = reportError.mock.calls.filter(([scope]) =>
			expectedScopes.includes(String(scope)),
		);
		expect(diagnosticCalls.map(([scope]) => scope)).toEqual(expectedScopes);
		expect(
			diagnosticCalls.every(([, , errorContext]) =>
				Boolean(
					errorContext &&
						typeof errorContext === "object" &&
						(errorContext as Record<string, unknown>).diagnosticOnly === true,
				),
			),
		).toBe(true);

		const reportedErrors: ReportedError[] = diagnosticCalls.map(
			([scope, error, errorContext], index) => ({
				scope: String(scope),
				code: "TRAJECTORY_DIAGNOSTIC_FAILURE",
				message: error instanceof Error ? error.message : String(error),
				context: errorContext as Record<string, unknown>,
				at: Date.now() + index,
			}),
		);
		const recentResult = await recentErrorsProvider.get(
			{
				getRecentReportedErrors: () => reportedErrors,
			} as unknown as IAgentRuntime,
			{} as Memory,
			{} as State,
		);
		expect(recentResult.text).toBe("");
		expect(recentResult.data?.recentErrors).toEqual([]);
	});

	it.each([
		"throw",
		"empty",
		"parent",
		"trajectory",
		"missing-trajectory",
	] as const)(
		"keeps nested capture on the parent when child ownership is %s",
		async (variant) => {
			const startError = new Error("start child failed");
			const trajectoryLogger = {
				isEnabled: () => true,
				startStep: vi.fn(() => {
					if (variant === "throw") throw startError;
					if (variant === "empty") return "";
					if (variant === "trajectory") return "trajectory-1";
					return "parent-step";
				}),
				completeStep: vi.fn(),
				flushWriteQueue: vi.fn(async () => {}),
				annotateStep: vi.fn(async () => {}),
				logLlmCall: vi.fn(),
			};
			const reportError = vi.fn();
			const runtime = {
				agentId: "agent-parent-fallback",
				getService: vi.fn(() => trajectoryLogger),
				getServicesByType: vi.fn(() => [trajectoryLogger]),
				reportError,
			} as unknown as IAgentRuntime;
			const context = {
				...(variant === "missing-trajectory"
					? {}
					: { trajectoryId: "trajectory-1" }),
				trajectoryStepId: "parent-step",
			};

			const result = await runWithTrajectoryContext(context, () =>
				withActionStep(runtime, "TEST_ACTION", async () => {
					expect(
						logActiveTrajectoryLlmCall(runtime, {
							model: "test-model",
							systemPrompt: "system",
							userPrompt: "user",
							response: "response",
							purpose: "action",
						}),
					).toBe(true);
					return { success: true, data: { preserved: true } };
				}),
			);
			await drainPostDeliveryTasks(runtime);

			expect(result).toEqual({ success: true, data: { preserved: true } });
			expect(trajectoryLogger.logLlmCall).toHaveBeenCalledWith(
				expect.objectContaining({ stepId: "parent-step" }),
			);
			expect(trajectoryLogger.completeStep).not.toHaveBeenCalled();
			expect(trajectoryLogger.annotateStep).not.toHaveBeenCalled();
			if (variant === "missing-trajectory") {
				expect(trajectoryLogger.startStep).not.toHaveBeenCalled();
			} else {
				expect(trajectoryLogger.startStep).toHaveBeenCalledOnce();
			}
			if (variant === "throw") {
				expect(reportError).toHaveBeenCalledWith(
					"TrajectoryChildStep.start",
					startError,
					expect.objectContaining({ diagnosticOnly: true }),
				);
			} else {
				expect(reportError).not.toHaveBeenCalledWith(
					"TrajectoryChildStep.start",
					expect.anything(),
					expect.anything(),
				);
			}
		},
	);

	it("reports child flush rejection without leaking into generic post-delivery errors", async () => {
		const finalizationError = new Error("flush failed");
		const trajectoryLogger = {
			isEnabled: () => true,
			startStep: vi.fn(() => "registered-child"),
			completeStep: vi.fn(),
			flushWriteQueue: vi.fn(async () => {
				throw finalizationError;
			}),
		};
		const reportError = vi.fn();
		const runtime = {
			agentId: "agent-finalization",
			getService: vi.fn(() => trajectoryLogger),
			getServicesByType: vi.fn(() => [trajectoryLogger]),
			reportError,
		} as unknown as IAgentRuntime;

		await expect(
			runWithTrajectoryContext(
				{
					trajectoryId: "trajectory-1",
					trajectoryStepId: "parent-step",
				},
				() =>
					withActionStep(runtime, "TEST_ACTION", async () => ({
						success: true,
					})),
			),
		).resolves.toEqual({ success: true });
		await drainPostDeliveryTasks(runtime);

		expect(reportError).toHaveBeenCalledWith(
			"TrajectoryChildStep.finalize",
			finalizationError,
			{
				trajectoryId: "trajectory-1",
				parentStepId: "parent-step",
				childStepId: "registered-child",
				purpose: "action",
				diagnosticOnly: true,
			},
		);
		expect(
			reportError.mock.calls.some(([scope]) => scope === "PostDeliveryTask"),
		).toBe(false);
	});
});
