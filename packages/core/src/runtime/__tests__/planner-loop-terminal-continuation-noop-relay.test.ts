/**
 * Covers safe terminal-continuation recovery for tools waiting on owner input,
 * using deterministic model and evaluator doubles.
 */
import { describe, expect, it, vi } from "vitest";
import type { TrajectoryLimitExceeded } from "../limits";
import { runPlannerLoop } from "../planner-loop";

const REMINDER_FORM = [
	"[FORM]",
	JSON.stringify({
		title: "Create reminder",
		fields: [
			{ name: "title", type: "text", label: "Report name" },
			{ name: "date", type: "date", label: "Date" },
			{ name: "time", type: "time", label: "Time" },
		],
	}),
	"[/FORM]",
].join("\n");

function plannerEmitsNoopThenTerminalText(terminalText: string) {
	return {
		useModel: vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "OWNER_GOALS",
						arguments: { action: "create_goal" },
					},
				],
				usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
			})
			.mockResolvedValueOnce({
				text: terminalText,
				usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
			}),
	};
}

function evaluatorRequestsAnotherIteration() {
	return vi.fn(async () => ({
		success: true,
		decision: "CONTINUE" as const,
		thought: "The previous result needs a final response.",
	}));
}

function evaluatorContinuesThenFinishes(messageToUser: string) {
	return vi
		.fn()
		.mockResolvedValueOnce({
			success: true,
			decision: "CONTINUE" as const,
			thought: "The owner still needs an interaction.",
		})
		.mockResolvedValueOnce({
			success: true,
			decision: "FINISH" as const,
			thought: "The form collects the missing fields.",
			messageToUser,
		});
}

