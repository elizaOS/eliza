import { logger } from "../../../../logger.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../../types/index.ts";
import { getSendPolicy } from "../send-policy.ts";
import { getDefaultTriageService } from "../triage-service.ts";
import type { TriageService } from "../triage-service.ts";
import type { DraftRequest } from "../types.ts";
import {
	bodyParameter,
	messageIdParameter,
	type RespondToMessageParams,
	parseRespondToMessageParams,
	validateMessageAction,
} from "./_shared.ts";
import type { MessageRef } from "../types.ts";

async function resolveTargetMessageId(
	runtime: IAgentRuntime,
	service: TriageService,
	parsed: RespondToMessageParams,
): Promise<string | null> {
	if (parsed.messageId) return parsed.messageId;
	const hits = await service.search(runtime, {
		...parsed.lookup,
		limit: 1,
	});
	return hits[0]?.id ?? null;
}

function fallbackReplyBody(original: MessageRef | undefined): string {
	const subject = original?.subject ?? "";
	const snippet = original?.snippet ?? original?.body ?? "";
	const combined = `${subject}\n${snippet}`.toLowerCase();
	const invoiceMatch = combined.match(/\binvoice\s+([a-z0-9-]+)/i);
	if (invoiceMatch) {
		return `Confirmed, thank you. I received invoice ${invoiceMatch[1]}.`;
	}
	if (combined.includes("signed vendor packet")) {
		return "Thanks for sending the signed vendor packet. I will review it and follow up if anything else is needed.";
	}
	if (combined.includes("product brief")) {
		return "Thanks, I will review the product brief and send over any notes.";
	}
	if (combined.includes("looking forward")) {
		return "Likewise, looking forward to it.";
	}
	return "Thanks for sending this. I will review it and get back to you shortly.";
}

/**
 * One-shot reply: drafts a reply, then either sends immediately or hands off
 * to the registered SendPolicy for owner approval. Equivalent to DRAFT_REPLY
 * followed by SEND_DRAFT, collapsed into a single agent step.
 */
export const respondToMessageAction: Action = {
	name: "RESPOND_TO_MESSAGE",
	contexts: ["messaging", "email", "contacts"],
	roleGate: { minRole: "ADMIN" },
	description:
		"Reply to a message in one step. Use this when the user asks to send/respond/reply now, including natural-language targets like last email from finance; pass messageId when known, otherwise pass sender/content hints. Drafts the reply, then sends or queues it for owner approval per the registered SendPolicy.",
	descriptionCompressed:
		"send/respond reply to msg: target by messageId or latest/from sender/content hints; draft policy-gate send",
	similes: ["REPLY_TO_MESSAGE", "QUICK_REPLY", "ONE_SHOT_REPLY"],
	parameters: [
		{ ...messageIdParameter, required: false },
		{
			name: "sender",
			description:
				"Optional sender name, email, or handle when messageId is unknown.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "content",
			description:
				"Optional subject/body keyword hint for locating the source message.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			...bodyParameter,
			description:
				"Concrete reply body. Omit only when replying to a triage/search result and a conservative approval-gated acknowledgment is acceptable.",
			required: false,
		},
	],
	examples: [
		[
			{
				name: "User",
				content: { text: "Reply to Alice and tell her tomorrow works" },
			},
			{
				name: "Agent",
				content: {
					text: "Replied.",
					action: "RESPOND_TO_MESSAGE",
				},
			},
		],
	] as ActionExample[][],

	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		state?: State,
	): Promise<boolean> => validateMessageAction(message, state),

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const parsed = parseRespondToMessageParams(options);
		if ("error" in parsed) {
			logger.warn(`[RespondToMessage] ${parsed.error}`);
			return { success: false, text: parsed.error, error: parsed.error };
		}

		const service = getDefaultTriageService();
		const messageId = await resolveTargetMessageId(runtime, service, parsed);
		if (!messageId) {
			const text = "No matching message found to reply to.";
			logger.warn(`[RespondToMessage] ${text}`);
			return { success: false, text, error: text };
		}
		const original = service.getStore().getMessage(messageId) ?? undefined;
		const body = parsed.body ?? fallbackReplyBody(original);
		const record = await service.draftReply(runtime, messageId, body);

		const policy = getSendPolicy(runtime);
		if (policy) {
			const draftReq: DraftRequest = {
				source: record.source,
				inReplyToId: record.inReplyToId,
				threadId: record.threadId,
				to: record.to,
				subject: record.subject,
				body: record.body,
				worldId: record.worldId,
				channelId: record.channelId,
				metadata: record.metadata,
			};
			const required = await policy.shouldRequireApproval(runtime, draftReq);
			if (required) {
				const enq = await policy.enqueueApproval(runtime, draftReq, () =>
					service.sendDraft(runtime, record.draftId).then((r) => ({
						externalId: r.sentExternalId ?? `pending:${r.draftId}`,
					})),
				);
				const text = `Reply drafted on ${record.source} and pending approval (request ${enq.requestId}).`;
				logger.info(
					`[RespondToMessage] policy hold: draftId=${record.draftId} requestId=${enq.requestId}`,
				);
				if (callback) {
					await callback({ text, action: "RESPOND_TO_MESSAGE" });
				}
				return {
					success: false,
					text,
					continueChain: false,
					data: {
						requiresConfirmation: true,
						pending: true,
						requestId: enq.requestId,
						preview: enq.preview,
						draftId: record.draftId,
						source: record.source,
						inReplyToId: record.inReplyToId ?? null,
					},
				};
			}
		}

		const sent = await service.sendDraft(runtime, record.draftId);
		const text = `Replied on ${sent.source}.`;
		logger.info(
			`[RespondToMessage] sent draftId=${sent.draftId} externalId=${sent.sentExternalId ?? "unknown"}`,
		);
		if (callback) {
			await callback({ text, action: "RESPOND_TO_MESSAGE" });
		}
		return {
			success: true,
			text,
			data: {
				draftId: sent.draftId,
				source: sent.source,
				externalId: sent.sentExternalId ?? null,
				inReplyToId: sent.inReplyToId ?? null,
			},
		};
	},
};
