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
import { parseDraftFollowupParams } from "./_shared.ts";

export const draftFollowupAction: Action = {
	name: "DRAFT_FOLLOWUP",
	description:
		"Compose a draft follow-up / check-in message to a contact on a chosen platform. Never sends — produces a preview that must be confirmed via SEND_DRAFT.",
	similes: ["COMPOSE_FOLLOWUP", "FOLLOWUP_DRAFT", "CHECK_IN_DRAFT"],
	examples: [
		[
			{
				name: "User",
				content: { text: "Draft a follow-up to Alice on Telegram" },
			},
			{
				name: "Agent",
				content: {
					text: "Drafting a follow-up — here's the preview.",
					action: "DRAFT_FOLLOWUP",
				},
			},
		],
	] as ActionExample[][],

	validate: async (): Promise<boolean> => true,

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const parsed = parseDraftFollowupParams(options);
		if ("error" in parsed) {
			logger.warn(`[DraftFollowup] ${parsed.error}`);
			return {
				success: false,
				text: parsed.error,
				error: parsed.error,
			};
		}

		const service = getDefaultTriageService();
		const record = await service.draftFollowup(runtime, {
			source: parsed.source,
			to: parsed.to,
			subject: parsed.subject,
			body: parsed.body,
			threadId: parsed.threadId,
		});

		const text = `Drafted follow-up on ${record.source}. Preview: ${record.preview}`;
		logger.info(
			`[DraftFollowup] draftId=${record.draftId} source=${record.source}`,
		);
		if (callback) {
			await callback({ text, action: "DRAFT_FOLLOWUP" });
		}

		return {
			success: true,
			text,
			data: {
				draftId: record.draftId,
				source: record.source,
				preview: record.preview,
				to: record.to.map((t) => t.identifier),
			},
		};
	},
};
