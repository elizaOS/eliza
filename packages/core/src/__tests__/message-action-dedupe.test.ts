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
		// umbrella — producing duplicate spawns on a single user turn.
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
});
