/**
 * Pins child-trajectory lifecycle ownership when a logger cannot allocate a
 * native child step. Deterministic logger doubles exercise success and error
 * finalization without a model or database.
 */
import { describe, expect, it, vi } from "vitest";
import {
	getTrajectoryContext,
	runWithTrajectoryContext,
} from "./trajectory-context";
import { withActionStep } from "./trajectory-utils";
import type { IAgentRuntime } from "./types/runtime";

function makeRuntime(trajectoryLogger: object): IAgentRuntime {
	return {
		agentId: "agent-1",
		getService: vi.fn((serviceType: string) =>
			serviceType === "trajectories" ? trajectoryLogger : undefined,
		),
		getServicesByType: vi.fn(() => []),
		reportError: vi.fn(),
	} as unknown as IAgentRuntime;
}

describe("withActionStep generated child lifecycle", () => {
	it("completes a generated child after a successful callback", async () => {
		const trajectoryLogger = {
			isEnabled: vi.fn(() => true),
			startStep: vi.fn((trajectoryId: string) => trajectoryId),
			flushWriteQueue: vi.fn(async () => {}),
			endTrajectory: vi.fn(async () => {}),
			annotateStep: vi.fn(async () => {}),
		};
		const runtime = makeRuntime(trajectoryLogger);
		let childStepId = "";

		const result = await runWithTrajectoryContext(
			{
				trajectoryId: "trajectory-1",
				trajectoryStepId: "parent-step-1",
			},
			() =>
				withActionStep(runtime, "REWRITE_VOICE", () => {
					childStepId = getTrajectoryContext()?.trajectoryStepId ?? "";
					return "rewritten";
				}),
		);

		expect(result).toBe("rewritten");
		expect(childStepId).toMatch(/^action-/);
		expect(childStepId).not.toBe("parent-step-1");
		expect(trajectoryLogger.flushWriteQueue).toHaveBeenCalledWith(childStepId);
		expect(trajectoryLogger.endTrajectory).toHaveBeenCalledWith(
			childStepId,
			"completed",
		);
		expect(trajectoryLogger.endTrajectory).not.toHaveBeenCalledWith(
			"trajectory-1",
			expect.anything(),
		);
		expect(trajectoryLogger.annotateStep).toHaveBeenCalledWith({
			stepId: "parent-step-1",
			appendChildSteps: [childStepId],
		});
	});

	it("marks a generated child as errored without replacing the callback error", async () => {
		const trajectoryLogger = {
			isEnabled: vi.fn(() => true),
			startStep: vi.fn((trajectoryId: string) => trajectoryId),
			flushWriteQueue: vi.fn(async () => {}),
			endTrajectory: vi.fn(async () => {}),
			annotateStep: vi.fn(async () => {}),
		};
		const runtime = makeRuntime(trajectoryLogger);
		let childStepId = "";

		await expect(
			runWithTrajectoryContext(
				{
					trajectoryId: "trajectory-1",
					trajectoryStepId: "parent-step-1",
				},
				() =>
					withActionStep(runtime, "REWRITE_VOICE", () => {
						childStepId = getTrajectoryContext()?.trajectoryStepId ?? "";
						throw new Error("rewrite failed");
					}),
			),
		).rejects.toThrow("rewrite failed");

		expect(childStepId).toMatch(/^action-/);
		expect(trajectoryLogger.endTrajectory).toHaveBeenCalledWith(
			childStepId,
			"error",
		);
		expect(trajectoryLogger.annotateStep).toHaveBeenCalledWith({
			stepId: "parent-step-1",
			appendChildSteps: [childStepId],
		});
		expect(runtime.reportError).not.toHaveBeenCalled();
	});

	it("reports logger lifecycle failures without replacing the host result", async () => {
		const trajectoryLogger = {
			isEnabled: vi.fn(() => true),
			startStep: vi.fn(() => {
				throw new Error("start failed");
			}),
			flushWriteQueue: vi
				.fn()
				.mockRejectedValueOnce(new Error("child flush failed"))
				.mockRejectedValueOnce(new Error("parent flush failed")),
			endTrajectory: vi.fn(async () => {}),
			annotateStep: vi.fn(async () => {
				throw new Error("annotation failed");
			}),
		};
		const runtime = makeRuntime(trajectoryLogger);

		const result = await runWithTrajectoryContext(
			{
				trajectoryId: "trajectory-1",
				trajectoryStepId: "parent-step-1",
			},
			() => withActionStep(runtime, "REWRITE_VOICE", () => "rewritten"),
		);

		expect(result).toBe("rewritten");
		expect(runtime.reportError).toHaveBeenCalledTimes(4);
		expect(runtime.reportError).toHaveBeenNthCalledWith(
			1,
			"withChildTrajectoryStep.startChild",
			expect.any(Error),
			expect.objectContaining({
				trajectoryId: "trajectory-1",
				parentStepId: "parent-step-1",
			}),
		);
		expect(runtime.reportError).toHaveBeenNthCalledWith(
			4,
			"withChildTrajectoryStep.annotateParent",
			expect.any(Error),
			expect.objectContaining({ parentStepId: "parent-step-1" }),
		);
	});
});
