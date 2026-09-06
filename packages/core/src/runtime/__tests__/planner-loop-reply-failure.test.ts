import { describe, expect, it, vi } from "vitest";
import { ensureAgentVoice } from "../../services/message/voice-gate";
import type { Action, HandlerCallback, IAgentRuntime } from "../../types";
import {
	applyGroundedActionReply,
	createUnavailableGroundedActionReply,
	normalizeActionReplyFailure,
} from "../../types/action-reply";
import {
	normalizeActionResult,
	settleActionHandler,
} from "../action-handler-settlement";
import {
	actionResultToPlannerToolResult,
	runPlannerLoop,
} from "../planner-loop";

const receipt = {
	receiptId: "receipt-1",
	operation: "lifeops.reminder.create",
	resource: { kind: "lifeops.reminder", id: "reminder-1" },
	artifacts: [],
	idempotency: { key: "request-1", replayed: false },
	observedAt: "2026-07-27T18:00:00.000Z",
	outcome: "applied" as const,
	commit: {
		kind: "durable" as const,
		id: "transaction-1",
		committedAt: "2026-07-27T18:00:00.000Z",
	},
};
const unavailable = createUnavailableGroundedActionReply({
	kind: "rate_limited",
	code: "GROUNDED_REPLY_GENERATION_FAILED",
});
const effectResult = () => ({
	success: true,
	text: "internal receipt",
	userFacingText: "Canned success must not leak.",
	verifiedUserFacing: true,
	effectReceipts: [receipt],
	userFacingEffectReceiptIds: [receipt.receiptId],
	turnComplete: true,
	modelReplyRequired: true,
	modelReplyFallback: "Another canned fallback.",
	continueChain: true,
});

describe("reply generation failure is not effect failure", () => {
	it("normalizes non-replayable status without losing success or receipts", () => {
		const result = normalizeActionResult("SAVE", {
			...effectResult(),
			replyFailure: unavailable.failure,
		});
		expect(result).toMatchObject({
			success: true,
			effectReceipts: [receipt],
			replyFailure: unavailable.failure,
			transcriptVisibility: "internal",
			turnComplete: false,
		});
		for (const key of [
			"userFacingText",
			"verifiedUserFacing",
			"userFacingEffectReceiptIds",
			"modelReplyRequired",
			"modelReplyFallback",
			"continueChain",
			"error",
			"failureProvenance",
		])
			expect(result).not.toHaveProperty(key);
	});
	it.each([
		undefined,
		null,
		{},
		{ ...unavailable.failure, transient: true },
		{ ...unavailable.failure, kind: "handler_error" },
	])("rejects invalid/replayable reply failure %j", (failure) => {
		expect(() => normalizeActionReplyFailure(failure)).toThrow();
	});
	it("keeps buffered and late callbacks silent after the committed action settles", async () => {
		const callback = vi.fn(async () => []);
		let lateCallback: HandlerCallback | undefined;
		const runtime = {
			logger: { warn: vi.fn() },
			reportError: vi.fn(),
		} as unknown as IAgentRuntime;
		const result = await settleActionHandler({
			runtime,
			action: { name: "SAVE", tags: ["write"] } as Action,
			callback,
			invoke: async (actionCallback) => {
				lateCallback = actionCallback;
				await actionCallback?.({ text: "Canned success must not leak." });
				return applyGroundedActionReply(effectResult(), unavailable);
			},
		});
		await lateCallback?.({ text: "A late canned fallback must not leak." });
		expect(result.success).toBe(true);
		expect(result.effectReceipts).toEqual([receipt]);
		expect(callback).not.toHaveBeenCalled();
	});
	it("runs the real planner and settlement once, stops queued work and never evaluates or synthesizes after reply failure", async () => {
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{ id: "save-1", name: "SAVE", arguments: {} },
					{ id: "later-1", name: "LATER", arguments: {} },
				],
			})
			.mockRejectedValueOnce(
				new Error("provider unavailable during presentation"),
			);
		const commits: (typeof receipt)[] = [];
		const runtime = {
			useModel,
			logger: { warn: vi.fn() },
			reportError: vi.fn(),
		} as unknown as IAgentRuntime;
		const executeToolCall = vi.fn(async () =>
			actionResultToPlannerToolResult(
				await settleActionHandler({
					runtime,
					action: { name: "SAVE", tags: ["write"] } as Action,
					invoke: async () => {
						commits.push(receipt);
						await expect(
							runtime.useModel("TEXT_SMALL", {
								prompt: "Render the recorded result.",
							}),
						).rejects.toThrow("provider unavailable during presentation");
						return applyGroundedActionReply(effectResult(), unavailable);
					},
				}),
			),
		);
		const evaluate = vi.fn();
		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			tools: [
				{ name: "SAVE", description: "Save one reminder." },
				{ name: "LATER", description: "A later operation." },
			],
			executeToolCall,
			evaluate,
		});
		expect(commits).toEqual([receipt]);
		expect(executeToolCall).toHaveBeenCalledTimes(1);
		expect(useModel).toHaveBeenCalledTimes(2);
		expect(evaluate).not.toHaveBeenCalled();
		expect(result.finalMessage).toBeUndefined();
		expect(result.terminalFailure).toEqual(unavailable.failure);
		expect(result.trajectory.steps).toHaveLength(1);
		expect(result.trajectory.plannedQueue).toMatchObject([
			{ id: "later-1", name: "LATER" },
		]);
		expect(result.trajectory.context.plannedQueue).toMatchObject([
			{ id: "save-1", name: "SAVE", status: "completed" },
			{ id: "later-1", name: "LATER", status: "queued" },
		]);
		expect(result.trajectory.steps[0]?.result).toMatchObject({
			success: true,
			effectReceipts: [receipt],
			replyFailure: unavailable.failure,
		});
	});
	it("keeps typed unavailable system status out of the voice model and never marks it model-authored", async () => {
		const useModel = vi.fn();
		const runtime = { useModel } as unknown as IAgentRuntime;
		const content = {
			text: unavailable.failure.message,
			elizaSyntheticFailure: true,
			agentVoiced: false,
			replyFailure: { ...unavailable.failure },
		};
		expect(await ensureAgentVoice(runtime, content, { source: "api" })).toBe(
			content,
		);
		expect(useModel).not.toHaveBeenCalled();
		expect(content.agentVoiced).toBe(false);
	});
});
