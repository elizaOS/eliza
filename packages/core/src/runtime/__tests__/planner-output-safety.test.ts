import { describe, expect, it } from "vitest";
import { parsePlannerOutput, looksLikeEvaluatorEnvelopeJson } from "../planner-loop";

describe("planner output user-visible safety", () => {
	it("consumes evaluator control JSON from native text instead of exposing it as reply text", () => {
		const output = parsePlannerOutput({
			text: JSON.stringify({
				success: false,
				decision: "CONTINUE",
				thought: "Memory search returned 0 results; continue planning.",
			}),
			toolCalls: [],
		});

		expect(output.messageToUser).toBeUndefined();
		expect(output.toolCalls).toEqual([]);
		expect(output.raw).toMatchObject({
			success: false,
			decision: "CONTINUE",
		});
	});

	it("does not use evaluator envelope JSON as visible text when native tool calls are present", () => {
		const output = parsePlannerOutput({
			text: '{"success":false,"decision":"CONTINUE","thought":"Need a tool result."}',
			toolCalls: [
				{
					id: "tool-1",
					name: "LOOKUP",
					arguments: { query: "waifu wind-down" },
				},
			],
		});

		expect(output.messageToUser).toBeUndefined();
		expect(output.toolCalls).toHaveLength(1);
		expect(output.toolCalls[0]?.name).toBe("LOOKUP");
	});

	it("classifies raw evaluator envelopes as unsafe user-visible text", () => {
		expect(
			looksLikeEvaluatorEnvelopeJson(
				'{"success":false,"decision":"CONTINUE","thought":"internal"}',
			),
		).toBe(true);
		expect(looksLikeEvaluatorEnvelopeJson('{"decision":"approve"}')).toBe(false);
	});
});
