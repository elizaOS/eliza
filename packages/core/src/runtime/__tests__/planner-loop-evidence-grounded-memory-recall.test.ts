/**
 * Evidence-grounded memory-recall guarantee: a finished planner turn whose
 * final reply denies having any stored record of a topic, while the SAME
 * turn's in-prompt FACTS evidence contains a stored fact about that topic,
 * must ship a grounded synthesis quoting the evidence (or the typed grounded
 * fallback) — never the fabricated denial. Pinned to the live incident
 * (2026-08-21, tj-8f5d420d19288f): the FACTS block carried "[durable.
 * preference conf=0.95] user's favorite planet is saturn" and the terminal
 * REPLY shipped "i don't have a record of a favorite planet for you
 * anymore." with zero tool calls. Deterministic — `useModel`,
 * `executeToolCall`, and `evaluate` are vitest mocks; no live model.
 */
import { describe, expect, it, vi } from "vitest";
import type { ContextObject } from "../../types/context-object";
import {
	contradictedMemoryRecallFallbackMessage,
	runPlannerLoop,
} from "../planner-loop";

type MockedMessages = {
	messages?: Array<{ role?: string; content?: unknown }>;
};

/** Text of the loop-composed instruction blocks fed to a given model call. */
function loopComposedInstructionText(
	useModel: ReturnType<typeof vi.fn>,
	callIndex: number,
	marker: string,
): string {
	const params = useModel.mock.calls[callIndex]?.[1] as
		| MockedMessages
		| undefined;
	return (params?.messages ?? [])
		.map((message) =>
			typeof message.content === "string" ? message.content : "",
		)
		.filter((content) => content.includes(marker))
		.join("\n");
}

// The byte-exact incident payloads (trajectory tj-8f5d420d19288f).
const INCIDENT_FABRICATED_REPLY =
	"i don't have a record of a favorite planet for you anymore.";
const INCIDENT_FACTS_TEXT =
	"Standing preferences the speaker has expressed (apply any that are relevant to this reply):\n" +
	"[durable.preference conf=0.95] user's favorite planet is saturn\n" +
	"[durable.preference conf=0.95] user's favorite color is orange\n" +
	"[durable.preference conf=0.95] user's favorite switch type is gateron oil kings\n" +
	"\n" +
	"What's currently happening for the speaker:\n" +
	"[current.uncategorized since 2026-08-26 conf=0.60] favorite planet is saturn";
const INCIDENT_EVIDENCE_LINE =
	"[durable.preference conf=0.95] user's favorite planet is saturn";

function contextWithFacts(factsText: string | undefined): ContextObject {
	return {
		id: "ctx",
		events: factsText
			? [
					{
						id: "provider:FACTS",
						type: "provider",
						source: "composeState",
						name: "FACTS",
						text: factsText,
					},
				]
			: [],
	};
}

function replyOnlyPlanner(replyText: string, synthesisText?: string) {
	const useModel = vi.fn().mockResolvedValueOnce({
		text: "",
		toolCalls: [
			{ id: "call-1", name: "REPLY", arguments: { text: replyText } },
		],
	});
	if (synthesisText !== undefined) {
		useModel.mockResolvedValueOnce({ text: synthesisText, toolCalls: [] });
	}
	return { useModel, executeToolCall: vi.fn() };
}

