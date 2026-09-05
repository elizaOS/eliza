/**
 * Exercises the real planner loop and evaluator with deterministic model
 * responses. Explicit pending work must survive an erroneous successful
 * FINISH without replaying settled actions or discarding the queued batch.
 */
import { describe, expect, it, vi } from "vitest";
import { createUnavailableGroundedActionReply } from "../../types/action-reply";
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
}) {
	let plannerIndex = 0;
	let evaluatorIndex = 0;
	let resultIndex = 0;
	const executed: string[] = [];
	const useModel = vi.fn<PlannerRuntime["useModel"]>(async (type) => {
		const response =
			type === ModelType.ACTION_PLANNER
				? args.plans[plannerIndex++]
				: args.evaluations[evaluatorIndex++];
		if (response === undefined) throw new Error("Unexpected model call");
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
						id: "handler",
						type: "message_handler",
						metadata: {
							plan: { intents: ["read record", "open destination"] },
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
