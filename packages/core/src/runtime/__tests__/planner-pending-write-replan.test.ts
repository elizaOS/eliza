import { describe, expect, it } from "vitest";
import type { EffectReceipt } from "../../types/effects";
import { PostEffectEvaluationError, runPlannerLoop } from "../planner-loop";
import type { PlannerToolResult } from "../planner-types";

const receipt: EffectReceipt = {
	receiptId: "note-saved",
	operation: "note.create",
	resource: { kind: "note", id: "note-1", version: "1" },
	artifacts: [],
	idempotency: { key: "create-note", replayed: false },
	observedAt: "2026-09-16T00:00:00.000Z",
	outcome: "applied",
	commit: {
		kind: "durable",
		id: "note-1",
		committedAt: "2026-09-16T00:00:00.000Z",
	},
};
const body = "Alpha  beta.\nSecond line.";
const saved: PlannerToolResult = {
	success: true,
	transcriptVisibility: "internal",
	modelReplyRequired: true,
	effectReceipts: [receipt],
	data: { body, noteId: "note-1" },
};

async function exercise(
	firstResult: PlannerToolResult,
	options: {
		pause?: boolean;
		scope?: string;
		queued?: boolean;
		intentCount?: number;
		planError?: Error;
		omitFinalReply?: boolean;
	} = {},
) {
	const storedResult = structuredClone(firstResult);
	const order: string[] = [];
	const inputs: unknown[] = [];
	let plan = 0;
	const read = {
		id: "read",
		name: "READ",
		arguments: { noteId: "note-1", eliza_turn_scope: "final" },
	};
	const result = await runPlannerLoop({
		runtime: {
			useModel: async (_type, input) => {
				inputs.push(input);
				if (options.omitFinalReply && plan === 2 && !input.tools) {
					order.push("reply-recovery");
					return JSON.stringify({
						thought: "Quote the verified body.",
						toolCalls: [],
						completed: true,
						messageToUser: body,
					});
				}
				order.push("plan");
				if (plan === 1 && options.planError) throw options.planError;
				if (++plan > 2) throw new Error("Unexpected extra planning round");
				return {
					text: "",
					toolCalls:
						plan === 1
							? [
									{
										id: "write",
										name: "WRITE",
										arguments: {
											body,
											eliza_turn_scope: options.scope ?? "more_work_pending",
										},
									},
									...(options.queued ? [read] : []),
								]
							: [read],
				};
			},
		},
		context: {
			id: "pending-write",
			events: [
				{
					id: "request",
					type: "message",
					source: "user",
					message: {
						role: "user",
						content:
							"Create this note, then read it back. Do not delete anything.",
					},
				},
				{
					id: "handler",
					type: "message_handler",
					source: "message-service",
					metadata: {
						plan: {
							intents:
								options.intentCount === 1
									? ["create and read a note"]
									: ["create note", "read saved note"],
						},
					},
				},
			],
		},
		tools: [{ name: "WRITE" }, { name: "READ" }],
		executeToolCall: async (call) => {
			order.push(call.name);
			return call.name === "WRITE"
				? storedResult
				: {
						success: true,
						transcriptVisibility: "internal",
						modelReplyRequired: true,
						data: { readOnlyOperation: true, body },
					};
		},
		evaluate: async ({ trajectory }) => {
			order.push("evaluate");
			if (options.pause)
				return {
					success: false,
					decision: "FINISH",
					messageToUser: "Stopped without any further operation.",
				};
			if (!trajectory.steps.some((step) => step.toolCall?.name === "READ"))
				return {
					success: false,
					decision: "CONTINUE",
					thought: "Read the new note using its returned ID.",
				};
			return {
				success: true,
				decision: "FINISH",
				...(options.omitFinalReply ? {} : { messageToUser: body }),
				effectReceiptIds: [receipt.receiptId],
			};
		},
	});
	return { result, order, inputs };
}

