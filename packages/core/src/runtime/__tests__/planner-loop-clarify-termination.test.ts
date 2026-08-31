/**
 * One-pass clarifying-question termination under the required-tool gate.
 *
 * Live regression (tj-28a877e591e5f3, 2026-08-27): "create a mew event for
 * today" — Stage 1 marked the turn tool-required with a resolvable VIEWS
 * candidate, but the planner (correctly) had nothing to act on without more
 * input and drafted the clarifying REPLY "What's the event for?". The
 * required-tool gate treated that REPLY-only pass as a miss and re-planned
 * FOUR times (~13.7s, 4x planner latency + ~100 stacked prompt tokens per
 * pass), each pass re-drafting the identical question, before the
 * miss-budget exhaustion hatch shipped the very text pass 1 produced.
 *
 * A clarifying question is a terminal outcome by construction — the planner
 * is asking the user for input it needs before any tool can act, so a
 * corrective re-prompt cannot progress the turn. These tests pin:
 *   1. a REPLY-only clarify pass terminates after exactly ONE planner call
 *      (native tool-call lane and JSON no-tool-calls lane);
 *   2. legit multi-pass flows survive: tool call, then follow-up planning,
 *      then a terminal reply (including a post-tool question);
 *   3. identical rejected REPLY drafts never stack duplicate corrective
 *      events into the planner transcript (non-question answers keep the
 *      full corrective budget, but the retry instruction appears once);
 *   4. coding builds keep the corrective budget — a premature question is
 *      still re-prompted there.
 */
import { describe, expect, it, vi } from "vitest";
import { runPlannerLoop } from "../planner-loop";

const CLARIFY_TEXT = "What's the event for?";

const replyToolCall = (id: string, text: string) => ({
	text: "",
	toolCalls: [{ id, name: "REPLY", arguments: { text } }],
});

