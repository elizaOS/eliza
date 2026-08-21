/**
 * Exercises the planner-continuation evidence barrier with the real
 * post-delivery tracker and deterministic delayed and nested terminal work.
 */

import { describe, expect, it, vi } from "vitest";
import {
	drainPostDeliveryTasks,
	trackPostDeliveryTask,
} from "../services/post-delivery-task-tracker.ts";
import type { IAgentRuntime } from "../types/runtime.ts";
import {
	type PlannerContinuationTrajectoryDetail,
	readCompletedPlannerContinuationTrajectory,
} from "./planner-continuation-trajectory.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function runtimeStub(): Pick<IAgentRuntime, "agentId" | "reportError"> {
	return {
		agentId: "00000000-0000-4000-8000-000000000045",
		reportError: vi.fn(),
	};
}

function trajectoryService(
	readDetail: () => PlannerContinuationTrajectoryDetail | null,
) {
	const calls: string[] = [];
	return {
		calls,
		flushWriteQueue: vi.fn(async (trajectoryId: string) => {
			calls.push(`flush:${trajectoryId}`);
		}),
		getTrajectoryDetail: vi.fn(async (trajectoryId: string) => {
			calls.push(`read:${trajectoryId}`);
			return readDetail();
		}),
	};
}

describe("planner continuation trajectory persistence barrier", () => {
	it("waits for delayed terminalization before one flush and one read", async () => {
		const runtime = runtimeStub();
		const terminalGate = deferred();
		const taskStarted = deferred();
		let detail: PlannerContinuationTrajectoryDetail = {
			metrics: { finalStatus: "active" },
		};
		trackPostDeliveryTask(runtime, "delayed-terminal", async () => {
			taskStarted.resolve();
			await terminalGate.promise;
			detail = { metrics: { finalStatus: "completed" } };
		});
		const service = trajectoryService(() => detail);

		const read = readCompletedPlannerContinuationTrajectory(
			runtime,
			"trajectory-delayed",
			service,
		);
		await taskStarted.promise;
		expect(service.flushWriteQueue).not.toHaveBeenCalled();
		expect(service.getTrajectoryDetail).not.toHaveBeenCalled();

		terminalGate.resolve();
		await expect(read).resolves.toEqual({
			metrics: { finalStatus: "completed" },
		});
		expect(service.flushWriteQueue).toHaveBeenCalledOnce();
		expect(service.flushWriteQueue).toHaveBeenCalledWith("trajectory-delayed");
		expect(service.getTrajectoryDetail).toHaveBeenCalledOnce();
		expect(service.getTrajectoryDetail).toHaveBeenCalledWith(
			"trajectory-delayed",
		);
		expect(service.calls).toEqual([
			"flush:trajectory-delayed",
			"read:trajectory-delayed",
		]);
	});

	it("drains separately gated nested tracked work before persistence", async () => {
		const runtime = runtimeStub();
		const nestedGate = deferred();
		const nestedStarted = deferred();
		let detail: PlannerContinuationTrajectoryDetail = {
			metrics: { finalStatus: "active" },
		};
		const outer = trackPostDeliveryTask(runtime, "outer-terminal", async () => {
			trackPostDeliveryTask(runtime, "nested-terminal", async () => {
				nestedStarted.resolve();
				await nestedGate.promise;
				detail = { metrics: { finalStatus: "completed" } };
			});
		});
		const service = trajectoryService(() => detail);
		const read = readCompletedPlannerContinuationTrajectory(
			runtime,
			"trajectory-nested",
			service,
		);

		await nestedStarted.promise;
		await outer;
		expect(service.flushWriteQueue).not.toHaveBeenCalled();
		expect(service.getTrajectoryDetail).not.toHaveBeenCalled();

		nestedGate.resolve();
		await expect(read).resolves.toEqual({
			metrics: { finalStatus: "completed" },
		});
		expect(service.flushWriteQueue).toHaveBeenCalledTimes(1);
		expect(service.getTrajectoryDetail).toHaveBeenCalledTimes(1);
		await expect(drainPostDeliveryTasks(runtime)).resolves.toBe(0);
	});

	it("rejects a missing detail after exactly one flush and one read", async () => {
		const runtime = runtimeStub();
		const service = trajectoryService(() => null);

		await expect(
			readCompletedPlannerContinuationTrajectory(
				runtime,
				"trajectory-missing",
				service,
			),
		).rejects.toThrow('trajectory "trajectory-missing" was not persisted');
		expect(service.flushWriteQueue).toHaveBeenCalledTimes(1);
		expect(service.getTrajectoryDetail).toHaveBeenCalledTimes(1);
	});

	it("rejects a nonterminal detail and names its observed status", async () => {
		const runtime = runtimeStub();
		const service = trajectoryService(() => ({
			metrics: { finalStatus: "active" },
		}));

		await expect(
			readCompletedPlannerContinuationTrajectory(
				runtime,
				"trajectory-active",
				service,
			),
		).rejects.toThrow(
			'trajectory "trajectory-active" is not completed (observed: active)',
		);
		expect(service.flushWriteQueue).toHaveBeenCalledTimes(1);
		expect(service.getTrajectoryDetail).toHaveBeenCalledTimes(1);
	});

	it("rejects blank ids and incomplete trajectory services as harness errors", async () => {
		const runtime = runtimeStub();
		const completeService = trajectoryService(() => ({
			metrics: { finalStatus: "completed" },
		}));

		await expect(
			readCompletedPlannerContinuationTrajectory(
				runtime,
				"  ",
				completeService,
			),
		).rejects.toThrow("trajectoryId must be non-empty");
		await expect(
			readCompletedPlannerContinuationTrajectory(runtime, "trajectory-id", {
				getTrajectoryDetail: completeService.getTrajectoryDetail,
			}),
		).rejects.toThrow("requires flushWriteQueue");
		await expect(
			readCompletedPlannerContinuationTrajectory(runtime, "trajectory-id", {
				flushWriteQueue: completeService.flushWriteQueue,
			}),
		).rejects.toThrow("requires getTrajectoryDetail");
		expect(completeService.flushWriteQueue).not.toHaveBeenCalled();
		expect(completeService.getTrajectoryDetail).not.toHaveBeenCalled();
	});
});
