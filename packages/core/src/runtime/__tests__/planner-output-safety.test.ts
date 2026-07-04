/**
 * Guards `parsePlannerOutput` user-visible safety: evaluator/control envelope
 * JSON emitted in the native text channel is consumed as control data (never
 * shown as a reply), while a genuine user-requested JSON object round-trips to a
 * visible message. Pure unit tests — no model or runtime.
 */
import { describe, expect, it } from "vitest";
import {
	looksLikeEvaluatorEnvelopeJson,
	parsePlannerOutput,
} from "../planner-loop";

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

	it("preserves a bare user-requested JSON object reply as a visible message", () => {
		// A non-envelope JSON object (no planner/evaluator field) is a legitimate
		// reply — e.g. the user asked the agent to produce `{"foo":"bar"}`. It must
		// NOT be silently consumed as control data; it round-trips to a visible
		// messageToUser.
		const json = '{"foo":"bar"}';
		const output = parsePlannerOutput({
			text: json,
			toolCalls: [],
		});

		expect(output.messageToUser).toBe(json);
		expect(output.toolCalls).toEqual([]);
	});

	it("classifies raw evaluator envelopes as control JSON, plain JSON as not", () => {
		expect(
			looksLikeEvaluatorEnvelopeJson(
				'{"success":false,"decision":"CONTINUE","thought":"internal"}',
			),
		).toBe(true);
		expect(looksLikeEvaluatorEnvelopeJson('{"decision":"approve"}')).toBe(
			false,
		);
		expect(looksLikeEvaluatorEnvelopeJson('{"foo":"bar"}')).toBe(false);
		expect(
			looksLikeEvaluatorEnvelopeJson(
				'{"route":"NEXT_RECOMMENDED","recommendedToolCallId":"abc"}',
			),
		).toBe(true);
	});
});
