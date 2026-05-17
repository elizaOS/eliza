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
import type { TriageService } from "../triage-service.ts";
import { getDefaultTriageService } from "../triage-service.ts";
import {
	bodyParameter,
	type DraftReplyParams,
	messageIdParameter,
	parseDraftReplyParams,
	validateMessageAction,
} from "./_shared.ts";

async function resolveTargetMessageId(
	runtime: IAgentRuntime,
	service: TriageService,
	parsed: DraftReplyParams,
): Promise<string | null> {
	if (parsed.messageId) return parsed.messageId;
	const hits = await service.search(runtime, {
		...parsed.lookup,
		limit: 1,
	});
	return hits[0]?.id ?? null;
}

export const draftReplyAction: Action = {
	name: "MESSAGE",
	contexts: ["messaging", "email", "contacts"],
	roleGate: { minRole: "ADMIN" },
	description:
		"Compose a draft reply to an existing message. Use this when the user asks to draft a reply, including natural-language targets like latest email from Sarah; pass messageId when known, otherwise pass sender/content hints. Never sends — produces a preview that must be confirmed via MESSAGE.",
	descriptionCompressed:
		"draft reply only; can target by messageId or latest/from sender/content hints; never sends",
	similes: ["COMPOSE_REPLY", "DRAFT_MESSAGE_REPLY"],
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
		bodyParameter,
	],
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
					action: "MESSAGE",
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
		const messageId = await resolveTargetMessageId(runtime, service, parsed);
		if (!messageId) {
			const text = "No matching message found to draft a reply to.";
			logger.warn(`[DraftReply] ${text}`);
			return { success: false, text, error: text };
		}
		const record = await service.draftReply(runtime, messageId, parsed.body);

		const text = `Drafted reply on ${record.source}. Preview: ${record.preview}`;
		logger.info(
			`[DraftReply] draftId=${record.draftId} source=${record.source}`,
		);
		if (callback) {
			await callback({ text, action: "MESSAGE" });
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
