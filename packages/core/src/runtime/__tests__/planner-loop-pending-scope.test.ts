/**
 * Exercises the real planner loop and evaluator with deterministic model
 * responses. Explicit pending work must survive an erroneous successful
 * FINISH without replaying settled actions or discarding the queued batch.
 */
import { describe, expect, it, vi } from "vitest";
import { createUnavailableGroundedActionReply } from "../../types/action-reply";
import type { EffectReceipt } from "../../types/effects";
import { ModelType } from "../../types/model";
import { runPlannerLoop } from "../planner-loop";
import type { PlannerRuntime, PlannerToolResult } from "../planner-types";

function call(name: string, scope?: "more_work_pending" | "final") {
	return {
		id: name.toLowerCase(),
		name,
		arguments: {
			...(scope ? { eliza_turn_scope: scope } : {}),
		},
	};
}

/** The grounded receipt render's `{complete, message}` object as the model returns it. */
function render(message: string, complete = true) {
	return JSON.stringify({ complete, message });
}

/** An evaluator verdict that the recorded results do not yet satisfy the request. */
function continueWork(thought: string) {
	return JSON.stringify({ thought, success: false, decision: "CONTINUE" });
}

function finish(messageToUser: string, success = true) {
	return JSON.stringify({
		thought: "Judge the complete recorded results.",
		success,
		decision: "FINISH",
		messageToUser,
	});
}

function harness(args: {
	plans: Array<string | { text: string; toolCalls: ReturnType<typeof call>[] }>;
	evaluations: string[];
	results?: PlannerToolResult[];
	intents?: string[];
	/** TEXT_SMALL responses for the grounded receipt render. */
	renders?: string[];
	userMessage?: string;
}) {
	let plannerIndex = 0;
	let evaluatorIndex = 0;
	let renderIndex = 0;
	let resultIndex = 0;
	const executed: string[] = [];
	const useModel = vi.fn<PlannerRuntime["useModel"]>(async (type) => {
		const response =
			type === ModelType.ACTION_PLANNER
				? args.plans[plannerIndex++]
				: type === ModelType.TEXT_SMALL
					? args.renders?.[renderIndex++]
					: args.evaluations[evaluatorIndex++];
		if (response === undefined) {
			throw new Error(
				`Unexpected model call ${String(type)} after ${useModel.mock.calls
					.map(([calledType]) => String(calledType))
					.join(",")}`,
			);
		}
		return response;
	});
	const executeToolCall = vi.fn(async (tool: { name: string }) => {
		executed.push(tool.name);
		return (
			args.results?.[resultIndex++] ?? {
				success: true,
				transcriptVisibility: "internal" as const,
				text: JSON.stringify({ operation: tool.name, completed: true }),
			}
		);
	});
	const run = () =>
		runPlannerLoop({
			runtime: { useModel },
			context: {
				id: "compound-turn",
				events: [
					{
						id: "current-message",
						type: "message",
						source: "user",
						createdAt: 1,
						message: {
							role: "user",
							content:
								args.userMessage ?? "add gym session tuesday at 7am please",
						},
					},
					{
						id: "handler",
						type: "message_handler",
						metadata: {
							plan: {
								intents: args.intents ?? ["read record", "open destination"],
							},
						},
					},
				],
			},
			config: { maxIterations: 6 },
			executeToolCall,
		});
	return { run, useModel, executed };
}

