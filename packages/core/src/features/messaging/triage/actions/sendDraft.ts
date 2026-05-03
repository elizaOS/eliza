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
import { parseSendDraftParams } from "./_shared.ts";

/**
 * SAFETY INVARIANT: SEND_DRAFT must never send without an explicit
 * `confirmed: true` parameter. When confirmation is missing the handler
 * returns the preview and asks the user to confirm.
 */
export const sendDraftAction: Action = {
	name: "SEND_DRAFT",
	description:
		"Send a previously drafted message. Requires confirmed=true; without it, returns the preview and asks for confirmation.",
	similes: ["SEND_MESSAGE", "DISPATCH_DRAFT", "CONFIRM_AND_SEND"],
	examples: [
		[
			{
				name: "User",
				content: { text: "Send the draft" },
			},
			{
				name: "Agent",
				content: {
					text: "Sent.",
					action: "SEND_DRAFT",
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
		const parsed = parseSendDraftParams(options);
		if ("error" in parsed) {
			logger.warn(`[SendDraft] ${parsed.error}`);
			return { success: false, text: parsed.error, error: parsed.error };
		}

		const service = getDefaultTriageService();
		const existing = service.getStore().getDraft(parsed.draftId);
		if (!existing) {
			const msg = `No draft found for id ${parsed.draftId}`;
			logger.warn(`[SendDraft] ${msg}`);
			return { success: false, text: msg, error: msg };
		}

		if (!parsed.confirmed) {
			const text = `Confirmation required before sending draft ${parsed.draftId}. Preview: ${existing.preview}`;
			logger.info(`[SendDraft] confirmation gate: draftId=${parsed.draftId}`);
			if (callback) {
				await callback({ text, action: "SEND_DRAFT" });
			}
			return {
				success: false,
				text,
				data: {
					requiresConfirmation: true,
					preview: existing.preview,
					draftId: existing.draftId,
					source: existing.source,
				},
			};
		}

		const sent = await service.sendDraft(runtime, parsed.draftId);
		const text = `Sent draft ${parsed.draftId} on ${sent.source}.`;
		logger.info(
			`[SendDraft] sent draftId=${parsed.draftId} externalId=${sent.sentExternalId ?? "unknown"}`,
		);
		if (callback) {
			await callback({ text, action: "SEND_DRAFT" });
		}
		return {
			success: true,
			text,
			data: {
				draftId: sent.draftId,
				source: sent.source,
				externalId: sent.sentExternalId ?? null,
			},
		};
	},
};
