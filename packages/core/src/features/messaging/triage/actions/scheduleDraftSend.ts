/**
 * The deferred-send action for the messaging-triage capability, registered
 * under the shared `MESSAGE` action name. Given an existing draft id and a
 * target time, it schedules the draft through an authoritative adapter-native
 * remote schedule or the canonical durable ScheduledTask runner. The returned
 * confirmation is bound to the provider or task-store commit receipt.
 */
import { ElizaError } from "../../../../errors.ts";
import { logger } from "../../../../logger.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	EffectReceipt,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../../types/index.ts";
import { getDefaultTriageService } from "../triage-service.ts";
import {
	draftIdParameter,
	parseScheduleDraftSendParams,
	validateMessageAction,
} from "./_shared.ts";

export function formatSendAtIso(sendAtMs: number): string {
	if (!Number.isFinite(sendAtMs)) {
		throw new ElizaError(
			`Invalid sendAtMs: ${String(sendAtMs)} is not finite`,
			{
				code: "MESSAGE_DRAFT_SCHEDULE_INVALID_TIME",
				context: { sendAtMs },
				severity: "validation",
			},
		);
	}
	const date = new Date(sendAtMs);
	if (Number.isNaN(date.getTime())) {
		throw new ElizaError(
			`Invalid sendAtMs: ${String(sendAtMs)} is out of Date range`,
			{
				code: "MESSAGE_DRAFT_SCHEDULE_INVALID_TIME",
				context: { sendAtMs },
				severity: "validation",
			},
		);
	}
	return date.toISOString();
}

export const scheduleDraftSendAction: Action = {
	name: "MESSAGE",
	contexts: ["messaging", "email", "calendar", "automation"],
	roleGate: { minRole: "ADMIN" },
	description:
		"Schedule a previously created draft to send at a future time. Uses authoritative adapter-native scheduling when supported and otherwise persists a one-shot task in the shared scheduler.",
	descriptionCompressed:
		"schedule draft send sendAtMs durable shared scheduler",
	tags: [
		"domain:messages",
		"capability:schedule",
		"capability:send",
		"effect:receipt-required",
	],
	similes: ["DEFER_SEND", "SCHEDULE_SEND", "SEND_LATER"],
	parameters: [
		draftIdParameter,
		{
			name: "sendAt",
			description:
				"When to send the draft, as an ISO timestamp or parseable date.",
			required: true,
			schema: { type: "string" as const },
		},
	],
	examples: [
		[
			{
				name: "User",
				content: { text: "Send that draft tomorrow at 9am" },
			},
			{
				name: "Agent",
				content: {
					text: "Scheduled.",
					action: "MESSAGE",
				},
			},
		],
	] as ActionExample[][],

	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		state?: State,
	): Promise<boolean> =>
		validateMessageAction(message, state, [
			"messaging",
			"email",
			"calendar",
			"automation",
		]),

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const parsed = parseScheduleDraftSendParams(options);
		if ("error" in parsed) {
			logger.warn(`[ScheduleDraftSend] ${parsed.error}`);
			return { success: false, text: parsed.error, error: parsed.error };
		}

		const service = getDefaultTriageService();
		const existing = service.getStore().getDraft(parsed.draftId);
		if (!existing) {
			const msg = `No draft found for id ${parsed.draftId}`;
			logger.warn(`[ScheduleDraftSend] ${msg}`);
			return { success: false, text: msg, error: msg };
		}

		const updated = await service.scheduleDraftSend(
			runtime,
			parsed.draftId,
			parsed.sendAtMs,
		);

		const text = `Scheduled draft ${parsed.draftId} for ${formatSendAtIso(parsed.sendAtMs)}.`;
		const commit = updated.scheduleCommit;
		if (!commit) {
			throw new ElizaError(
				`Scheduled draft ${parsed.draftId} returned without commit proof.`,
				{
					code: "MESSAGE_DRAFT_SCHEDULE_RECEIPT_MISSING",
					context: { draftId: parsed.draftId, sendAtMs: parsed.sendAtMs },
					severity: "fatal",
				},
			);
		}
		const receipt: EffectReceipt = {
			receiptId: `message-schedule:${commit.kind}:${commit.id}`,
			operation: "message.draft.schedule",
			resource: {
				kind: "messaging.deferred_send",
				id: commit.id,
			},
			artifacts: [
				{
					kind: "messaging.draft",
					id: updated.draftId,
				},
			],
			idempotency: {
				key: commit.idempotencyKey,
				replayed: commit.replayed,
			},
			observedAt: new Date().toISOString(),
			outcome: "applied",
			commit: {
				kind: commit.kind,
				id: commit.id,
				committedAt: commit.committedAt,
			},
		};
		logger.info(
			`[ScheduleDraftSend] draftId=${parsed.draftId} sendAtMs=${parsed.sendAtMs} scheduledId=${updated.scheduledId ?? "unknown"}`,
		);
		if (callback) {
			await callback({ text, action: "MESSAGE" });
		}
		return {
			success: true,
			text,
			verifiedUserFacing: true,
			userFacingText: text,
			effectReceipts: [receipt],
			userFacingEffectReceiptIds: [receipt.receiptId],
			data: {
				draftId: updated.draftId,
				source: updated.source,
				scheduledForMs: updated.scheduledForMs ?? parsed.sendAtMs,
				scheduledId: updated.scheduledId ?? null,
			},
		};
	},
};
