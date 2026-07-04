/**
 * Core trajectory → ART (RL training) conversion. toARTMessages must emit the
 * system/user/assistant message array; validateARTCompatibility rejects
 * trajectories with no steps or no reward; groupTrajectories buckets by scenario.
 */

import { describe, expect, it } from "vitest";
import {
	groupTrajectories,
	toARTMessages,
	validateARTCompatibility,
} from "./art-format.ts";
import type { Trajectory } from "./types.ts";

const step = () => ({
	llmCalls: [
		{
			purpose: "action",
			systemPrompt: "You are an autonomous agent.",
			userPrompt: "Observe the state and choose an action.",
			response: "I will hold this turn.",
		},
	],
	environmentState: { agentBalance: 100, agentPnL: 0, openPositions: 0 },
	providerAccesses: [],
	action: { actionType: "hold", parameters: {} },
});

const traj = (over: Partial<Trajectory>): Trajectory =>
	({
		steps: [step()],
		totalReward: 0.5,
		metadata: { agentName: "Bot", goalDescription: "profit" },
		metrics: { finalBalance: 100, finalPnL: 0 },
		scenarioId: "s1",
		agentId: "a1",
		trajectoryId: "t1",
		groupIndex: 0,
		...over,
	}) as unknown as Trajectory;

describe("toARTMessages", () => {
	it("emits a system + user + assistant message sequence", () => {
		const messages = toARTMessages(traj({}));
		expect(messages[0].role).toBe("system");
		expect(messages.some((m) => m.role === "user")).toBe(true);
		expect(messages.some((m) => m.role === "assistant")).toBe(true);
	});
});

describe("validateARTCompatibility", () => {
	it("accepts a well-formed trajectory; rejects no-steps / no-reward", () => {
		expect(validateARTCompatibility(traj({})).valid).toBe(true);
		expect(validateARTCompatibility(traj({ steps: [] })).valid).toBe(false);
		expect(
			validateARTCompatibility(traj({ totalReward: undefined as never })).valid,
		).toBe(false);
	});
});

describe("groupTrajectories", () => {
	it("buckets by scenarioId", () => {
		const groups = groupTrajectories([
			traj({ scenarioId: "s1" }),
			traj({ scenarioId: "s2" }),
			traj({ scenarioId: "s1" }),
		]);
		expect(groups).toHaveLength(2);
		expect(
			groups.find((g) => g.scenarioId === "s1")?.trajectories,
		).toHaveLength(2);
	});
});
