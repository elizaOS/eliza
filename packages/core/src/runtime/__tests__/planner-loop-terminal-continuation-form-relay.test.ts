/**
 * Covers missing-input turns whose real reply is the MODEL's own output — a
 * grammar-valid [FORM] or a user-directed prose ask — rather than a
 * structurally-marked tool result (#15918): terminal-continuation-limit
 * recovery when the evaluator CONTINUE-loops past rule 19, and final-message
 * precedence when it FINISHes with a widget reply the confirmation-question
 * relay used to drop. Deterministic: vitest-mocked `useModel` + injected
 * evaluator replaying the live gpt-oss-120b trajectory shapes; no live model.
 */
import { describe, expect, it, vi } from "vitest";
import type { TrajectoryLimitExceeded } from "../limits";
import { runPlannerLoop } from "../planner-loop";

// Grammar-valid [FORM] mirroring the live run-4 planner terminal output: the
// form that collects exactly the fields the clarify tool asked for.
const FORM_REPLY = [
	"Happy to set that reminder — fill this in:",
	"[FORM]",
	'{"title":"Create Reminder","submitLabel":"Create","fields":[{"name":"title","type":"text","label":"Report Name","required":true},{"name":"date","type":"date","label":"Date","required":true},{"name":"time","type":"time","label":"Time","required":true}]}',
	"[/FORM]",
].join("\n");

const PROSE_ASK =
	"I'm ready to set the reminder. Please provide the report name, the date, and the time you'd like to be reminded.";

// Success-shaped, marker-less clarify result — the live OWNER_REMINDERS
// empty-args shape: user-directed question in `.text`, no `userFacingText`,
// no requiresConfirmation/awaitingUserInput/noop marker.
const MARKERLESS_CLARIFY_RESULT = {
	success: true,
	text: "Sure! Please tell me the report name, the date, and the time you'd like to be reminded.",
	data: { actionName: "OWNER_REMINDERS" },
};

function plannerEmitsToolCallThenTerminalTexts(terminalTexts: string[]) {
	let useModel = vi.fn().mockResolvedValueOnce({
		text: "",
		toolCalls: [
			{
				id: "call-1",
				name: "OWNER_REMINDERS",
				arguments: { action: "create" },
			},
		],
		usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
	});
	for (const text of terminalTexts) {
		useModel = useModel.mockResolvedValueOnce({
			text,
			usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
		});
	}
	return { useModel };
}

// The live failure shape: the evaluator ignores its own missing-input=>FINISH
// rule and keeps burning terminal-only continuations.
function evaluatorContinueLoops() {
	return vi.fn(async () => ({
		success: false,
		decision: "CONTINUE" as const,
		thought:
			"Awaiting user to provide report name, date, and time to create the reminder.",
	}));
}