describe("pending committed write replanning", () => {
	it.each([1, 2])(
		"recovers omitted final presentation without replaying effects (%s intents)",
		async (intentCount) => {
			const h = await exercise(saved, { intentCount, omitFinalReply: true });
			expect(h.result.finalMessage).toBe(body);
			expect(h.order.filter((event) => event === "WRITE")).toHaveLength(1);
			expect(h.order.filter((event) => event === "READ")).toHaveLength(1);
			expect(
				h.order.filter((event) => event === "reply-recovery"),
			).toHaveLength(1);
			expect(h.result.trajectory.steps[0].result?.effectReceipts).toEqual([
				receipt,
			]);
		},
	);

	it.each([429, 503])(
		"keeps the committed outcome non-replayable after planner HTTP %s",
		async (statusCode) => {
			const h = await exercise(saved, {
				planError: Object.assign(new Error("Provider unavailable"), {
					statusCode,
				}),
			});
			expect(h.order).toEqual(["plan", "WRITE", "plan"]);
			expect(h.result.terminalFailure).toBeDefined();
			expect(h.result.finalMessage).toBeUndefined();
			expect(h.result.trajectory.steps[0].result).toMatchObject(saved);
			expect(h.result.trajectory.steps[0].result?.replyFailure).toBe(
				h.result.terminalFailure,
			);
		},
	);

	it("preserves the programmer error and committed evidence instead of replaying", async () => {
		const cause = new TypeError("Planner adapter defect");
		const failure = await exercise(saved, { planError: cause }).catch(
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(PostEffectEvaluationError);
		if (!(failure instanceof PostEffectEvaluationError))
			throw new Error("Missing post-effect boundary");
		expect(failure.cause).toBe(cause);
		expect(failure.trajectory.steps).toHaveLength(1);
		expect(failure.trajectory.steps[0].result).toMatchObject(saved);
	});

	it.each([false, true])(
		"replans from the complete committed result and still evaluates completion (replayed: %s)",
		async (replayed) => {
			const committed: EffectReceipt = replayed
				? {
						...receipt,
						outcome: "noop",
						reason: "Already committed by this same request",
						idempotency: { key: "create-note", replayed: true },
					}
				: receipt;
			const result = { ...saved, effectReceipts: [committed] };
			const h = await exercise(result);
			expect(h.order).toEqual(["plan", "WRITE", "plan", "READ", "evaluate"]);
			expect(h.result.finalMessage).toBe(body);
			expect(h.result.trajectory.steps[0].result).toMatchObject(result);
			expect(JSON.stringify(h.inputs[1])).toContain("note-saved");
			expect(JSON.stringify(h.inputs[1])).toContain("Do not delete anything.");
		},
	);

	it.each([
		["no receipt", { ...saved, effectReceipts: [] }],
		[
			"unsuccessful result",
			{ ...saved, success: false, error: "Write rejected" },
		],
		["mandatory evaluation", { ...saved, turnComplete: false }],
		["terminal authority", { ...saved, turnComplete: true }],
		["non-internal result", { ...saved, transcriptVisibility: undefined }],
		[
			"confirmation",
			{ ...saved, data: { ...saved.data, requiresConfirmation: true } },
		],
		[
			"awaiting input",
			{ ...saved, data: { values: { awaitingUserInput: true } } },
		],
		[
			"failure provenance",
			{
				...saved,
				failureProvenance: {
					kind: "persistence_error",
					boundary: "persistence",
					code: "UNKNOWN_COMMIT",
					retryable: false,
				},
			},
		],
		[
			"preview receipt",
			{
				...saved,
				effectReceipts: [
					{
						...receipt,
						outcome: "preview",
						preview: { summary: "Awaiting permission" },
					},
				],
			},
		],
		[
			"failed receipt",
			{
				...saved,
				effectReceipts: [
					{
						...receipt,
						outcome: "failed",
						failure: {
							code: "WRITE_DENIED",
							retryable: false,
							acceptance: "unknown",
						},
					},
				],
			},
		],
		[
			"rolled back receipt",
			{
				...saved,
				effectReceipts: [
					receipt,
					{
						...receipt,
						receiptId: "rollback",
						outcome: "rolled_back",
						rollback: {
							receiptId: "rollback",
							revertedReceiptIds: [receipt.receiptId],
							rolledBackAt: receipt.observedAt,
						},
					},
				],
			},
		],
		[
			"unreplayed mutation no-op",
			{
				...saved,
				effectReceipts: [
					{ ...receipt, outcome: "noop", reason: "No record matched" },
				],
			},
		],
	] as const)(
		"does not skip the stop/evaluation boundary for %s",
		async (_label, result) => {
			const h = await exercise(result as PlannerToolResult, { pause: true });
			expect(h.order.filter((event) => event === "plan")).toHaveLength(1);
			expect(h.order).not.toContain("READ");
		},
	);
});
