/** Surrogate safety for formatTrajectoryForPrompt: userPrompt and response truncation must never emit lone surrogates. */
import { describe, expect, test } from "vitest";
import {
	formatTrajectoryForPrompt,
	type SkillTrajectory,
} from "./trajectory-evaluator-utils.ts";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return true;
}

describe("formatTrajectoryForPrompt surrogate safety", () => {
	test("emoji at 599 boundary backs off to 599 without lone surrogate at 600 cap in userPrompt", () => {
		const traj: SkillTrajectory = {
			trajectoryId: "traj-1",
			agentId: "agent-1",
			startTime: Date.now(),
			steps: [
				{
					timestamp: Date.now(),
					llmCalls: [
						{
							userPrompt: `${"a".repeat(599)}🦊${"b".repeat(50)}`,
							purpose: "planning",
						},
					],
				},
			],
		};
		const out = formatTrajectoryForPrompt(traj);
		expect(isWellFormed(out)).toBe(true);
		expect(() => JSON.stringify({ prompt: out })).not.toThrow();
		expect(out.includes("USER:")).toBe(true);
	});

	test("fitting emoji ending at 600 kept intact in response", () => {
		const traj: SkillTrajectory = {
			trajectoryId: "traj-2",
			agentId: "agent-1",
			startTime: Date.now(),
			steps: [
				{
					timestamp: Date.now(),
					llmCalls: [
						{
							response: `${"a".repeat(598)}🦊`,
							purpose: "execution",
						},
					],
				},
			],
		};
		const out = formatTrajectoryForPrompt(traj);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("🦊")).toBe(true);
	});

	test("short prompt with emoji passes through untouched", () => {
		const traj: SkillTrajectory = {
			trajectoryId: "traj-3",
			agentId: "agent-1",
			startTime: Date.now(),
			steps: [
				{
					timestamp: Date.now(),
					llmCalls: [
						{
							userPrompt: "Help me find a fox 🦊",
							response: "Found the fox 🦊!",
						},
					],
				},
			],
		};
		const out = formatTrajectoryForPrompt(traj);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("Help me find a fox 🦊")).toBe(true);
		expect(out.includes("Found the fox 🦊!")).toBe(true);
	});

	test("lone high surrogate is sanitized before truncation", () => {
		const traj: SkillTrajectory = {
			trajectoryId: "traj-4",
			agentId: "agent-1",
			startTime: Date.now(),
			steps: [
				{
					timestamp: Date.now(),
					llmCalls: [
						{
							userPrompt: `bad \ud800 surrogate ${"x".repeat(700)}`,
						},
					],
				},
			],
		};
		const out = formatTrajectoryForPrompt(traj);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("\ud800")).toBe(false);
	});

	test("sweep 595..605 emoji offsets at 600 cap all stay well-formed", () => {
		const fox = "🦊";
		for (let n = 595; n <= 605; n++) {
			const traj: SkillTrajectory = {
				trajectoryId: `traj-sweep-${n}`,
				agentId: "agent-1",
				startTime: Date.now(),
				steps: [
					{
						timestamp: Date.now(),
						llmCalls: [
							{
								userPrompt: `${"a".repeat(n)}${fox}${"b".repeat(50)}`,
								response: `${"c".repeat(n)}${fox}${"d".repeat(50)}`,
							},
						],
					},
				],
			};
			const out = formatTrajectoryForPrompt(traj);
			expect(isWellFormed(out)).toBe(true);
			expect(() => JSON.stringify({ prompt: out })).not.toThrow();
		}
	});
});
