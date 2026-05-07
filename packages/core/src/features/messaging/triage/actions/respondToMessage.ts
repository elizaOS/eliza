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
import type { DraftRequest } from "../types.ts";
import {
	bodyParameter,
	messageIdParameter,
	parseRespondToMessageParams,
	validateMessageAction,
} from "./_shared.ts";

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
		"Reply to a message in one step: drafts the reply, then sends or queues it for owner approval per the registered SendPolicy.",
	descriptionCompressed:
		"reply to msg: draft then policy-gate then send; one-shot",
	similes: ["REPLY_TO_MESSAGE", "QUICK_REPLY", "ONE_SHOT_REPLY"],
	parameters: [messageIdParameter, bodyParameter],
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
		const record = await service.draftReply(
			runtime,
			parsed.messageId,
			parsed.body,
		);

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
					data: {
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
