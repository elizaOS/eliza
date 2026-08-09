/**
 * Verifies standalone trajectory telemetry cannot replace a successful
 * business result when queue draining or terminal persistence fails.
 */

import { describe, expect, it, vi } from "vitest";
import { withStandaloneTrajectory } from "./trajectory-utils";
import type { IAgentRuntime } from "./types";

describe("withStandaloneTrajectory", () => {
	it("reports rejected flush and end operations while preserving success", async () => {
		const flushError = new Error("flush failed");
		const endError = new Error("end failed");
		const trajectoryLogger = {
			isEnabled: () => true,
			startTrajectory: vi.fn(async () => "trajectory-1"),
			startStep: vi.fn(() => "step-1"),
			flushWriteQueue: vi.fn(async () => {
				throw flushError;
			}),
			endTrajectory: vi.fn(async () => {
				throw endError;
			}),
		};
		const reportError = vi.fn();
		const runtime = {
			agentId: "agent-1",
			getService: vi.fn(() => trajectoryLogger),
			getServicesByType: vi.fn(() => [trajectoryLogger]),
			reportError,
		} as unknown as IAgentRuntime;

		await expect(
			withStandaloneTrajectory(
				runtime,
				{ source: "documents" },
				async () => "business-success",
			),
		).resolves.toBe("business-success");
		expect(trajectoryLogger.flushWriteQueue).toHaveBeenCalledWith(
			"trajectory-1",
		);
		expect(trajectoryLogger.endTrajectory).toHaveBeenCalledWith(
			"trajectory-1",
			"completed",
		);
		expect(reportError).toHaveBeenNthCalledWith(
			1,
			"StandaloneTrajectory.flush",
			flushError,
			{ trajectoryId: "trajectory-1", diagnosticOnly: true },
		);
		expect(reportError).toHaveBeenNthCalledWith(
			2,
			"StandaloneTrajectory.end",
			endError,
			{ trajectoryId: "trajectory-1", diagnosticOnly: true },
		);
	});

	it("runs the callback uncaptured when trajectory start rejects", async () => {
		const startError = new Error("start failed");
		const callback = vi.fn(async () => "business-success");
		const trajectoryLogger = {
			isEnabled: () => true,
			startTrajectory: vi.fn(async () => {
				throw startError;
			}),
			startStep: vi.fn(() => "step-never-created"),
			endTrajectory: vi.fn(async () => {}),
		};
		const reportError = vi.fn();
		const runtime = {
			agentId: "agent-1",
			getService: vi.fn(() => trajectoryLogger),
			getServicesByType: vi.fn(() => [trajectoryLogger]),
			reportError,
		} as unknown as IAgentRuntime;

		await expect(
			withStandaloneTrajectory(runtime, { source: "documents" }, callback),
		).resolves.toBe("business-success");
		expect(callback).toHaveBeenCalledOnce();
		expect(trajectoryLogger.startStep).not.toHaveBeenCalled();
		expect(trajectoryLogger.endTrajectory).not.toHaveBeenCalled();
		expect(reportError).toHaveBeenCalledWith(
			"StandaloneTrajectory.start",
			startError,
			{ source: "documents", diagnosticOnly: true },
		);
	});

	it("falls back to the parent when child-step setup throws", async () => {
		const startStepError = new Error("start step failed");
		const callback = vi.fn(async () => "business-success");
		const trajectoryLogger = {
			isEnabled: () => true,
			startTrajectory: vi.fn(async () => "trajectory-1"),
			startStep: vi.fn(() => {
				throw startStepError;
			}),
			flushWriteQueue: vi.fn(async () => {}),
			endTrajectory: vi.fn(async () => {}),
		};
		const reportError = vi.fn();
		const runtime = {
			agentId: "agent-1",
			getService: vi.fn(() => trajectoryLogger),
			getServicesByType: vi.fn(() => [trajectoryLogger]),
			reportError,
		} as unknown as IAgentRuntime;

		await expect(
			withStandaloneTrajectory(runtime, { source: "documents" }, callback),
		).resolves.toBe("business-success");
		expect(callback).toHaveBeenCalledOnce();
		expect(trajectoryLogger.flushWriteQueue).toHaveBeenCalledWith(
			"trajectory-1",
		);
		expect(trajectoryLogger.endTrajectory).toHaveBeenCalledWith(
			"trajectory-1",
			"completed",
		);
		expect(reportError).toHaveBeenCalledWith(
			"StandaloneTrajectory.startStep",
			startStepError,
			{ trajectoryId: "trajectory-1", diagnosticOnly: true },
		);
	});
});