describe("planner-loop - terminal continuation missing-input relay", () => {
	it("finishes with a grammar-valid planner form when the evaluator continues past missing input", async () => {
		const toolQuestion =
			"Please tell me the report name, date, and time before I create the reminder.";
		const runtime = plannerEmitsNoopThenTerminalText(REMINDER_FORM);
		const executeToolCall = vi.fn(async () => ({
			success: false,
			text: toolQuestion,
			userFacingText: toolQuestion,
			data: {
				missingField: "title",
				requiresConfirmation: true,
			},
		}));
		const evaluate = evaluatorRequestsAnotherIteration();

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(REMINDER_FORM);
		expect(executeToolCall).toHaveBeenCalledTimes(1);
		expect(evaluate).toHaveBeenCalledTimes(2);
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
	});

	it("relays a safe planner clarification when missingField is the only awaiting-input marker", async () => {
		const clarification =
			"Please provide the report name, date, and time before I create the reminder.";
		const runtime = plannerEmitsNoopThenTerminalText(clarification);
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: "clarification required",
			data: {
				missingField: "title",
			},
		}));
		const evaluate = evaluatorRequestsAnotherIteration();

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

	it("rejects unsafe planner text even when the tool marks a missing field", async () => {
		const runtime = plannerEmitsNoopThenTerminalText(
			"I need to call OWNER_REMINDERS again with guessed title and schedule before answering.",
		);
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: "internal clarification state",
			data: {
				missingField: "title",
			},
		}));
		const evaluate = evaluatorRequestsAnotherIteration();

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

	it("relays a successful noop action's clarification when terminal-only continuation exhaustion would otherwise discard it", async () => {
		const clarification =
			"What would success look like for you: completing the 5K in a target time, distance, or consistency goal?";
		const runtime = plannerEmitsNoopThenTerminalText(
			"I need one more detail before I can set that goal.",
		);
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: clarification,
			data: {
				noop: true,
				error: "NOOP_GOAL_UNGROUNDED",
				suggestedOperation: "create_goal",
			},
		}));
		const evaluate = evaluatorRequestsAnotherIteration();

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			config: { maxTerminalOnlyContinuations: 0 },
			executeToolCall,
			evaluate,
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(clarification);
		expect(executeToolCall).toHaveBeenCalledTimes(1);
		expect(evaluate).toHaveBeenCalledTimes(2);
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
	});

	it("does not leak diagnostic text when the successful tool lacks the noop marker", async () => {
		const shellLog =
			"$ cat secrets.txt\nexit 0\ncwd=/home/milady\nAWS_SECRET=leak-me";
		const runtime = plannerEmitsNoopThenTerminalText(
			"I need to call SHELL again before answering.",
		);
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: shellLog,
		}));
		const evaluate = evaluatorRequestsAnotherIteration();

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

	it("accepts the noop marker when ActionResult values were nested under data.values", async () => {
		const clarification =
			"Which deadline should I use before I create that reminder?";
		const runtime = plannerEmitsNoopThenTerminalText(
			"I need to keep working on the reminder.",
		);
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: clarification,
			data: {
				values: {
					noop: true,
				},
			},
		}));
		const evaluate = evaluatorRequestsAnotherIteration();

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

	it("relays a confirmation-required preview instead of exhausting terminal continuations", async () => {
		const preview =
			"I can save this as a goal. Success looks like walking around the block three times a week. Confirm and I'll save it.";
		const runtime = plannerEmitsNoopThenTerminalText(
			"Does this look right before I save it?",
		);
		const executeToolCall = vi.fn(async () => ({
			success: false,
			text: preview,
			data: {
				deferred: true,
				saved: false,
				requiresConfirmation: true,
				lifeDraft: {
					operation: "create_goal",
					request: { title: "Leave the apartment more" },
				},
			},
		}));
		const evaluate = evaluatorRequestsAnotherIteration();

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			config: { maxTerminalOnlyContinuations: 0 },
			executeToolCall,
			evaluate,
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(preview);
		expect(executeToolCall).toHaveBeenCalledTimes(1);
		expect(evaluate).toHaveBeenCalledTimes(2);
	});

	it("keeps an action-owned confirmation preview ahead of an unrelated planner form", async () => {
		const preview =
			"I can save this reminder for Friday at 9 AM. Confirm and I'll create it.";
		const runtime = plannerEmitsNoopThenTerminalText(REMINDER_FORM);
		const executeToolCall = vi.fn(async () => ({
			success: false,
			text: preview,
			userFacingText: preview,
			data: {
				requiresConfirmation: true,
				lifeDraft: {
					operation: "create_definition",
					request: { title: "Report deadline" },
				},
			},
		}));
		const evaluate = evaluatorRequestsAnotherIteration();

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			config: { maxTerminalOnlyContinuations: 0 },
			executeToolCall,
			evaluate,
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(preview);
	});

	it("keeps a grammar-valid FINISH form ahead of the missing-input prose question", async () => {
		const question =
			"Please tell me the report name, date, and time before I create the reminder.";
		const runtime = plannerEmitsNoopThenTerminalText(REMINDER_FORM);
		const executeToolCall = vi.fn(async () => ({
			success: false,
			text: question,
			userFacingText: question,
			data: {
				missingField: "schedule",
				requiresConfirmation: true,
				awaitingUserInput: true,
			},
		}));
		const evaluate = evaluatorContinuesThenFinishes(REMINDER_FORM);

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(REMINDER_FORM);
		expect(evaluate).toHaveBeenCalledTimes(2);
	});

	it("keeps a lifeDraft confirmation preview ahead of a FINISH form", async () => {
		const preview =
			"I can save this reminder for Friday at 9 AM. Confirm and I'll create it.";
		const runtime = plannerEmitsNoopThenTerminalText(REMINDER_FORM);
		const executeToolCall = vi.fn(async () => ({
			success: false,
			text: preview,
			userFacingText: preview,
			data: {
				requiresConfirmation: true,
				awaitingUserInput: true,
				lifeDraft: {
					operation: "create_definition",
					request: { title: "Report deadline" },
				},
			},
		}));
		const evaluate = evaluatorContinuesThenFinishes(REMINDER_FORM);

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(preview);
	});
});