describe("evidence-grounded memory-recall guarantee", () => {
	it("replaces the incident's fabricated denial with the grounded synthesis", async () => {
		const grounded = "i do have that on file — your favorite planet is saturn.";
		const { useModel, executeToolCall } = replyOnlyPlanner(
			INCIDENT_FABRICATED_REPLY,
			grounded,
		);

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: contextWithFacts(INCIDENT_FACTS_TEXT),
			executeToolCall,
		});

		expect(executeToolCall).not.toHaveBeenCalled();
		expect(useModel).toHaveBeenCalledTimes(2);
		expect(result.finalMessage).toBe(grounded);

		// The forced-synthesis instruction quotes the stored-fact evidence
		// line and bans the denial.
		const instruction = loopComposedInstructionText(useModel, 1, "Stored fact");
		expect(instruction).toContain(INCIDENT_EVIDENCE_LINE);
		expect(instruction).toContain("Do not deny having the record");
	});

	it("leaves a denial alone when the FACTS evidence has no fact about the topic", async () => {
		const { useModel, executeToolCall } = replyOnlyPlanner(
			"i don't have a record of a dog's name for you.",
		);

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: contextWithFacts(INCIDENT_FACTS_TEXT),
			executeToolCall,
		});

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(result.finalMessage).toBe(
			"i don't have a record of a dog's name for you.",
		);
	});

	it("leaves a denial alone when the turn has no FACTS evidence at all", async () => {
		const { useModel, executeToolCall } = replyOnlyPlanner(
			INCIDENT_FABRICATED_REPLY,
		);

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: contextWithFacts(undefined),
			executeToolCall,
		});

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(result.finalMessage).toBe(INCIDENT_FABRICATED_REPLY);
	});

	it("stands down when a memory-store tool call succeeded this turn", async () => {
		// "forget my favorite planet" → successful MEMORY_DELETE → "no record
		// anymore" is HONEST: the turn-start FACTS block is legitimately stale.
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "MEMORY_DELETE",
						arguments: { action: "delete", query: "favorite planet" },
					},
				],
			})
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-2",
						name: "REPLY",
						arguments: { text: INCIDENT_FABRICATED_REPLY },
					},
				],
			});
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: 'Forgot 2 memory record(s) matching "favorite planet".',
		}));
		const evaluate = vi.fn(async () => ({
			success: false,
			decision: "CONTINUE" as const,
			thought: "only 1 tool operation(s) succeeded — continuing.",
		}));

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: contextWithFacts(INCIDENT_FACTS_TEXT),
			tools: [{ name: "MEMORY_DELETE", description: "Delete a memory." }],
			executeToolCall,
			evaluate,
		});

		expect(executeToolCall).toHaveBeenCalledTimes(1);
		expect(useModel).toHaveBeenCalledTimes(2);
		expect(result.finalMessage).toBe(INCIDENT_FABRICATED_REPLY);
	});

	it("still fires when the turn's only memory-store call FAILED", async () => {
		// The live chain: the prior MEMORY_DELETE failed MEMORY_AMBIGUOUS_QUERY
		// and deleted nothing, so a failed call must not stand the guarantee
		// down — the record still exists and the FACTS evidence proves it.
		const grounded =
			"actually, i still have it on file: your favorite planet is saturn.";
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "MEMORY_DELETE",
						arguments: { action: "delete", query: "favorite planet is saturn" },
					},
				],
			})
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-2",
						name: "REPLY",
						arguments: { text: INCIDENT_FABRICATED_REPLY },
					},
				],
			})
			.mockResolvedValueOnce({ text: grounded, toolCalls: [] });
		const executeToolCall = vi.fn(async () => ({
			success: false,
			text: 'Query "favorite planet is saturn" matches 2 distinct memories. Delete by memoryId instead.',
			data: { error: "MEMORY_AMBIGUOUS_QUERY" },
		}));
		const evaluate = vi.fn(async () => ({
			success: false,
			decision: "CONTINUE" as const,
			thought: "the delete failed — continuing.",
		}));

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: contextWithFacts(INCIDENT_FACTS_TEXT),
			tools: [{ name: "MEMORY_DELETE", description: "Delete a memory." }],
			executeToolCall,
			evaluate,
		});

		expect(result.finalMessage).toBe(grounded);
	});

	it("ships the typed grounded fallback when the synthesis returns nothing usable", async () => {
		const { useModel, executeToolCall } = replyOnlyPlanner(
			INCIDENT_FABRICATED_REPLY,
			"",
		);

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: contextWithFacts(INCIDENT_FACTS_TEXT),
			executeToolCall,
		});

		expect(useModel).toHaveBeenCalledTimes(2);
		// Byte-exact typed fallback quoting the stored fact.
		expect(result.finalMessage).toBe(
			"Correction — I do still have this on file: user's favorite planet is saturn",
		);
		expect(result.finalMessage).toBe(
			contradictedMemoryRecallFallbackMessage(
				"user's favorite planet is saturn",
			),
		);
	});

	it("ships the typed grounded fallback when the synthesis still denies the record", async () => {
		const { useModel, executeToolCall } = replyOnlyPlanner(
			INCIDENT_FABRICATED_REPLY,
			"sorry, i really don't have any record of a favorite planet for you.",
		);

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: contextWithFacts(INCIDENT_FACTS_TEXT),
			executeToolCall,
		});

		expect(useModel).toHaveBeenCalledTimes(2);
		expect(result.finalMessage).toBe(
			contradictedMemoryRecallFallbackMessage(
				"user's favorite planet is saturn",
			),
		);
	});
});
