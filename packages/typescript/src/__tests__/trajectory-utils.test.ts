import { describe, expect, it, vi } from "vitest";
import { getTrajectoryContext, runWithTrajectoryContext } from "../trajectory-context";
import {
	logActiveTrajectoryLlmCall,
	resolveTrajectoryLogger,
	withStandaloneTrajectory,
} from "../trajectory-utils";
import type { IAgentRuntime } from "../types/runtime";

type MockTrajectoryLogger = {
	isEnabled?: ReturnType<typeof vi.fn>;
	startTrajectory?: ReturnType<typeof vi.fn>;
	startStep?: ReturnType<typeof vi.fn>;
	endTrajectory?: ReturnType<typeof vi.fn>;
	flushWriteQueue?: ReturnType<typeof vi.fn>;
	logLlmCall?: ReturnType<typeof vi.fn>;
};

function createRuntime(
	primaryService: unknown,
	additionalServices: unknown[] = [],
): IAgentRuntime {
	return {
		agentId: "test-agent",
		getService: vi.fn().mockReturnValue(primaryService),
		getServicesByType: vi.fn().mockReturnValue(additionalServices),
	} as unknown as IAgentRuntime;
}

describe("trajectory-utils", () => {
	it("prefers the real trajectory logger over the core stub", () => {
		const stub = {
			logLlmCall: vi.fn(),
		};
		const realLogger = {
			startTrajectory: vi.fn(),
			startStep: vi.fn(),
			endTrajectory: vi.fn(),
			logLlmCall: vi.fn(),
		};
		const runtime = createRuntime(stub, [stub, realLogger]);

		expect(resolveTrajectoryLogger(runtime)).toBe(realLogger);
	});

	it("runs callbacks inside a standalone trajectory step when no context is active", async () => {
		const logger: MockTrajectoryLogger = {
			startTrajectory: vi.fn().mockResolvedValue("trajectory-1"),
			startStep: vi.fn().mockReturnValue("step-1"),
			flushWriteQueue: vi.fn().mockResolvedValue(undefined),
			endTrajectory: vi.fn().mockResolvedValue(undefined),
		};
		const runtime = createRuntime(logger);

		const result = await withStandaloneTrajectory(
			runtime,
			{
				source: "knowledge",
				metadata: { model: "test-model" },
			},
			async () => getTrajectoryContext()?.trajectoryStepId ?? null,
		);

		expect(result).toBe("step-1");
		expect(logger.startTrajectory).toHaveBeenCalledWith("test-agent", {
			source: "knowledge",
			metadata: { model: "test-model" },
		});
		expect(logger.startStep).toHaveBeenCalledWith(
			"trajectory-1",
			expect.objectContaining({
				timestamp: expect.any(Number),
			}),
		);
		expect(logger.flushWriteQueue).toHaveBeenCalledWith("trajectory-1");
		expect(logger.endTrajectory).toHaveBeenCalledWith(
			"trajectory-1",
			"completed",
		);
	});

	it("does not create a nested standalone trajectory when a step is already active", async () => {
		const logger: MockTrajectoryLogger = {
			startTrajectory: vi.fn(),
			startStep: vi.fn(),
			endTrajectory: vi.fn(),
		};
		const runtime = createRuntime(logger);

		const result = await runWithTrajectoryContext(
			{ trajectoryStepId: "existing-step" },
			() =>
				withStandaloneTrajectory(runtime, { source: "knowledge" }, async () => {
					return getTrajectoryContext()?.trajectoryStepId ?? null;
				}),
		);

		expect(result).toBe("existing-step");
		expect(logger.startTrajectory).not.toHaveBeenCalled();
		expect(logger.startStep).not.toHaveBeenCalled();
		expect(logger.endTrajectory).not.toHaveBeenCalled();
	});

	it("ends standalone trajectories with error status when the callback throws", async () => {
		const logger: MockTrajectoryLogger = {
			startTrajectory: vi.fn().mockResolvedValue("trajectory-2"),
			startStep: vi.fn().mockReturnValue("step-2"),
			flushWriteQueue: vi.fn().mockResolvedValue(undefined),
			endTrajectory: vi.fn().mockResolvedValue(undefined),
		};
		const runtime = createRuntime(logger);

		await expect(
			withStandaloneTrajectory(runtime, { source: "training" }, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		expect(logger.flushWriteQueue).toHaveBeenCalledWith("trajectory-2");
		expect(logger.endTrajectory).toHaveBeenCalledWith("trajectory-2", "error");
	});

	it("logs LLM calls against the active trajectory step", () => {
		const logger: MockTrajectoryLogger = {
			logLlmCall: vi.fn(),
		};
		const runtime = createRuntime(logger);

		const logged = runWithTrajectoryContext(
			{ trajectoryStepId: "active-step" },
			() =>
				logActiveTrajectoryLlmCall(runtime, {
					model: "openai/gpt-5",
					systemPrompt: "system",
					userPrompt: "user",
					response: "assistant",
					temperature: 0.2,
					maxTokens: 512,
					purpose: "other",
					actionType: "test.case",
					latencyMs: 42,
					promptTokens: 5,
					completionTokens: 3,
				}),
		);

		expect(logged).toBe(true);
		expect(logger.logLlmCall).toHaveBeenCalledWith(
			expect.objectContaining({
				stepId: "active-step",
				model: "openai/gpt-5",
				userPrompt: "user",
				response: "assistant",
			}),
		);
	});
});
