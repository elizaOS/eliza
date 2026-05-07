import { describe, expect, it } from "vitest";
import {
	iterateTrajectoryLlmCalls,
	resolveJsonShape,
	serializeTrajectoryExport,
	summarizeTrajectoryCache,
	summarizeTrajectoryUsage,
} from "./trajectory-export";
import type { TrajectoryDetailRecord } from "./trajectory-types";
import { ELIZA_NATIVE_TRAJECTORY_FORMAT } from "./trajectory-types";

const sampleTrajectory: TrajectoryDetailRecord = {
	trajectoryId: "traj-1",
	agentId: "agent-1",
	startTime: 1_700_000_000_000,
	endTime: 1_700_000_000_100,
	durationMs: 100,
	metrics: {
		finalStatus: "completed",
	},
	metadata: {
		source: "chat",
	},
	stepsJson: JSON.stringify([
		{
			stepId: "step-1",
			timestamp: 1_700_000_000_010,
			kind: "llm",
			llmCalls: [
				{
					callId: "call-1",
					systemPrompt: "You are helpful.",
					userPrompt: "Say hello",
					response: "Hello there",
					promptTokens: 100,
					completionTokens: 25,
					cacheReadInputTokens: 60,
					cacheCreationInputTokens: 20,
					tokenUsageEstimated: true,
				},
				{
					systemPrompt: "You are helpful.",
					userPrompt: "Say goodbye",
					response: "Goodbye",
					promptTokens: 50,
					completionTokens: 10,
				},
			],
		},
	]),
};

describe("trajectory-export", () => {
	it("uses persisted stepsJson for totals and flattened llm calls", () => {
		expect(summarizeTrajectoryUsage(sampleTrajectory)).toMatchObject({
			stepCount: 1,
			llmCallCount: 2,
			providerAccessCount: 0,
			promptTokens: 150,
			completionTokens: 35,
			cacheReadInputTokens: 60,
			cacheCreationInputTokens: 20,
		});

		const calls = iterateTrajectoryLlmCalls(sampleTrajectory);
		expect(calls).toHaveLength(2);
		expect(calls[0]).toMatchObject({
			callId: "call-1",
			stepId: "step-1",
			status: "completed",
			source: "chat",
		});
		expect(calls[1]?.callId).toBe("traj-1:step-1:call:2");
	});

	it("summarizes cache usage without double-counting prompt tokens", () => {
		expect(summarizeTrajectoryCache(sampleTrajectory)).toMatchObject({
			totalInputTokens: 150,
			promptTokens: 150,
			completionTokens: 35,
			cacheReadInputTokens: 60,
			cacheCreationInputTokens: 20,
			cachedCallCount: 1,
			cacheReadCallCount: 1,
			cacheWriteCallCount: 1,
			tokenUsageEstimatedCallCount: 1,
		});
	});

	it("supports explicit legacy jsonl while defaulting jsonl to native rows", () => {
		expect(resolveJsonShape("jsonl", undefined)).toBe(
			ELIZA_NATIVE_TRAJECTORY_FORMAT,
		);
		expect(resolveJsonShape("json", undefined)).toBe(
			ELIZA_NATIVE_TRAJECTORY_FORMAT,
		);

		const legacy = serializeTrajectoryExport([sampleTrajectory], {
			format: "jsonl",
			jsonShape: "legacy",
		});
		const legacyLines = String(legacy.data).trim().split("\n");
		expect(legacyLines).toHaveLength(1);
		expect(JSON.parse(legacyLines[0] ?? "")).toMatchObject({
			trajectoryId: "traj-1",
		});

		const native = serializeTrajectoryExport([sampleTrajectory], {
			format: "jsonl",
		});
		const nativeLines = String(native.data).trim().split("\n");
		expect(nativeLines).toHaveLength(2);
		expect(JSON.parse(nativeLines[0] ?? "")).toMatchObject({
			format: ELIZA_NATIVE_TRAJECTORY_FORMAT,
			boundary: "vercel_ai_sdk.generateText",
			callId: "call-1",
			response: {
				text: "Hello there",
			},
		});
	});
});
