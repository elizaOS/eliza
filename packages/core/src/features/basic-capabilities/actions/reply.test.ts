/**
 * Deterministic unit tests for the REPLY action's free-text branch. The runtime
 * and useModel are vi.fn stubs (no live model), covering the fallback to
 * planner-supplied text when the model returns empty structured text, and the
 * fallback to raw non-JSON model text.
 */
import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory, State } from "../../../index";
import { ModelType } from "../../../index";
import { replyAction } from "./reply";

function createRuntime(
	modelResponse: string,
	options: { receiptRequired?: boolean } = {},
): IAgentRuntime {
	return {
		agentId: "agent-id",
		character: { templates: {} },
		actions: [
			{
				name: "OWNER_REMINDERS",
				tags: [
					"capability:schedule",
					...(options.receiptRequired === false
						? []
						: ["effect:receipt-required"]),
				],
			},
		],
		composeState: vi.fn(async () => ({ values: {}, data: {} }) as State),
		useModel: vi.fn(async (modelType: ModelType) => {
			expect(modelType).toBe(ModelType.TEXT_LARGE);
			return modelResponse;
		}),
	} as IAgentRuntime;
}

function createMessage(): Memory {
	return {
		id: "message-id",
		agentId: "agent-id",
		entityId: "user-id",
		roomId: "room-id",
		content: { text: "hello" },
	} as Memory;
}

