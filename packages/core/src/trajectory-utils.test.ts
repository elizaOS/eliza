/**
 * Pins child-trajectory lifecycle ownership when a logger cannot allocate a
 * native child step. A real AgentRuntime owns a deterministic trajectory
 * service double so success and error finalization exercise the production
 * service-resolution path without a model or database.
 */

import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "./runtime";
import {
	getTrajectoryContext,
	runWithTrajectoryContext,
} from "./trajectory-context";
import { withActionStep } from "./trajectory-utils";
import { Service, ServiceType } from "./types/service";

class TestTrajectoryLogger extends Service {
	static override serviceType = ServiceType.TRAJECTORIES;
	capabilityDescription =
		"Records deterministic child-trajectory lifecycle calls";
	readonly isEnabled = vi.fn(() => true);
	readonly startStep = vi.fn((trajectoryId: string) => trajectoryId);
	readonly flushWriteQueue = vi.fn(async (_trajectoryId: string) => {});
	readonly endTrajectory = vi.fn(
		async (_stepId: string, _status?: "completed" | "error") => {},
	);
	readonly annotateStep = vi.fn(
		async (_params: { stepId: string; appendChildSteps?: string[] }) => {},
	);

	async stop(): Promise<void> {}
}

async function makeRuntime(
	trajectoryLogger: TestTrajectoryLogger,
): Promise<AgentRuntime> {
	const runtime = new AgentRuntime({ logLevel: "fatal" });
	await runtime.enableTrajectories();
	runtime.services.set(ServiceType.TRAJECTORIES, [trajectoryLogger]);
	vi.spyOn(runtime, "reportError").mockImplementation(() => {});
	return runtime;
}

describe("withActionStep generated child lifecycle", () => {
	it("completes a generated child after a successful callback", async () => {
		const trajectoryLogger = new TestTrajectoryLogger();
		const runtime = await makeRuntime(trajectoryLogger);
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
		const trajectoryLogger = new TestTrajectoryLogger();
		const runtime = await makeRuntime(trajectoryLogger);
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
		const trajectoryLogger = new TestTrajectoryLogger();
		trajectoryLogger.startStep.mockImplementation(() => {
			throw new Error("start failed");
		});
		trajectoryLogger.flushWriteQueue
			.mockRejectedValueOnce(new Error("child flush failed"))
			.mockRejectedValueOnce(new Error("parent flush failed"));
		trajectoryLogger.annotateStep.mockImplementation(async () => {
			throw new Error("annotation failed");
		});
		const runtime = await makeRuntime(trajectoryLogger);

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
