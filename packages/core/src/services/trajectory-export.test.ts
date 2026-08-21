/**
 * Tests for the trajectory export helpers: usage/cache summaries, flattened
 * LLM-call iteration, and JSON/JSONL/ART serialization over a sample trajectory
 * built from both persisted `stepsJson` and inline `steps`.
 */
import { describe, expect, it } from "vitest";
import {
	iterateTrajectoryLlmCalls,
	resolveJsonShape,
	serializeTrajectoryExport,
	summarizeTrajectoryCache,
	summarizeTrajectoryUsage,
	trajectoryToPlaintext,
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
			semanticStages: [
				{
					schemaVersion: 1,
					stageId: "stage-tool-search-1",
					kind: "toolSearch",
					startedAt: 1_700_000_000_001,
					endedAt: 1_700_000_000_009,
					latencyMs: 8,
					payload: {
						toolSearch: {
							query: { candidateActions: ["OWNER_ROUTINES", "VIEWS"] },
							results: [{ name: "OWNER_ROUTINES", rank: 1, score: 0.91 }],
						},
					},
				},
			],
			llmCalls: [
				{
					callId: "call-1",
					actionType: "ai.generateText",
					provider: "vercel-ai-sdk",
					systemPrompt: "You are helpful.",
					userPrompt: "Say hello",
					output: { type: "object", name: "Greeting" },
					responseSchema: { type: "object" },
					response: "Hello there",
					maxTokens: 128,
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

	it("rejects corrupt persisted steps instead of exporting a valid empty run", () => {
		expect(() =>
			summarizeTrajectoryUsage({
				...sampleTrajectory,
				stepsJson: "not-json{",
			}),
		).toThrow("Trajectory steps contain malformed JSON");
		expect(() =>
			summarizeTrajectoryUsage({
				...sampleTrajectory,
				stepsJson: JSON.stringify({ stepId: "not-an-array" }),
			}),
		).toThrow("Trajectory steps must be an array");
		expect(() =>
			summarizeTrajectoryUsage({
				...sampleTrajectory,
				stepsJson: JSON.stringify([
					{
						stepId: "corrupt-semantic-stage",
						timestamp: 1,
						llmCalls: [],
						semanticStages: [
							{
								schemaVersion: 1,
								stageId: "self-parent",
								parentStageId: "self-parent",
								kind: "planner",
								startedAt: 1,
								endedAt: 2,
								latencyMs: 1,
								payload: {},
							},
						],
					},
				]),
			}),
		).toThrow("Trajectory semantic stage is invalid");
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

	it("exports markdown-friendly plaintext from the trajectory export module", () => {
		expect(trajectoryToPlaintext(sampleTrajectory)).toContain(
			"Trajectory traj-1",
		);
		expect(trajectoryToPlaintext(sampleTrajectory)).toContain(
			"LLM call call-1",
		);
		expect(trajectoryToPlaintext(sampleTrajectory)).toContain("Hello there");
	});

	it("exports native JSON and JSONL rows by default", () => {
		expect(resolveJsonShape("jsonl", undefined)).toBe(
			ELIZA_NATIVE_TRAJECTORY_FORMAT,
		);
		expect(resolveJsonShape("json", undefined)).toBe(
			ELIZA_NATIVE_TRAJECTORY_FORMAT,
		);
		expect(() =>
			resolveJsonShape("jsonl", "context_object_events_v5" as never),
		).toThrow(/Only eliza_native_v1 is supported/);

		const native = serializeTrajectoryExport([sampleTrajectory], {
			format: "jsonl",
		});
		const nativeLines = String(native.data).trim().split("\n");
		expect(nativeLines).toHaveLength(2);
		expect(JSON.parse(nativeLines[0] ?? "")).toMatchObject({
			format: ELIZA_NATIVE_TRAJECTORY_FORMAT,
			boundary: "vercel_ai_sdk.generateText",
			callId: "call-1",
			request: {
				system: "You are helpful.",
				prompt: "Say hello",
				output: { type: "object", name: "Greeting" },
				settings: { maxOutputTokens: 128 },
			},
			response: {
				text: "Hello there",
			},
			metadata: {
				trajectory_step: {
					semanticStages: [
						{
							stageId: "stage-tool-search-1",
							payload: {
								toolSearch: {
									query: {
										candidateActions: ["OWNER_ROUTINES", "VIEWS"],
									},
									results: [{ name: "OWNER_ROUTINES", rank: 1 }],
								},
							},
						},
					],
				},
			},
		});

		const nativeJson = serializeTrajectoryExport([sampleTrajectory], {
			format: "json",
		});
		const rows = JSON.parse(String(nativeJson.data)) as Array<{
			format: string;
		}>;
		expect(rows[0]?.format).toBe(ELIZA_NATIVE_TRAJECTORY_FORMAT);
	});

	it("prefers native request messages over stale systemPrompt fallbacks", () => {
		const trajectory: TrajectoryDetailRecord = {
			trajectoryId: "traj-native",
			agentId: "agent-1",
			startTime: 1,
			steps: [
				{
					stepId: "step-1",
					timestamp: 1,
					llmCalls: [
						{
							callId: "call-1",
							systemPrompt: "stale system",
							userPrompt: "stale user",
							messages: [
								{
									role: "system",
									content:
										"Character system.\n\n# About Test Agent\nBio.\n\nuser_role: ADMIN",
								},
								{ role: "user", content: "fresh user" },
							],
							response: "fresh response",
						},
					],
				},
			],
		};

		const native = serializeTrajectoryExport([trajectory], { format: "jsonl" });
		const row = JSON.parse(String(native.data).trim()) as {
			request: {
				system?: string;
				prompt?: string;
				messages: Array<{ role: string; content: string }>;
			};
		};
		expect(row.request.system).toBeUndefined();
		expect(row.request.prompt).toBeUndefined();
		expect(row.request.messages[0]?.content).toContain("user_role: ADMIN");

		const art = serializeTrajectoryExport([trajectory], {
			format: "art",
		});
		const artRow = JSON.parse(String(art.data).trim()) as {
			messages: Array<{ role: string; content: string }>;
		};
		expect(artRow?.messages[0]).toMatchObject({
			role: "system",
			content: expect.stringContaining("user_role: ADMIN"),
		});
		expect(artRow?.messages[1]).toMatchObject({
			role: "user",
			content: "fresh user",
		});
	});

	it("marks streaming SDK rows with the streamText boundary", () => {
		const trajectory: TrajectoryDetailRecord = {
			trajectoryId: "traj-stream",
			agentId: "agent-1",
			startTime: 1,
			steps: [
				{
					stepId: "step-1",
					timestamp: 1,
					llmCalls: [
						{
							callId: "call-1",
							actionType: "ai.streamText",
							provider: "vercel-ai-sdk",
							systemPrompt: "stream system",
							userPrompt: "stream user",
							response: "stream response",
						},
					],
				},
			],
		};

		const native = serializeTrajectoryExport([trajectory], { format: "jsonl" });
		const row = JSON.parse(String(native.data).trim()) as {
			boundary: string;
		};
		expect(row.boundary).toBe("vercel_ai_sdk.streamText");
	});
});
