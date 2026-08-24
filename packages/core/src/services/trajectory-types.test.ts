/**
 * Coverage for the trajectory subsystem's canonical constant surface in
 * `services/trajectory-types.ts`. Deterministic unit harness: it drives the
 * real module with no mocks and pins the two runtime bindings plus the
 * export-row shape they feed.
 */
import { describe, expect, it } from "vitest";
import {
	ELIZA_NATIVE_MODEL_BOUNDARIES,
	ELIZA_NATIVE_TRAJECTORY_FORMAT,
	type ElizaNativeTrajectoryRow,
} from "./trajectory-types.ts";

describe("trajectory-types canonical constants", () => {
	it("exports the eliza-native format tag verbatim", () => {
		expect(ELIZA_NATIVE_TRAJECTORY_FORMAT).toBe("eliza_native_v1");
		expect(typeof ELIZA_NATIVE_TRAJECTORY_FORMAT).toBe("string");
	});

	it("lists the model boundaries in canonical order without duplicates", () => {
		expect(ELIZA_NATIVE_MODEL_BOUNDARIES).toEqual([
			"vercel_ai_sdk.generateText",
			"vercel_ai_sdk.streamText",
		]);
		expect(new Set(ELIZA_NATIVE_MODEL_BOUNDARIES).size).toBe(
			ELIZA_NATIVE_MODEL_BOUNDARIES.length,
		);
	});

	it("exposes exactly the two runtime bindings from the module", async () => {
		const mod = await import("./trajectory-types.ts");
		expect(Object.keys(mod).sort()).toEqual([
			"ELIZA_NATIVE_MODEL_BOUNDARIES",
			"ELIZA_NATIVE_TRAJECTORY_FORMAT",
		]);
		expect(mod.ELIZA_NATIVE_TRAJECTORY_FORMAT).toBe(
			ELIZA_NATIVE_TRAJECTORY_FORMAT,
		);
		expect(mod.ELIZA_NATIVE_MODEL_BOUNDARIES).toBe(
			ELIZA_NATIVE_MODEL_BOUNDARIES,
		);
	});

	it("binds both constants into an eliza-native export row", () => {
		const row: ElizaNativeTrajectoryRow = {
			trajectoryId: "traj-1",
			agentId: "agent-1",
			status: "completed",
			stepId: "step-1",
			callId: "call-1",
			stepIndex: 0,
			callIndex: 0,
			timestamp: 1_700_000_000_000,
			tags: [],
			format: ELIZA_NATIVE_TRAJECTORY_FORMAT,
			schemaVersion: 1,
			boundary: ELIZA_NATIVE_MODEL_BOUNDARIES[0],
			request: { prompt: "hello" },
			response: { text: "hi" },
			metadata: {},
			trajectoryTotals: {
				stepCount: 1,
				llmCallCount: 1,
				providerAccessCount: 0,
				promptTokens: 10,
				completionTokens: 5,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
			},
			cacheStats: {
				totalInputTokens: 10,
				promptTokens: 10,
				completionTokens: 5,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				cachedCallCount: 0,
				cacheReadCallCount: 0,
				cacheWriteCallCount: 0,
				tokenUsageEstimatedCallCount: 0,
			},
		};

		expect(row.format).toBe(ELIZA_NATIVE_TRAJECTORY_FORMAT);
		expect(row.schemaVersion).toBe(1);
		expect(ELIZA_NATIVE_MODEL_BOUNDARIES).toContain(row.boundary);
		expect(row.trajectoryTotals.llmCallCount).toBe(1);
		expect(row.cacheStats.totalInputTokens).toBe(
			row.trajectoryTotals.promptTokens,
		);
	});
});
