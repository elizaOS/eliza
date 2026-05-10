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
	draftIdParameter,
	parseScheduleDraftSendParams,
	validateMessageAction,
} from "./_shared.ts";

export const scheduleDraftSendAction: Action = {
	name: "MESSAGE",
	contexts: ["messaging", "email", "calendar", "automation"],
	roleGate: { minRole: "ADMIN" },
	description:
		"Schedule a previously created draft to send at a future time. Uses the adapter's native scheduling if supported; otherwise enqueues a process-local timer.",
	descriptionCompressed:
		"schedule draft send sendAtMs adapter-native or fallback queue",
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

		const text = `Scheduled draft ${parsed.draftId} for ${new Date(parsed.sendAtMs).toISOString()}.`;
		logger.info(
			`[ScheduleDraftSend] draftId=${parsed.draftId} sendAtMs=${parsed.sendAtMs} scheduledId=${updated.scheduledId ?? "unknown"}`,
		);
		if (callback) {
			await callback({ text, action: "MESSAGE" });
		}
		return {
			success: true,
			text,
			data: {
				draftId: updated.draftId,
				source: updated.source,
				scheduledForMs: updated.scheduledForMs ?? parsed.sendAtMs,
				scheduledId: updated.scheduledId ?? null,
			},
		};
	},
};
