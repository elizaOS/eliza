/**
 * Deterministic unit tests for trajectory evaluator parsing, service discovery,
 * and complete prompt formatting without a live runtime or model.
 */
import { describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../../../types/index.ts";
import {
	formatTrajectoryForPrompt,
	getTrajectoryService,
	parseJsonObject,
	type SkillTrajectory,
	type SkillTrajectoryService,
} from "./trajectory-evaluator-utils.ts";

function runtimeWithService(service: unknown): IAgentRuntime {
	return {
		getService: (serviceType: string) =>
			serviceType === "trajectories" ? service : null,
	} as unknown as IAgentRuntime;
}

describe("parseJsonObject", () => {
	it("parses a JSON object after trimming surrounding whitespace", () => {
		expect(parseJsonObject('  {"skill":"research","score":2}  ')).toEqual({
			skill: "research",
			score: 2,
		});
	});

	it.each(["", "   ", "not json", "{broken"])(
		"rejects empty or malformed input %j",
		(raw) => {
			expect(parseJsonObject(raw)).toBeNull();
		},
	);

	it.each(["null", "false", "0", '"text"'])(
		"rejects the non-object JSON value %s",
		(raw) => {
			expect(parseJsonObject(raw)).toBeNull();
		},
	);
});

describe("getTrajectoryService", () => {
	it("returns null when the runtime has no trajectories service", () => {
		expect(getTrajectoryService(runtimeWithService(null))).toBeNull();
	});

	it.each([
		{},
		{ listTrajectories: async () => ({ trajectories: [] }) },
		{ getTrajectoryDetail: async () => null },
	])("rejects an incomplete service shape", (service) => {
		expect(getTrajectoryService(runtimeWithService(service))).toBeNull();
	});

	it("returns the service when both required methods are callable", () => {
		const service: SkillTrajectoryService = {
			listTrajectories: async () => ({ trajectories: [] }),
			getTrajectoryDetail: async () => null,
		};

		expect(getTrajectoryService(runtimeWithService(service))).toBe(service);
	});
});

describe("formatTrajectoryForPrompt", () => {
	it("formats the default header and an unknown status for an empty trajectory", () => {
		const trajectory: SkillTrajectory = {
			trajectoryId: "trajectory-empty",
			agentId: "agent-1",
			startTime: 1,
		};

		expect(formatTrajectoryForPrompt(trajectory)).toBe(
			"Trajectory: trajectory-empty\nStatus: unknown",
		);
	});

	it("applies header options and counts every step", () => {
		const trajectory: SkillTrajectory = {
			trajectoryId: "trajectory-options",
			agentId: "agent-1",
			startTime: 1,
			metrics: { finalStatus: "completed" },
			steps: [{ timestamp: 10 }, { timestamp: 20 }],
		};

		expect(
			formatTrajectoryForPrompt(trajectory, {
				statusLabel: "Final status",
				includeStepCount: true,
				blankLineAfterHeader: true,
			}),
		).toBe(
			[
				"Trajectory: trajectory-options",
				"Final status: completed",
				"Step count: 2",
				"",
				"--- Step 1 ---",
				"--- Step 2 ---",
			].join("\n"),
		);
	});

	it("preserves step and call order while applying purpose fallbacks", () => {
		const trajectory: SkillTrajectory = {
			trajectoryId: "trajectory-ordered",
			agentId: "agent-1",
			startTime: 1,
			steps: [
				{
					timestamp: 10,
					llmCalls: [
						{
							purpose: "plan",
							actionType: "ignored-action",
							userPrompt: "first user",
							response: "first agent",
						},
						{ actionType: "tool", response: "second agent" },
						{ userPrompt: "third user" },
					],
				},
				{ timestamp: 20, llmCalls: [] },
			],
		};

		expect(formatTrajectoryForPrompt(trajectory)).toBe(
			[
				"Trajectory: trajectory-ordered",
				"Status: unknown",
				"--- Step 1 ---",
				"[plan]",
				"USER: first user",
				"AGENT: first agent",
				"[tool]",
				"AGENT: second agent",
				"[step]",
				"USER: third user",
				"--- Step 2 ---",
			].join("\n"),
		);
	});

	it("replaces lone surrogates in model-facing prompt and response text", () => {
		const trajectory: SkillTrajectory = {
			trajectoryId: "trajectory-unicode",
			agentId: "agent-1",
			startTime: 1,
			steps: [
				{
					timestamp: 10,
					llmCalls: [
						{
							userPrompt: "before\uD800after",
							response: "reply\uDC00done",
						},
					],
				},
			],
		};

		const formatted = formatTrajectoryForPrompt(trajectory);

		expect(formatted).toContain("USER: before\uFFFDafter");
		expect(formatted).toContain("AGENT: reply\uFFFDdone");
	});
});
