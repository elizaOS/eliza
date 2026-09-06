/**
 * A question is not evidence that a required action can be skipped. Clarification
 * may finish directly when no action is required, or after the action handler
 * reports missing input. Required-action retries retain deduplicated context.
 */
import { describe, expect, it, vi } from "vitest";
import { runPlannerLoop } from "../planner-loop";

const CLARIFY_TEXT = "What's the event for?";

const replyToolCall = (id: string, text: string) => ({
	text: "",
	toolCalls: [{ id, name: "REPLY", arguments: { text } }],
});

describe("planner-loop clarifying-question termination", () => {
	it("terminates after one REPLY-only clarification when no action is required", async () => {
		const runtime = {
			useModel: vi.fn(async () => replyToolCall("reply-1", CLARIFY_TEXT)),
			logger: { warn: vi.fn() },
		};

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			tools: [{ name: "VIEWS", description: "Open a UI view." }],
			config: { maxRequiredToolMisses: 3 },
			executeToolCall: vi.fn(),
			evaluate: vi.fn(),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(CLARIFY_TEXT);
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
	});

	it("terminates after one JSON-lane clarification when no action is required", async () => {
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
			config: { maxRequiredToolMisses: 3 },
			executeToolCall: vi.fn(),
			evaluate: vi.fn(),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe("Which calendar should I put it on?");
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
	});

	it.each(["native", "json"] as const)(
		"does not let question-shaped prose bypass a required action in the %s lane",
		async (lane) => {
			for (const draft of [
				"The answer is 391?",
				"How about 391.",
				"Please confirm the answer is 391.",
				"The answer is 391.",
			]) {
				const runtime = {
					useModel: vi
						.fn()
						.mockResolvedValueOnce(
							lane === "native"
								? replyToolCall("reply-1", draft)
								: JSON.stringify({
										thought: "A tentative answer.",
										toolCalls: [],
										messageToUser: draft,
									}),
						)
						.mockResolvedValueOnce({
							text: "",
							toolCalls: [
								{
									id: "fetch-1",
									name: "WEB_FETCH",
									arguments: { url: "https://example.com/" },
								},
							],
						}),
					logger: { warn: vi.fn() },
				};
				const executeToolCall = vi.fn(async () => ({
					success: true,
					text: "The page gives the answer as 392.",
				}));
				const evaluate = vi.fn(async () => ({
					success: true,
					decision: "FINISH" as const,
					messageToUser: "The page says 392.",
				}));
				const result = await runPlannerLoop({
					runtime,
					context: { id: "ctx" },
					tools: [{ name: "WEB_FETCH", description: "Fetch a URL." }],
					requireNonTerminalToolCall: true,
					config: { maxRequiredToolMisses: 3 },
					executeToolCall,
					evaluate,
				});

				expect(executeToolCall, draft).toHaveBeenCalledExactlyOnceWith(
					{
						id: "fetch-1",
						name: "WEB_FETCH",
						params: { url: "https://example.com/" },
					},
					expect.objectContaining({ iteration: 2 }),
				);
				expect(runtime.useModel, draft).toHaveBeenCalledTimes(2);
				expect(result.finalMessage, draft).toBe("The page says 392.");
			}
		},
	);

	it.each([
		["native", "awaitingUserInput"],
		["native", "missingField"],
		["json", "awaitingUserInput"],
		["json", "missingField"],
	] as const)(
		"retries a %s question through the handler, then relays its %s clarification without replay",
		async (lane, marker) => {
			const intent = "Create an event today.";
			const parameters = { action: "create", intent };
			const clarification = "What should the event be called?";
			const reply = (id: string, text: string) =>
				lane === "native"
					? replyToolCall(id, text)
					: JSON.stringify({ toolCalls: [], messageToUser: text });
			const runtime = {
				useModel: vi
					.fn()
					.mockResolvedValueOnce(reply("premature-reply", CLARIFY_TEXT))
					.mockResolvedValueOnce(
						lane === "native"
							? {
									text: "",
									toolCalls: [
										{
											id: "calendar-1",
											name: "CALENDAR",
											arguments: parameters,
										},
									],
								}
							: JSON.stringify({
									toolCalls: [
										{ id: "calendar-1", name: "CALENDAR", args: parameters },
									],
								}),
					)
					.mockResolvedValueOnce(reply("clarification-reply", clarification)),
				logger: { warn: vi.fn() },
			};
			// Missing input is a handler result, not evidence of a mutation. Leave
			// user-facing text to the next planner pass to exercise the safe relay.
			const executeToolCall = vi.fn(async () => ({
				success: true,
				text: "",
				data:
					marker === "awaitingUserInput"
						? { awaitingUserInput: true }
						: { missingField: "title" },
			}));
			const evaluate = vi.fn(async () => ({
				success: true,
				decision: "CONTINUE" as const,
				thought: "The owner must supply the event title.",
			}));
			const result = await runPlannerLoop({
				runtime,
				context: {
					id: "ctx",
					events: [
						{
							id: "user-request",
							type: "message",
							message: { role: "user", content: intent },
						},
					],
				},
				tools: [{ name: "CALENDAR", description: "Manage calendar events." }],
				requireNonTerminalToolCall: true,
				config: { maxRequiredToolMisses: 3, maxTerminalOnlyContinuations: 0 },
				executeToolCall,
				evaluate,
			});

			expect(executeToolCall).toHaveBeenCalledExactlyOnceWith(
				{
					id: "calendar-1",
					name: "CALENDAR",
					params: { action: "create", intent },
				},
				expect.objectContaining({ iteration: 2 }),
			);
			expect(runtime.useModel).toHaveBeenCalledTimes(3);
			expect(result.status).toBe("finished");
			expect(result.finalMessage).toBe(clarification);
			expect(
				result.trajectory.steps.filter((step) => step.toolCall),
			).toHaveLength(1);
		},
	);

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