describe("planner-loop - terminal continuation [FORM]/ask relay (#15918)", () => {
	it("relays the planner's grammar-valid [FORM] when the evaluator CONTINUE-loops past it (live run-4 shape)", async () => {
		// Trajectory: marker-less clarify tool result → planner [FORM] → CONTINUE
		// → planner prose → CONTINUE → limit. The FORM emitted two iterations
		// before the limit must be found by the reverse scan.
		const runtime = plannerEmitsToolCallThenTerminalTexts([
			FORM_REPLY,
			PROSE_ASK,
		]);
		const executeToolCall = vi.fn(async () => MARKERLESS_CLARIFY_RESULT);
		const evaluate = evaluatorContinueLoops();

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			config: { maxTerminalOnlyContinuations: 1 },
			executeToolCall,
			evaluate,
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(FORM_REPLY);
		expect(executeToolCall).toHaveBeenCalledTimes(1);
		expect(evaluate).toHaveBeenCalledTimes(3);
		expect(runtime.useModel).toHaveBeenCalledTimes(3);
	});

	it("prefers the planner's [FORM] over a confirmation-required tool question (live run-1 shape)", async () => {
		// The tool's requiresConfirmation prose question is what the FORM
		// refines — relaying the question instead of the form discards the
		// model's actual reply.
		const runtime = plannerEmitsToolCallThenTerminalTexts([FORM_REPLY]);
		const executeToolCall = vi.fn(async () => ({
			success: false,
			text: "Sure! Could you tell me the report name, the day, and the time you'd like the reminder?",
			data: {
				error: "MISSING_DEFINITION_FIELD",
				requiresConfirmation: true,
			},
		}));
		const evaluate = evaluatorContinueLoops();

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			config: { maxTerminalOnlyContinuations: 0 },
			executeToolCall,
			evaluate,
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(FORM_REPLY);
	});

	it("relays the planner's user-directed prose ask when the clarify result carries no structured marker (live run-5 shape)", async () => {
		const runtime = plannerEmitsToolCallThenTerminalTexts([PROSE_ASK]);
		const executeToolCall = vi.fn(async () => MARKERLESS_CLARIFY_RESULT);
		const evaluate = evaluatorContinueLoops();

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			config: { maxTerminalOnlyContinuations: 0 },
			executeToolCall,
			evaluate,
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(PROSE_ASK);
	});

	it("relays a trailing-question ask only when it addresses the user", async () => {
		const runtime = plannerEmitsToolCallThenTerminalTexts([
			"What time would you like the reminder?",
		]);
		const executeToolCall = vi.fn(async () => MARKERLESS_CLARIFY_RESULT);
		const evaluate = evaluatorContinueLoops();

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			config: { maxTerminalOnlyContinuations: 0 },
			executeToolCall,
			evaluate,
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe("What time would you like the reminder?");
	});

	it("still throws when the terminal text is deliberation, not a user-directed ask", async () => {
		for (const deliberation of [
			"We should wait for the sub-agent result before replying.",
			"Which tool should I use for reminders?",
		]) {
			const runtime = plannerEmitsToolCallThenTerminalTexts([deliberation]);
			const executeToolCall = vi.fn(async () => MARKERLESS_CLARIFY_RESULT);
			const evaluate = evaluatorContinueLoops();

			await expect(
				runPlannerLoop({
					runtime,
					context: { id: "ctx" },
					config: { maxTerminalOnlyContinuations: 0 },
					executeToolCall,
					evaluate,
				}),
			).rejects.toMatchObject({
				kind: "terminal_only_continuations",
			} satisfies Partial<TrajectoryLimitExceeded>);
		}
	});

	it("does not relay a malformed widget block through the prose-ask side door", async () => {
		// The strict parse yields zero blocks for this text, so it is not a
		// widget candidate; the ask gate must not ship the broken markup as
		// prose either, despite the ask marker.
		const runtime = plannerEmitsToolCallThenTerminalTexts([
			"Please provide a time below.\n[FORM]\nnot-json\n[/FORM]",
		]);
		const executeToolCall = vi.fn(async () => MARKERLESS_CLARIFY_RESULT);
		const evaluate = evaluatorContinueLoops();

		await expect(
			runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				config: { maxTerminalOnlyContinuations: 0 },
				executeToolCall,
				evaluate,
			}),
		).rejects.toMatchObject({
			kind: "terminal_only_continuations",
		} satisfies Partial<TrajectoryLimitExceeded>);
	});

	it("delivers a FINISH [FORM] reply over the tool's missing-input confirmation question", async () => {
		// Live 5-run shape on current develop: the evaluator honors rule 19 and
		// FINISHes with a grammar-valid [FORM] in messageToUser, but the final-
		// message precedence used to drop it for the tool's requiresConfirmation
		// prose question.
		const formFinish = `I can set that up — details below:\n${FORM_REPLY}`;
		const runtime = plannerEmitsToolCallThenTerminalTexts([]);
		const executeToolCall = vi.fn(async () => ({
			success: false,
			text: "Sure! Please tell me the report name, the day, and the time you'd like the reminder.",
			data: {
				error: "MISSING_DEFINITION_FIELD",
				missingField: "schedule",
				requiresConfirmation: true,
			},
		}));
		const evaluate = vi.fn(async () => ({
			success: false,
			decision: "FINISH" as const,
			thought: "Missing input; surface the collection form.",
			messageToUser: formFinish,
		}));

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(formFinish);
	});

	it("keeps a lifeDraft confirm preview ahead of a widget FINISH reply", async () => {
		// Action-owned draft-confirm copy must reach the user verbatim so they
		// approve the exact draft — a FORM must not displace it into a re-ask.
		const preview =
			"I can save this as a goal. Success looks like walking three times a week. Confirm and I'll save it.";
		const runtime = plannerEmitsToolCallThenTerminalTexts([]);
		const executeToolCall = vi.fn(async () => ({
			success: false,
			text: preview,
			data: {
				requiresConfirmation: true,
				lifeDraft: {
					operation: "create_goal",
					request: { title: "Leave the apartment more" },
				},
			},
		}));
		const evaluate = vi.fn(async () => ({
			success: false,
			decision: "FINISH" as const,
			thought: "Draft ready; asking for confirmation.",
			messageToUser: `Fill this in to confirm:\n${FORM_REPLY}`,
		}));

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(preview);
	});

	it("keeps the structured tool-result relays ahead of the prose ask", async () => {
		// A noop-marked clarification is a designed shape; the weaker prose-ask
		// heuristic must not preempt it.
		const clarification =
			"Which deadline should I use before I create that reminder?";
		const runtime = plannerEmitsToolCallThenTerminalTexts([PROSE_ASK]);
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: clarification,
			data: { noop: true },
		}));
		const evaluate = evaluatorContinueLoops();

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			config: { maxTerminalOnlyContinuations: 0 },
			executeToolCall,
			evaluate,
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(clarification);
	});
});