describe("REPLY action", () => {
	it("falls back to planner text when the reply model returns empty structured text", async () => {
		const runtime = createRuntime("thought: empty\ntext:");
		const callback = vi.fn();

		const result = await replyAction.handler?.(
			runtime,
			createMessage(),
			undefined,
			undefined,
			callback,
			[
				{
					content: { text: "planner already had a reply" },
				} as Memory,
			],
		);

		expect(result?.text).toBe("planner already had a reply");
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({ text: "planner already had a reply" }),
		);
	});

	it("rejects a fabricated completed-save claim when no tool ran this turn (#16941)", async () => {
		const runtime = createRuntime(
			'{"thought":"wrap up","text":"Saved! ✅ Your book report plan is now set up as reminders."}',
		);
		const callback = vi.fn();

		const result = await replyAction.handler?.(
			runtime,
			createMessage(),
			undefined,
			{ actionContext: { previousResults: [] } } as never,
			callback,
		);

		expect(result?.success).toBe(false);
		expect(result?.data).toMatchObject({
			actionName: "REPLY",
			error: "FABRICATED_SIDE_EFFECT_CLAIM",
		});
		// The fabricated text must never reach the wire.
		expect(callback).not.toHaveBeenCalled();
	});

	it("allows a completed-save claim grounded by an applied receipt earlier in the turn", async () => {
		const runtime = createRuntime(
			'{"thought":"confirm","text":"Done — your reminders are set for tomorrow morning."}',
		);
		const callback = vi.fn();
		const observedAt = "2026-07-27T18:00:00.000Z";
		const receipt = {
			receiptId: "receipt-reminder-1",
			operation: "lifeops.reminder.create",
			resource: { kind: "lifeops.reminder", id: "reminder-1" },
			artifacts: [],
			idempotency: { key: "request-1", replayed: false },
			observedAt,
			outcome: "applied" as const,
			commit: {
				kind: "durable" as const,
				id: "transaction-1",
				committedAt: observedAt,
			},
		};
		const canonicalText = "Done — your reminders are set for tomorrow morning.";

		const result = await replyAction.handler?.(
			runtime,
			createMessage(),
			undefined,
			{
				actionContext: {
					previousResults: [
						{
							success: true,
							userFacingText: canonicalText,
							verifiedUserFacing: true,
							effectReceipts: [receipt],
							userFacingEffectReceiptIds: [receipt.receiptId],
							data: { actionName: "OWNER_REMINDERS" },
						},
					],
				},
			} as never,
			callback,
		);

		expect(result?.success).not.toBe(false);
		expect(result).toMatchObject({
			userFacingText: canonicalText,
			verifiedUserFacing: true,
			effectReceipts: [receipt],
			userFacingEffectReceiptIds: [receipt.receiptId],
		});
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({
				text: canonicalText,
			}),
		);
	});

	it("rejects a completion claim grounded only by legacy success", async () => {
		const runtime = createRuntime(
			'{"thought":"confirm","text":"Done — your reminders are set for tomorrow morning."}',
		);
		const callback = vi.fn();

		const result = await replyAction.handler?.(
			runtime,
			createMessage(),
			undefined,
			{
				actionContext: {
					previousResults: [
						{
							success: true,
							data: { actionName: "OWNER_REMINDERS" },
						},
					],
				},
			} as never,
			callback,
		);

		expect(result?.success).toBe(false);
		expect(result?.data).toMatchObject({
			error: "FABRICATED_SIDE_EFFECT_CLAIM",
		});
		expect(callback).not.toHaveBeenCalled();
	});

	it("does not suppress an unrelated reply merely because an unmigrated mutation action ran", async () => {
		const runtime = createRuntime(
			'{"thought":"answer the follow-up","text":"The next step is to review the draft together."}',
			{ receiptRequired: false },
		);
		const callback = vi.fn();

		const result = await replyAction.handler?.(
			runtime,
			createMessage(),
			undefined,
			{
				actionContext: {
					previousResults: [
						{
							success: true,
							data: { actionName: "OWNER_REMINDERS" },
						},
					],
				},
			} as never,
			callback,
		);

		expect(result?.success).toBe(true);
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "The next step is to review the draft together.",
			}),
		);
	});

	it.each([
		"Your reminder is ready for tomorrow.",
		"You’ll get a nudge tomorrow at 9.",
		"That’s taken care of for tomorrow.",
		"It is on the books for 9am.",
		"The reminder now exists.",
		"El recordatorio quedó listo para mañana.",
	])(
		"rejects vague or non-English mutation confirmation without canonical receipt proof: %s",
		async (claim) => {
			const runtime = createRuntime(JSON.stringify({ text: claim }));
			const callback = vi.fn();

			const result = await replyAction.handler?.(
				runtime,
				createMessage(),
				undefined,
				{
					actionContext: {
						previousResults: [
							{
								success: true,
								data: { actionName: "OWNER_REMINDERS" },
							},
						],
					},
				} as never,
				callback,
			);

			expect(result?.success).toBe(false);
			expect(result?.data).toMatchObject({
				error: "FABRICATED_SIDE_EFFECT_CLAIM",
			});
			expect(callback).not.toHaveBeenCalled();
		},
	);

	it("allows exact action-owned non-applied outcome text with receipt proof", async () => {
		const canonicalText =
			"I prepared the reminder preview, but did not schedule it.";
		const observedAt = "2026-07-27T18:00:00.000Z";
		const receipt = {
			receiptId: "receipt-preview-1",
			operation: "lifeops.reminder.create",
			resource: { kind: "lifeops.reminder", id: "reminder-preview-1" },
			artifacts: [],
			idempotency: { key: "request-preview-1", replayed: false },
			observedAt,
			outcome: "preview" as const,
		};
		const runtime = createRuntime(JSON.stringify({ text: canonicalText }));
		const callback = vi.fn();

		const result = await replyAction.handler?.(
			runtime,
			createMessage(),
			undefined,
			{
				actionContext: {
					previousResults: [
						{
							success: true,
							userFacingText: canonicalText,
							verifiedUserFacing: true,
							effectReceipts: [receipt],
							userFacingEffectReceiptIds: [receipt.receiptId],
							data: { actionName: "OWNER_REMINDERS" },
						},
					],
				},
			} as never,
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result).toMatchObject({
			userFacingText: canonicalText,
			verifiedUserFacing: true,
			effectReceipts: [receipt],
			userFacingEffectReceiptIds: [receipt.receiptId],
		});
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({ text: canonicalText }),
		);
	});

	it("falls back to non-structured raw model text", async () => {
		const runtime = createRuntime("plain reply");

		const result = await replyAction.handler?.(
			runtime,
			createMessage(),
			undefined,
		);

		expect(result?.text).toBe("plain reply");
	});

	it("marks the free-text reply agentVoiced so gated transports skip the re-voice (#14873)", async () => {
		const runtime = createRuntime(
			'{"thought":"answer","text":"model-composed reply"}',
		);
		const callback = vi.fn();

		await replyAction.handler?.(
			runtime,
			createMessage(),
			undefined,
			undefined,
			callback,
		);

		// The reply text is the TEXT_LARGE model's own composed voice; the
		// provenance flag lets ensureAgentVoice pass it through untouched at
		// sendMessageToTarget instead of double-voicing it.
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "model-composed reply",
				agentVoiced: true,
			}),
		);
	});
});
