/**
 * Exercises the message service's planner-action de-duplication
 * (stripReplyWhenActionOwnsTurn) and sub-planner result collapse
 * (subPlannerResultToPlannerToolResult): REPLY/alias dedupe, continueChain
 * propagation from a terminal sub-action, and multi-step aggregation into the
 * umbrella result. Runs against a stub runtime (actions + logger) — fully
 * deterministic.
 */
import { describe, expect, it, vi } from "vitest";
import {
	stripReplyWhenActionOwnsTurn,
	subPlannerResultToPlannerToolResult,
} from "../services/message.ts";
import type { IAgentRuntime } from "../types/runtime";

type SubResult = Parameters<typeof subPlannerResultToPlannerToolResult>[0];

function subResult(
	lastStepResult: Record<string, unknown> | undefined,
	finalMessage?: string,
): SubResult {
	return {
		status: "finished",
		finalMessage,
		trajectory: {
			steps: lastStepResult ? [{ iteration: 1, result: lastStepResult }] : [],
		},
	} as unknown as SubResult;
}

function runtime(
	actions: Array<{ name: string; similes?: string[] }> = [],
): Pick<IAgentRuntime, "actions" | "logger"> {
	return {
		actions,
		logger: {
			info: vi.fn(),
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
	} as Pick<IAgentRuntime, "actions" | "logger">;
}

describe("stripReplyWhenActionOwnsTurn", () => {
	it("collapses duplicate REPLY planner actions before execution", () => {
		expect(stripReplyWhenActionOwnsTurn(runtime(), ["REPLY", "REPLY"])).toEqual(
			["REPLY"],
		);
	});

	it("dedupes aliases against the registered canonical action name", () => {
		expect(
			stripReplyWhenActionOwnsTurn(
				runtime([{ name: "REPLY", similes: ["RESPOND"] }]),
				["RESPOND", "REPLY"],
			),
		).toEqual(["RESPOND"]);
	});
});

describe("subPlannerResultToPlannerToolResult", () => {
	it("propagates continueChain:false from the terminal sub-action", () => {
		// A fire-and-forget sub-action (e.g. TASKS_SPAWN_AGENT) returns
		// continueChain:false. Without propagating it through the umbrella
		// result, the parent planner loop evaluates CONTINUE and re-runs the
		// umbrella, producing duplicate spawns on a single user turn.
		const result = subPlannerResultToPlannerToolResult(
			subResult(
				{ success: true, text: "On it.", continueChain: false },
				"On it.",
			),
		);
		expect(result.continueChain).toBe(false);
		expect(result.success).toBe(true);
	});

	it("leaves continueChain undefined when the sub-action did not set it", () => {
		const result = subPlannerResultToPlannerToolResult(
			subResult({ success: true, text: "done" }, "done"),
		);
		expect(result.continueChain).toBeUndefined();
	});

	it("handles an empty sub-trajectory without throwing", () => {
		const result = subPlannerResultToPlannerToolResult(subResult(undefined));
		expect(result.continueChain).toBeUndefined();
		expect(result.success).toBe(true);
	});

	// Regression for elizaOS/eliza#8007: a multi-step sub-planner collapse must
	// surface EVERY executed sub-step to the parent loop, not only the terminal
	// one, so the outer planner can see which ops already succeeded and advance
	// instead of re-running the umbrella action from the first step.
	it("aggregates all sub-steps into the diagnostic text and data", () => {
		const multiStep = {
			status: "finished",
			finalMessage: "Opened a PR for hello-world.",
			trajectory: {
				steps: [
					{
						iteration: 1,
						toolCall: { name: "provision_workspace" },
						result: { success: true, text: "workspace ws-1 ready" },
					},
					{
						iteration: 2,
						toolCall: { name: "spawn_agent" },
						result: { success: true, text: "spawned agent a-1" },
					},
					{
						iteration: 3,
						toolCall: { name: "submit_workspace" },
						result: { success: false, error: "no diff to submit" },
					},
				],
			},
		} as unknown as SubResult;

		const result = subPlannerResultToPlannerToolResult(multiStep);

		// The diagnostic text (what the parent planner reasons over) carries the
		// full progression, not just the terminal step.
		expect(result.text).toContain("provision_workspace");
		expect(result.text).toContain("spawn_agent");
		expect(result.text).toContain("submit_workspace");
		expect(result.text).toContain("OK");
		expect(result.text).toContain("FAIL");

		// The user-facing text stays the synthesized final message.
		expect(result.userFacingText).toBe("Opened a PR for hello-world.");

		// Structured sub-step data lets downstream action context see which ops
		// already completed.
		expect(result.data?.completedSubActions).toEqual([
			"provision_workspace",
			"spawn_agent",
		]);
		expect(Array.isArray(result.data?.subSteps)).toBe(true);
		expect((result.data?.subSteps as unknown[]).length).toBe(3);
	});
});
