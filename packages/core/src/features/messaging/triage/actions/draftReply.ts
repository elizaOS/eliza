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
import { getDefaultTriageService } from "../triage-service.ts";
import {
	bodyParameter,
	messageIdParameter,
	parseDraftReplyParams,
	validateMessageAction,
} from "./_shared.ts";

export const draftReplyAction: Action = {
	name: "DRAFT_REPLY",
	contexts: ["messaging", "email", "contacts"],
	roleGate: { minRole: "ADMIN" },
	description:
		"Compose a draft reply to an existing message (identified by messageId). Never sends — produces a preview that must be confirmed via SEND_DRAFT.",
	similes: ["COMPOSE_REPLY", "DRAFT_MESSAGE_REPLY"],
	parameters: [messageIdParameter, bodyParameter],
	examples: [
		[
			{
				name: "User",
				content: { text: "Draft a reply to Alice's email" },
			},
			{
				name: "Agent",
				content: {
					text: "Drafting a reply — here's the preview.",
					action: "DRAFT_REPLY",
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
		const parsed = parseDraftReplyParams(options);
		if ("error" in parsed) {
			logger.warn(`[DraftReply] ${parsed.error}`);
			return {
				success: false,
				text: parsed.error,
				error: parsed.error,
			};
		}

		const service = getDefaultTriageService();
		const record = await service.draftReply(
			runtime,
			parsed.messageId,
			parsed.body,
		);

		const text = `Drafted reply on ${record.source}. Preview: ${record.preview}`;
		logger.info(
			`[DraftReply] draftId=${record.draftId} source=${record.source}`,
		);
		if (callback) {
			await callback({ text, action: "DRAFT_REPLY" });
		}

		return {
			success: true,
			text,
			data: {
				draftId: record.draftId,
				source: record.source,
				preview: record.preview,
				inReplyToId: record.inReplyToId ?? null,
			},
		};
	},
};
