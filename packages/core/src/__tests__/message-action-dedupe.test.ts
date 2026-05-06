import { describe, expect, it, vi } from "vitest";
import { stripReplyWhenActionOwnsTurn } from "../services/message.ts";
import type { IAgentRuntime } from "../types/runtime";

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
	} as unknown as Pick<IAgentRuntime, "actions" | "logger">;
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