describe("planner-declared pending work", () => {
	it("finishes a consistently final multi-call batch without another planner round", async () => {
		const h = harness({
			plans: [
				{
					text: "",
					toolCalls: [call("READ", "final"), call("NAVIGATE", "final")],
				},
			],
			evaluations: [
				JSON.stringify({
					thought:
						"The requested read succeeded; the queued navigation remains.",
					success: false,
					decision: "NEXT_RECOMMENDED",
					recommendedToolCallId: "navigate",
				}),
				finish("The record was read and the destination is open."),
			],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["READ", "NAVIGATE"]);
		expect(h.useModel.mock.calls.map(([type]) => type)).toEqual([
			ModelType.ACTION_PLANNER,
			ModelType.RESPONSE_HANDLER,
			ModelType.RESPONSE_HANDLER,
		]);
		expect(result.finalMessage).toBe(
			"The record was read and the destination is open.",
		);
		expect(result.trajectory.plannedQueue).toEqual([]);
	});

	it("keeps a conflicting batch pending until a later explicit final declaration", async () => {
		const h = harness({
			plans: [
				{
					text: "",
					toolCalls: [
						call("READ", "more_work_pending"),
						call("CHECK", "final"),
					],
				},
				{ text: "", toolCalls: [call("NAVIGATE", "final")] },
			],
			evaluations: [
				finish("Only read."),
				finish("Only checked."),
				finish("All done."),
			],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["READ", "CHECK", "NAVIGATE"]);
		expect(result.finalMessage).toBe("All done.");
		expect(h.useModel).toHaveBeenCalledTimes(5);
		expect(result.trajectory.evaluatorOutputs.slice(0, 2)).toEqual([
			expect.objectContaining({ decision: "CONTINUE", success: false }),
			expect.objectContaining({ decision: "CONTINUE", success: false }),
		]);
	});

	it("replans after a successful FINISH that abandons the declared next operation", async () => {
		const h = harness({
			plans: [
				{ text: "", toolCalls: [call("READ", "more_work_pending")] },
				{ text: "", toolCalls: [call("NAVIGATE", "final")] },
			],
			evaluations: [
				finish("The record was read, but navigation was not performed."),
				finish("The record was read and the destination is open."),
			],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["READ", "NAVIGATE"]);
		expect(result.finalMessage).toBe(
			"The record was read and the destination is open.",
		);
		expect(h.useModel).toHaveBeenCalledTimes(4);
		const firstEvaluation = h.useModel.mock.calls.find(
			([type]) => type === ModelType.RESPONSE_HANDLER,
		)?.[1];
		expect(JSON.stringify(firstEvaluation?.messages)).toContain(
			"more_work_pending",
		);
		expect(
			result.trajectory.steps.filter((step) => step.toolCall),
		).toHaveLength(2);
		expect(result.trajectory.evaluatorOutputs[0]).toMatchObject({
			decision: "CONTINUE",
			success: false,
			raw: { decision: "FINISH", success: true },
		});
		expect(
			result.trajectory.evaluatorOutputs[0]?.messageToUser,
		).toBeUndefined();
	});

	it("delivers the rejected FINISH when the planner explicitly releases pending scope without replay", async () => {
		// Live 2026-09-05 (tj-9a419beee929da): a single calendar delete was
		// declared more_work_pending, the evaluator's correct FINISH was rejected,
		// and the replanned planner re-issued the same delete (a noop) before a
		// third planner call finally replied.
		const h = harness({
			plans: [
				{ text: "", toolCalls: [call("DELETE", "more_work_pending")] },
				{ text: "", toolCalls: [call("DELETE", "final")] },
			],
			evaluations: [finish("Deleted the 7am gym session on Tuesday.")],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["DELETE"]);
		expect(result.finalMessage).toBe("Deleted the 7am gym session on Tuesday.");
		expect(h.useModel).toHaveBeenCalledTimes(3);
		expect(result.evaluator).toMatchObject({
			decision: "FINISH",
			success: true,
		});
	});

	it.each(["more_work_pending", undefined] as const)(
		"does not finish an incomplete compound request when a repeated action has scope %s",
		async (scope) => {
			const h = harness({
				plans: [
					{ text: "", toolCalls: [call("DELETE", "more_work_pending")] },
					{ text: "", toolCalls: [call("DELETE", scope)] },
					{ text: "", toolCalls: [call("NAVIGATE", "final")] },
				],
				evaluations: [
					finish("Only deleted."),
					finish("Deleted and opened the destination."),
				],
			});
			const result = await h.run();
			expect(h.executed).toEqual(["DELETE", "NAVIGATE"]);
			expect(result.finalMessage).toBe("Deleted and opened the destination.");
			expect(h.useModel).toHaveBeenCalledTimes(5);
		},
	);

	it("adopts the sub-planner evaluator's FINISH for an umbrella result instead of evaluating again", async () => {
		// Live 2026-09-05 (tj-b2756267002022): umbrella CALENDAR → sub-planner →
		// child evaluator FINISH → umbrella step settled → a second evaluation ran
		// over the same results (11.1 s vs 3.3 s for the direct child call).
		const h = harness({
			plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
			evaluations: [],
			results: [
				{
					success: true,
					text: "OK CALENDAR_DELETE_EVENT",
					transcriptVisibility: "internal" as const,
					subPlannerEvaluation: {
						decision: "FINISH" as const,
						success: true,
						messageToUser: "Deleted the gym session on Tuesday at 7am.",
					},
				},
			],
			intents: ["delete the gym session on tuesday"],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["CALENDAR"]);
		expect(result.finalMessage).toBe(
			"Deleted the gym session on Tuesday at 7am.",
		);
		expect(
			h.useModel.mock.calls.filter(
				([type]) => type === ModelType.RESPONSE_HANDLER,
			),
		).toHaveLength(0);
	});

	it("does not let a child FINISH close a parent that declared more_work_pending", async () => {
		// The umbrella step succeeded and its child evaluator said FINISH, but
		// the planner marked the batch more_work_pending: the dependent NOTES
		// step still has to run. The child verdict is not adopted; the model
		// evaluator's FINISH goes through the pending-scope correction once and
		// the loop replans.
		const childFinish = {
			success: true,
			text: "OK CALENDAR_DELETE_EVENT",
			transcriptVisibility: "internal" as const,
			subPlannerEvaluation: {
				decision: "FINISH" as const,
				success: true,
				messageToUser: "Deleted the gym session on Tuesday at 7am.",
			},
		};
		const h = harness({
			plans: [
				{ text: "", toolCalls: [call("CALENDAR", "more_work_pending")] },
				{ text: "", toolCalls: [call("NOTES", "final")] },
			],
			evaluations: [
				finish("Deleted the gym session on Tuesday at 7am."),
				finish("Deleted the gym session and noted it."),
			],
			results: [
				childFinish,
				{
					success: true,
					text: "OK NOTES",
					transcriptVisibility: "internal" as const,
				},
			],
			intents: ["delete the gym session and note it"],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["CALENDAR", "NOTES"]);
		expect(result.finalMessage).toBe("Deleted the gym session and noted it.");
		expect(
			h.useModel.mock.calls.filter(
				([type]) => type === ModelType.RESPONSE_HANDLER,
			),
		).toHaveLength(2);
	});

	it("still runs the intent evaluation when Stage-1 declared more than one intent", async () => {
		// The child verdict covers the delegated calendar operation only; the
		// second declared intent is reconciled by the model evaluator.
		const h = harness({
			plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
			evaluations: [
				finish(
					"Deleted the gym session; I could not open the destination.",
					false,
				),
			],
			results: [
				{
					success: true,
					text: "OK CALENDAR_DELETE_EVENT",
					transcriptVisibility: "internal" as const,
					subPlannerEvaluation: {
						decision: "FINISH" as const,
						success: true,
						messageToUser: "Deleted the gym session on Tuesday at 7am.",
					},
				},
			],
		});
		const result = await h.run();
		expect(
			h.useModel.mock.calls.filter(
				([type]) => type === ModelType.RESPONSE_HANDLER,
			),
		).toHaveLength(1);
		expect(result.finalMessage).toBe(
			"Deleted the gym session; I could not open the destination.",
		);
	});

	it("still evaluates when the sub-planner verdict was not a successful FINISH", async () => {
		const h = harness({
			plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
			evaluations: [
				finish("Nothing was deleted; the event was not found.", false),
			],
			results: [
				{
					success: true,
					text: "OK CALENDAR_DELETE_EVENT",
					transcriptVisibility: "internal" as const,
					subPlannerEvaluation: { decision: "FINISH" as const, success: false },
				},
			],
		});
		await h.run();
		expect(
			h.useModel.mock.calls.filter(
				([type]) => type === ModelType.RESPONSE_HANDLER,
			),
		).toHaveLength(1);
	});

	it("preserves the queued batch after rejecting a premature successful FINISH", async () => {
		const h = harness({
			plans: [
				{
					text: "",
					toolCalls: [call("READ", "more_work_pending"), call("CHECK")],
				},
				{ text: "", toolCalls: [call("NAVIGATE", "final")] },
			],
			evaluations: [
				finish("Only read."),
				finish("Only checked."),
				finish("All done."),
			],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["READ", "CHECK", "NAVIGATE"]);
		expect(result.finalMessage).toBe("All done.");
		expect(
			h.useModel.mock.calls.filter(
				([type]) => type === ModelType.ACTION_PLANNER,
			),
		).toHaveLength(2);
	});

	it("does not erase pending scope when a later unscoped text reply omits it", async () => {
		const h = harness({
			plans: [
				{ text: "", toolCalls: [call("READ", "more_work_pending")] },
				JSON.stringify({
					messageToUser: "Only the read is complete.",
					toolCalls: [],
				}),
				{ text: "", toolCalls: [call("NAVIGATE", "final")] },
			],
			evaluations: [
				finish("Only read."),
				finish("Only read."),
				finish("All done."),
			],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["READ", "NAVIGATE"]);
		expect(result.finalMessage).toBe("All done.");
	});

	it("allows an explicit completed:true model reply to release pending authority", async () => {
		const h = harness({
			plans: [
				{ text: "", toolCalls: [call("READ", "more_work_pending")] },
				JSON.stringify({
					completed: true,
					messageToUser: "No further operation is needed.",
					toolCalls: [],
				}),
			],
			evaluations: [
				finish("Only read."),
				finish("No further operation is needed."),
			],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["READ"]);
		expect(h.useModel).toHaveBeenCalledTimes(4);
		expect(result.finalMessage).toBe("No further operation is needed.");
	});

	it("does not let an unscoped native REPLY erase previously pending work", async () => {
		const h = harness({
			plans: [
				{ text: "", toolCalls: [call("READ", "more_work_pending")] },
				{ text: "Only read.", toolCalls: [call("REPLY")] },
				{ text: "", toolCalls: [call("NAVIGATE", "final")] },
			],
			evaluations: [
				finish("Only read."),
				finish("Only read."),
				finish("All done."),
			],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["READ", "NAVIGATE"]);
		expect(result.finalMessage).toBe("All done.");
	});

	it.each(["REPLY", "STOP", "IGNORE"])(
		"preserves an explicit final %s",
		async (name) => {
			const terminal = call(name, "final");
			const h = harness({
				plans: [
					{ text: "", toolCalls: [call("READ", "more_work_pending")] },
					{
						text: "The remaining operation is unavailable.",
						toolCalls: [terminal],
					},
				],
				evaluations: [
					finish("Only read."),
					...(name === "REPLY"
						? [finish("The remaining operation is unavailable.", false)]
						: []),
				],
			});
			const result = await h.run();
			expect(h.executed).toEqual(["READ"]);
			expect(h.useModel).toHaveBeenCalledTimes(name === "REPLY" ? 4 : 3);
			expect(result.status).toBe("finished");
			if (name === "REPLY")
				expect(result.finalMessage).toBe(
					"The remaining operation is unavailable.",
				);
			else expect(result.finalMessage).toBeUndefined();
		},
	);

	it.each([
		{
			label: "owner confirmation",
			result: { success: true, data: { requiresConfirmation: true } },
		},
		{
			label: "missing user input",
			result: { success: true, data: { values: { awaitingUserInput: true } } },
		},
		{
			label: "failed operation",
			result: { success: false, error: "Unavailable" },
		},
	])(
		"preserves $label as a stopped outcome",
		async ({ result: toolResult }) => {
			const h = harness({
				plans: [{ text: "", toolCalls: [call("READ", "more_work_pending")] }],
				evaluations: [
					finish("A prerequisite prevents the remaining operation.", false),
				],
				results: [toolResult],
			});
			const result = await h.run();
			expect(result.status).toBe("finished");
			expect(result.evaluator?.success).toBe(false);
			expect(h.executed).toEqual(["READ"]);
			expect(h.useModel).toHaveBeenCalledTimes(2);
		},
	);

	it("allows a model-declared unavailable outcome without retrying a successful read", async () => {
		const h = harness({
			plans: [{ text: "", toolCalls: [call("READ", "more_work_pending")] }],
			evaluations: [
				finish("The requested destination is not available.", false),
			],
		});
		const result = await h.run();
		expect(result.evaluator?.success).toBe(false);
		expect(result.finalMessage).toBe(
			"The requested destination is not available.",
		);
		expect(h.useModel).toHaveBeenCalledTimes(2);
	});

	it.each([
		{
			label: "owner confirmation",
			success: true,
			data: { requiresConfirmation: true },
		},
		{
			label: "missing input",
			success: true,
			data: { values: { awaitingUserInput: true } },
		},
		{ label: "failed operation", success: false, data: {} },
	])(
		"corrects erroneous successful FINISH over $label without retrying",
		async ({ success, data }) => {
			const blockerText =
				"The operation requires owner input before it can proceed.";
			const h = harness({
				plans: [{ text: "", toolCalls: [call("READ", "more_work_pending")] }],
				evaluations: [finish("Everything is complete.")],
				results: [
					{
						success,
						data,
						userFacingText: blockerText,
						verifiedUserFacing: true,
						turnComplete: true,
					},
				],
			});
			const result = await h.run();
			expect(result.evaluator).toMatchObject({
				decision: "FINISH",
				success: false,
				raw: { decision: "FINISH", success: true },
			});
			expect(result.finalMessage).toBe(blockerText);
			expect(h.executed).toEqual(["READ"]);
			expect(h.useModel).toHaveBeenCalledTimes(2);
		},
	);

	it.each([
		{
			continueChain: false,
			userFacingText: "The action stopped.",
			verifiedUserFacing: true,
		},
		{
			replyFailure: createUnavailableGroundedActionReply({
				kind: "provider_issue",
				code: "REPLY_UNAVAILABLE",
			}).failure,
		},
	])("preserves action-owned terminal boundaries", async (boundary) => {
		const h = harness({
			plans: [
				{
					text: "",
					toolCalls: [call("READ", "more_work_pending"), call("LATER")],
				},
			],
			evaluations: [],
			results: [{ success: true, ...boundary }],
		});
		const result = await h.run();
		expect(result.status).toBe("finished");
		expect(h.executed).toEqual(["READ"]);
		expect(h.useModel).toHaveBeenCalledTimes(1);
		expect(result.trajectory.plannedQueue.map((tool) => tool.name)).toEqual([
			"LATER",
		]);
	});
});

describe("grounded receipt gate (single declared intent, one verified internal action)", () => {
	const appliedReceipt: EffectReceipt = {
		receiptId: "calendar-receipt-1",
		operation: "calendar.event.create",
		resource: { kind: "calendar.event", id: "evt-1", version: '"eliza-1"' },
		artifacts: [],
		idempotency: { key: null, replayed: false },
		observedAt: "2026-09-05T18:00:00.000Z",
		outcome: "applied",
		commit: {
			kind: "durable",
			id: "evt-1",
			committedAt: "2026-09-05T18:00:00.000Z",
		},
	};
	const readNoopReceipt: EffectReceipt = {
		receiptId: "calendar-read-receipt-1",
		operation: "calendar.event.search",
		resource: { kind: "calendar.feed", id: "feed-1", version: "v1" },
		artifacts: [],
		idempotency: { key: null, replayed: false },
		observedAt: "2026-09-05T18:00:00.000Z",
		outcome: "noop",
		reason:
			"The operation read an authoritative calendar snapshot without changing it.",
	};
	const mutationNoopReceipt: EffectReceipt = {
		...readNoopReceipt,
		receiptId: "calendar-noop-receipt-1",
		operation: "calendar.event.delete",
		reason: "No matching event.",
	};
	const rolledBackReceipt: EffectReceipt = {
		receiptId: "calendar-rollback-1",
		operation: "calendar.event.create",
		resource: { kind: "calendar.event", id: "evt-1", version: '"eliza-1"' },
		artifacts: [],
		idempotency: { key: null, replayed: false },
		observedAt: "2026-09-05T18:00:01.000Z",
		outcome: "rolled_back",
		rollback: {
			receiptId: "calendar-rollback-1",
			revertedReceiptIds: ["calendar-receipt-1"],
			rolledBackAt: "2026-09-05T18:00:01.000Z",
		},
	};
	const internalCalendarResult = (
		receipts: EffectReceipt[] = [appliedReceipt],
		overrides: Partial<PlannerToolResult> = {},
	): PlannerToolResult => ({
		success: true,
		transcriptVisibility: "internal",
		effectReceipts: receipts,
		data: {
			replyContext: {
				domain: "calendar",
				intent: "add gym session tuesday at 7am to my calendar",
				scenario: "create_event_completed",
				facts: "Created “Gym session” for Sep 8, 7:00 AM PDT.",
			},
		},
		...overrides,
	});
	const modelCalls = (h: ReturnType<typeof harness>, type: string) =>
		h.useModel.mock.calls.filter(([calledType]) => calledType === type).length;
	const renderPromptOf = (h: ReturnType<typeof harness>) => {
		const request = h.useModel.mock.calls.find(
			([t]) => t === ModelType.TEXT_SMALL,
		)?.[1] as { messages?: Array<{ content: string }> } | undefined;
		return (request?.messages ?? []).map((m) => m.content).join("\n");
	};

	it("renders the reply from committed receipt facts, carries receipt ids and raw provenance, and skips the evaluator", async () => {
		// Live 2026-09-05: the evaluator re-judged a verified calendar create with
		// a 15K-token prompt (0.8–1.0 s) only to phrase facts the action had
		// already produced.
		const h = harness({
			plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
			evaluations: [],
			renders: [render("Added your gym session for Tuesday at 7:00 AM.")],
			results: [internalCalendarResult()],
			intents: ["add gym session to calendar"],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["CALENDAR"]);
		expect(result.finalMessage).toBe(
			"Added your gym session for Tuesday at 7:00 AM.",
		);
		expect(modelCalls(h, ModelType.TEXT_SMALL)).toBe(1);
		expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(0);
		expect(result.evaluator).toMatchObject({
			decision: "FINISH",
			success: true,
			effectReceiptIds: ["calendar-receipt-1"],
			raw: {
				messageToUser: "Added your gym session for Tuesday at 7:00 AM.",
				source: "grounded_receipt_render",
			},
		});
		const prompt = renderPromptOf(h);
		expect(prompt).toContain("Created “Gym session” for Sep 8, 7:00 AM PDT.");
		expect(prompt).toContain(
			"User's message: add gym session tuesday at 7am please",
		);
		expect(prompt).toContain("Understood intent: add gym session to calendar");
		expect(prompt).toContain("never expose ids");
	});

	it("gates a read whose receipt is a plain no-op without claiming a side effect", async () => {
		const h = harness({
			plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
			evaluations: [],
			renders: [render("You have a gym session on Tuesday at 7:00 AM.")],
			results: [
				internalCalendarResult([readNoopReceipt], {
					data: {
						replyContext: {
							domain: "calendar",
							intent: "whats on my calendar tuesday?",
							scenario: "search_events",
							facts:
								"Your matching calendar event is Gym session (Sep 8, 7:00 AM).",
						},
					},
				}),
			],
			intents: ["list calendar events for tuesday"],
		});
		const result = await h.run();
		expect(modelCalls(h, ModelType.TEXT_SMALL)).toBe(1);
		expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(0);
		expect(result.evaluator?.effectReceiptIds).toBeUndefined();
	});

	it("keeps the full evaluator when the action set turnComplete:false", async () => {
		const h = harness({
			plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
			evaluations: [finish("Added your gym session for Tuesday at 7am.")],
			renders: [render("should not be used")],
			results: [
				internalCalendarResult([appliedReceipt], { turnComplete: false }),
			],
			intents: ["add gym session to calendar"],
		});
		await h.run();
		expect(modelCalls(h, ModelType.TEXT_SMALL)).toBe(0);
		expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(1);
	});

	it("keeps the full evaluator when a mutation only produced a non-replayed no-op", async () => {
		const h = harness({
			plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
			evaluations: [finish("I couldn't find that event.", false)],
			renders: [render("should not be used")],
			results: [internalCalendarResult([mutationNoopReceipt])],
			intents: ["delete the gym session"],
		});
		await h.run();
		expect(modelCalls(h, ModelType.TEXT_SMALL)).toBe(0);
		expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(1);
	});

	it("keeps the full evaluator when a receipt was rolled back", async () => {
		const h = harness({
			plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
			evaluations: [finish("The event was rolled back.", false)],
			renders: [render("should not be used")],
			results: [internalCalendarResult([appliedReceipt, rolledBackReceipt])],
			intents: ["add gym session to calendar"],
		});
		await h.run();
		expect(modelCalls(h, ModelType.TEXT_SMALL)).toBe(0);
		expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(1);
	});

	it("keeps the full evaluator when Stage-1 declared more than one intent", async () => {
		const h = harness({
			plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
			evaluations: [
				finish("Added the gym session; the note is still pending.", false),
			],
			renders: [render("should not be used")],
			results: [internalCalendarResult()],
		});
		await h.run();
		expect(modelCalls(h, ModelType.TEXT_SMALL)).toBe(0);
		expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(1);
	});

	it("keeps the full evaluator when a receipt failed", async () => {
		const failed: EffectReceipt = {
			receiptId: "calendar-failed-1",
			operation: "calendar.event.create",
			resource: { kind: "calendar.event", id: "evt-1", version: '"eliza-1"' },
			artifacts: [],
			idempotency: { key: null, replayed: false },
			observedAt: "2026-09-05T18:00:00.000Z",
			outcome: "failed",
			failure: {
				code: "CALENDAR_SERVICE_400",
				retryable: false,
				acceptance: "unknown",
			},
		};
		const h = harness({
			plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
			evaluations: [finish("The calendar rejected the event.", false)],
			renders: [render("should not be used")],
			results: [internalCalendarResult([failed])],
			intents: ["add gym session to calendar"],
		});
		await h.run();
		expect(modelCalls(h, ModelType.TEXT_SMALL)).toBe(0);
		expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(1);
	});

	it("keeps the full evaluator while the planner declared more_work_pending", async () => {
		const h = harness({
			plans: [
				{ text: "", toolCalls: [call("CALENDAR", "more_work_pending")] },
				{ text: "", toolCalls: [call("NOTES", "final")] },
			],
			evaluations: [finish("Added it."), finish("Added it and noted it.")],
			renders: [render("should not be used")],
			results: [
				internalCalendarResult(),
				{
					success: true,
					text: "OK NOTES",
					transcriptVisibility: "internal" as const,
				},
			],
			intents: ["add gym session and note it"],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["CALENDAR", "NOTES"]);
		expect(modelCalls(h, ModelType.TEXT_SMALL)).toBe(0);
		expect(result.finalMessage).toBe("Added it and noted it.");
	});

	it("advances a planned batch after a committed receipt without an intermediate evaluator call", async () => {
		// Live 2026-09-05 23:53: two planned creates paid a full evaluator call
		// between the steps (809 ms) only to pick the call already queued.
		const dentistReceipt: EffectReceipt = {
			...appliedReceipt,
			receiptId: "calendar-receipt-2",
			resource: { ...appliedReceipt.resource, id: "evt-2" },
			commit: { ...appliedReceipt.commit, id: "evt-2" },
		};
		const h = harness({
			userMessage:
				"add gym tuesday at 7am and a dentist visit wednesday at 3pm",
			plans: [
				{
					text: "",
					toolCalls: [
						{
							...call("CALENDAR", "final"),
							id: "calendar-gym",
							arguments: { eliza_turn_scope: "final", title: "Gym" },
						},
						{
							...call("CALENDAR", "final"),
							id: "calendar-dentist",
							arguments: { eliza_turn_scope: "final", title: "Dentist visit" },
						},
					],
				},
			],
			evaluations: [finish("Added the gym session and the dentist visit.")],
			results: [
				internalCalendarResult(),
				internalCalendarResult([dentistReceipt], {
					data: {
						replyContext: {
							domain: "calendar",
							intent: "add dentist visit wednesday at 3pm",
							scenario: "create_event_completed",
							facts: "Created “Dentist visit” for Sep 9, 3:00 PM PDT.",
						},
					},
				}),
			],
			intents: ["add the requested calendar events"],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["CALENDAR", "CALENDAR"]);
		// One terminal evaluation for the whole batch; no render (two steps).
		expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(1);
		expect(modelCalls(h, ModelType.TEXT_SMALL)).toBe(0);
		expect(result.trajectory.evaluatorOutputs[0]).toMatchObject({
			decision: "NEXT_RECOMMENDED",
			recommendedToolCallId: "calendar-dentist",
			thought: expect.stringContaining("without an intermediate evaluation"),
		});
		expect(result.finalMessage).toBe(
			"Added the gym session and the dentist visit.",
		);
	});

	it.each([
		[
			"the step only read (no committed mutation)",
			internalCalendarResult([readNoopReceipt], {
				data: {
					replyContext: {
						domain: "calendar",
						intent: "find the gym session",
						scenario: "search_results",
						facts: "Found “Gym session” on Sep 8, 7:00 AM PDT.",
					},
				},
			}),
		],
		[
			"the step asked for evaluation",
			internalCalendarResult([appliedReceipt], { turnComplete: false }),
		],
		[
			"the step's receipt was a mutation no-op",
			internalCalendarResult([mutationNoopReceipt]),
		],
	])(
		"keeps the per-step evaluator inside a batch when %s",
		async (_label, firstResult) => {
			const h = harness({
				plans: [
					{
						text: "",
						toolCalls: [
							{
								...call("CALENDAR", "final"),
								id: "calendar-first",
								arguments: { eliza_turn_scope: "final", title: "First" },
							},
							{
								...call("CALENDAR", "final"),
								id: "calendar-second",
								arguments: { eliza_turn_scope: "final", title: "Second" },
							},
						],
					},
				],
				evaluations: [
					JSON.stringify({
						thought: "Take the queued call.",
						success: true,
						decision: "NEXT_RECOMMENDED",
						recommendedToolCallId: "calendar-second",
					}),
					finish("Both done."),
				],
				results: [firstResult, internalCalendarResult()],
				intents: ["add the requested calendar events"],
			});
			const result = await h.run();
			expect(h.executed).toEqual(["CALENDAR", "CALENDAR"]);
			expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(2);
			expect(result.finalMessage).toBe("Both done.");
		},
	);

	it("declines the gate and lets the full evaluator continue when the render reports partial completion (two appointments, one created)", async () => {
		// Review 2026-09-05: one verified receipt plus one declared intent proves
		// one action, not the whole request. When the render judges the facts
		// cover only part of the message, the evaluator — not this gate — decides,
		// and here it continues the remaining create instead of finishing.
		const dentistReceipt: EffectReceipt = {
			...appliedReceipt,
			receiptId: "calendar-receipt-2",
			resource: { ...appliedReceipt.resource, id: "evt-2" },
			commit: { ...appliedReceipt.commit, id: "evt-2" },
		};
		const h = harness({
			userMessage:
				"add gym tuesday at 7am and a dentist visit wednesday at 3pm",
			plans: [
				{
					text: "",
					toolCalls: [
						{
							...call("CALENDAR", "final"),
							id: "calendar-gym",
							arguments: { eliza_turn_scope: "final", title: "Gym" },
						},
					],
				},
				{
					text: "",
					toolCalls: [
						{
							...call("CALENDAR", "final"),
							id: "calendar-dentist",
							arguments: { eliza_turn_scope: "final", title: "Dentist visit" },
						},
					],
				},
			],
			evaluations: [
				continueWork(
					"Only the gym session exists; the dentist visit is still missing.",
				),
				finish(
					"Added the gym session for Tuesday at 7am and the dentist visit for Wednesday at 3pm.",
				),
			],
			renders: [
				render(
					"Added your gym session for Tuesday at 7:00 AM. The dentist visit was not added.",
					false,
				),
			],
			results: [
				internalCalendarResult(),
				internalCalendarResult([dentistReceipt], {
					data: {
						replyContext: {
							domain: "calendar",
							intent: "add dentist visit wednesday at 3pm",
							scenario: "create_event_completed",
							facts: "Created “Dentist visit” for Sep 9, 3:00 PM PDT.",
						},
					},
				}),
			],
			intents: ["add the requested calendar events"],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["CALENDAR", "CALENDAR"]);
		expect(modelCalls(h, ModelType.TEXT_SMALL)).toBe(1);
		expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(2);
		expect(result.evaluator).toMatchObject({
			decision: "FINISH",
			success: true,
		});
		expect(result.evaluator?.raw?.source).toBeUndefined();
		expect(result.finalMessage).toBe(
			"Added the gym session for Tuesday at 7am and the dentist visit for Wednesday at 3pm.",
		);
		const renderPrompt = renderPromptOf(h);
		expect(renderPrompt).toContain(
			"User's message: add gym tuesday at 7am and a dentist visit wednesday at 3pm",
		);
		expect(renderPrompt).toContain('"complete": true or false');
	});

	it.each([
		[
			"preamble before the object",
			'Not complete yet {"complete": true, "message": "Added your gym session for Tuesday at 7:00 AM."}',
		],
		[
			"an array wrapping the object",
			'[{"complete": true, "message": "Added your gym session for Tuesday at 7:00 AM."}]',
		],
		[
			"trailing prose after the object",
			'{"complete": true, "message": "Added your gym session for Tuesday at 7:00 AM."} All done.',
		],
		[
			"a fence with prose outside it",
			'Here you go:\n```json\n{"complete": true, "message": "Added your gym session for Tuesday at 7:00 AM."}\n```',
		],
	])(
		"falls back to the evaluator when the render carries %s",
		async (_label, renderText) => {
			const h = harness({
				plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
				evaluations: [finish("Added your gym session for Tuesday at 7am.")],
				renders: [renderText],
				results: [internalCalendarResult()],
				intents: ["add gym session to calendar"],
			});
			const result = await h.run();
			expect(modelCalls(h, ModelType.TEXT_SMALL)).toBe(1);
			expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(1);
			expect(result.evaluator?.raw?.source).toBeUndefined();
			expect(result.finalMessage).toBe(
				"Added your gym session for Tuesday at 7am.",
			);
		},
	);

	it("accepts the object inside one exact whole-response code fence", async () => {
		const h = harness({
			plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
			evaluations: [],
			renders: [
				'```json\n{"complete": true, "message": "Added your gym session for Tuesday at 7:00 AM."}\n```',
			],
			results: [internalCalendarResult()],
			intents: ["add gym session to calendar"],
		});
		const result = await h.run();
		expect(modelCalls(h, ModelType.TEXT_SMALL)).toBe(1);
		expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(0);
		expect(result.finalMessage).toBe(
			"Added your gym session for Tuesday at 7:00 AM.",
		);
	});

	it("falls back to the evaluator when the render is not the {complete, message} contract", async () => {
		const h = harness({
			plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
			evaluations: [finish("Added your gym session for Tuesday at 7am.")],
			renders: ["Added your gym session for Tuesday at 7:00 AM."],
			results: [internalCalendarResult()],
			intents: ["add gym session to calendar"],
		});
		const result = await h.run();
		expect(modelCalls(h, ModelType.TEXT_SMALL)).toBe(1);
		expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(1);
		expect(result.finalMessage).toBe(
			"Added your gym session for Tuesday at 7am.",
		);
	});

	it("falls back to the evaluator when the render is empty", async () => {
		const h = harness({
			plans: [{ text: "", toolCalls: [call("CALENDAR", "final")] }],
			evaluations: [finish("Added your gym session for Tuesday at 7am.")],
			renders: ["   "],
			results: [internalCalendarResult()],
			intents: ["add gym session to calendar"],
		});
		const result = await h.run();
		expect(modelCalls(h, ModelType.TEXT_SMALL)).toBe(1);
		expect(modelCalls(h, ModelType.RESPONSE_HANDLER)).toBe(1);
		expect(result.finalMessage).toBe(
			"Added your gym session for Tuesday at 7am.",
		);
	});
});
