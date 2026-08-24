/**
 * Unit tests for trajectory evaluator utils: verifies JSON object parsing,
 * trajectory service lookup, and prompt digest formatting.
 */
import { describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../../../types/index.ts";
import {
	formatTrajectoryForPrompt,
	getTrajectoryService,
	parseJsonObject,
	type SkillTrajectory,
} from "./trajectory-evaluator-utils.ts";

describe("trajectory-evaluator-utils", () => {
	describe("parseJsonObject", () => {
		it("parses valid json object string", () => {
			const res = parseJsonObject('{"key": "value", "count": 42}');
			expect(res).toEqual({ key: "value", count: 42 });
		});

		it("returns null for malformed json or empty text", () => {
			expect(parseJsonObject("")).toBeNull();
			expect(parseJsonObject("   ")).toBeNull();
			expect(parseJsonObject("{bad json}")).toBeNull();
		});

		it("returns null for non-object json values", () => {
			expect(parseJsonObject('"a string"')).toBeNull();
			expect(parseJsonObject("123")).toBeNull();
			expect(parseJsonObject("null")).toBeNull();
			expect(parseJsonObject("true")).toBeNull();
		});
	});

	describe("getTrajectoryService", () => {
		it("returns null when trajectories service is absent", () => {
			const runtime = {
				getService: () => null,
			} as unknown as IAgentRuntime;
			expect(getTrajectoryService(runtime)).toBeNull();
		});

		it("returns null when service does not implement required methods", () => {
			const runtime = {
				getService: () => ({
					listTrajectories: () => {},
				}),
			} as unknown as IAgentRuntime;
			expect(getTrajectoryService(runtime)).toBeNull();
		});

		it("returns typed service when valid methods exist", () => {
			const service = {
				listTrajectories: async () => ({ trajectories: [] }),
				getTrajectoryDetail: async () => null,
			};
			const runtime = {
				getService: () => service,
			} as unknown as IAgentRuntime;
			expect(getTrajectoryService(runtime)).toBe(service);
		});
	});

	describe("formatTrajectoryForPrompt", () => {
		it("formats minimal trajectory", () => {
			const traj: SkillTrajectory = {
				trajectoryId: "traj-123",
				agentId: "agent-1",
				startTime: 1000,
			};
			const out = formatTrajectoryForPrompt(traj);
			expect(out).toContain("Trajectory: traj-123");
			expect(out).toContain("Status: unknown");
		});

		it("formats trajectory with steps, llm calls, and custom options", () => {
			const traj: SkillTrajectory = {
				trajectoryId: "traj-456",
				agentId: "agent-2",
				startTime: 1000,
				metrics: { finalStatus: "completed" },
				steps: [
					{
						timestamp: 1010,
						llmCalls: [
							{
								purpose: "search",
								userPrompt: "Find documentation",
								response: "Here is the doc",
							},
							{
								actionType: "tool_use",
								userPrompt: "Run command",
								response: "Done",
							},
						],
					},
				],
			};

			const out = formatTrajectoryForPrompt(traj, {
				statusLabel: "Final State",
				includeStepCount: true,
				blankLineAfterHeader: true,
			});

			expect(out).toContain("Trajectory: traj-456");
			expect(out).toContain("Final State: completed");
			expect(out).toContain("Step count: 1");
			expect(out).toContain("--- Step 1 ---");
			expect(out).toContain("[search]");
			expect(out).toContain("USER: Find documentation");
			expect(out).toContain("AGENT: Here is the doc");
			expect(out).toContain("[tool_use]");
		});
	});
});