describe("planner-loop clarifying-question termination", () => {
	it("terminates after ONE planner pass when a REPLY-only clarifying question hits the required-tool gate", async () => {
		// The live shape: every pass drafts the same clarifying REPLY. With the
		// one-pass termination the loop must never re-plan at all.
		const runtime = {
			useModel: vi.fn(async () => replyToolCall("reply-1", CLARIFY_TEXT)),
			logger: { warn: vi.fn() },
		};

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			tools: [{ name: "VIEWS", description: "Open a UI view." }],
			requireNonTerminalToolCall: true,
			config: { maxRequiredToolMisses: 3 },
			executeToolCall: vi.fn(),
			evaluate: vi.fn(),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(CLARIFY_TEXT);
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
	});

	it("terminates after ONE planner pass on a JSON-lane clarify with no tool calls", async () => {
		const runtime = {
			useModel: vi.fn(
				async () =>
					`{"thought":"Need the event details first.","toolCalls":[],"messageToUser":"Which calendar should I put it on?"}`,
			),
			logger: { warn: vi.fn() },
		};

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			tools: [{ name: "VIEWS", description: "Open a UI view." }],
			requireNonTerminalToolCall: true,
			config: { maxRequiredToolMisses: 3 },
			executeToolCall: vi.fn(),
			evaluate: vi.fn(),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe("Which calendar should I put it on?");
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
	});

	it("still runs the tool-then-reply flow: a post-tool clarifying REPLY delivers without re-planning misses", async () => {
		// Legit multi-pass: pass 1 calls the required tool, the evaluator asks
		// to continue, pass 2 answers with a (question-shaped) terminal REPLY.
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "views-1",
							name: "VIEWS",
							arguments: { action: "show", view: "calendar" },
						},
					],
				})
				.mockResolvedValueOnce(
					replyToolCall(
						"reply-1",
						"Calendar is open. What time should it start?",
					),
				),
			logger: { warn: vi.fn() },
		};
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: "calendar view opened",
		}));
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "CONTINUE" as const,
			thought: "Still need the start time from the owner.",
		}));

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			tools: [{ name: "VIEWS", description: "Open a UI view." }],
			requireNonTerminalToolCall: true,
			config: { maxRequiredToolMisses: 3 },
			executeToolCall,
			evaluate,
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(
			"Calendar is open. What time should it start?",
		);
		expect(executeToolCall).toHaveBeenCalledTimes(1);
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
	});

	it("never stacks duplicate identical REPLY drafts into the planner transcript across misses", async () => {
		// Non-question identical answers keep the pinned full corrective budget
		// (see "keeps the full corrective budget for the same shape without
		// heuristic evidence"), but the corrective retry instruction — and with
		// it the rejected draft — must enter the transcript exactly ONCE, not
		// once per miss.
		const capturedMessageDumps: string[] = [];
		const runtime = {
			useModel: vi.fn(
				async (
					_modelType: unknown,
					params: { messages?: Array<{ content?: unknown }> },
				) => {
					capturedMessageDumps.push(JSON.stringify(params.messages ?? []));
					return replyToolCall("reply-1", "The answer is 391.");
				},
			),
			logger: { warn: vi.fn() },
		};

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			tools: [{ name: "WEB_FETCH", description: "Fetch a URL." }],
			requireNonTerminalToolCall: true,
			config: { maxRequiredToolMisses: 3 },
			executeToolCall: vi.fn(),
			evaluate: vi.fn(),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe("The answer is 391.");
		// Full corrective budget still applies to non-question answers.
		expect(runtime.useModel).toHaveBeenCalledTimes(4);
		// The final planner call's prompt carries the corrective instruction
		// exactly once — misses 2 and 3 re-drafted the identical REPLY and must
		// not have stacked duplicate copies.
		const finalDump = capturedMessageDumps[capturedMessageDumps.length - 1];
		const occurrences =
			finalDump?.split("previous planner response was not valid").length ?? 0;
		expect(occurrences - 1).toBe(1);
	});

	it("re-appends the corrective instruction when the rejected draft CHANGES between misses", async () => {
		// The dedup is identity-scoped: a planner wandering between different
		// rejected answers still records each distinct draft.
		const answers = [
			"The answer is 391.",
			"It comes to 391.",
			"391 total.",
			"Final answer: 391.",
		];
		let call = 0;
		const capturedMessageDumps: string[] = [];
		const runtime = {
			useModel: vi.fn(
				async (
					_modelType: unknown,
					params: { messages?: Array<{ content?: unknown }> },
				) => {
					capturedMessageDumps.push(JSON.stringify(params.messages ?? []));
					return replyToolCall(
						`reply-${call}`,
						answers[Math.min(call++, answers.length - 1)] ?? "",
					);
				},
			),
			logger: { warn: vi.fn() },
		};

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			tools: [{ name: "WEB_FETCH", description: "Fetch a URL." }],
			requireNonTerminalToolCall: true,
			config: { maxRequiredToolMisses: 3 },
			executeToolCall: vi.fn(),
			evaluate: vi.fn(),
		});

		expect(result.status).toBe("finished");
		expect(runtime.useModel).toHaveBeenCalledTimes(4);
		const finalDump = capturedMessageDumps[capturedMessageDumps.length - 1];
		const occurrences =
			finalDump?.split("previous planner response was not valid").length ?? 0;
		// Three misses preceded the final call, each with a distinct draft.
		expect(occurrences - 1).toBe(3);
	});

	it("keeps the corrective budget in coding mode: a premature question is still re-prompted", async () => {
		const prevMisses = process.env.ELIZA_CODING_MAX_REQUIRED_TOOL_MISSES;
		process.env.ELIZA_CODING_MAX_REQUIRED_TOOL_MISSES = "1";
		try {
			const question = "Which framework do you want me to use?";
			const runtime = {
				useModel: vi.fn(async () => replyToolCall("reply-1", question)),
				logger: { warn: vi.fn() },
			};

			const result = await runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				codingMode: true,
				tools: [{ name: "FILE", description: "Write a file." }],
				config: { maxRequiredToolMisses: 1 },
				executeToolCall: vi.fn(),
				evaluate: vi.fn(),
			});

			expect(result.status).toBe("finished");
			// The exhaustion hatch still ships the genuinely blocking question,
			// but only AFTER the corrective retry — coding builds keep their
			// chance to convert a narrator into FILE/SHELL work.
			expect(result.finalMessage).toBe(question);
			expect(runtime.useModel).toHaveBeenCalledTimes(2);
		} finally {
			if (prevMisses === undefined)
				delete process.env.ELIZA_CODING_MAX_REQUIRED_TOOL_MISSES;
			else process.env.ELIZA_CODING_MAX_REQUIRED_TOOL_MISSES = prevMisses;
		}
	});
});
