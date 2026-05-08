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
	limitParameter,
	messageSourceParameter,
	parseTriageParams,
	sinceMsParameter,
	validateMessageAction,
} from "./_shared.ts";

export const triageMessagesAction: Action = {
	name: "MESSAGE",
	contexts: ["messaging", "email", "documents"],
	roleGate: { minRole: "ADMIN" },
	description:
		"Fetch unread/recent messages across connected platforms (gmail, discord, telegram, twitter, imessage, signal, whatsapp), score each one with deterministic contact+urgency heuristics, and return a priority-ranked list.",
	similes: [
		"TRIAGE_INBOX",
		"PRIORITIZE_MESSAGES",
		"RANK_INBOX",
		"SCAN_MESSAGES",
	],
	parameters: [messageSourceParameter, limitParameter, sinceMsParameter],
	examples: [
		[
			{
				name: "User",
				content: { text: "Triage my messages" },
			},
			{
				name: "Agent",
				content: {
					text: "Scanning your inboxes and ranking by priority.",
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
		validateMessageAction(message, state, ["messaging", "email", "documents"]),

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const params = parseTriageParams(options);
		const service = getDefaultTriageService();
		const ranked = await service.triage(runtime, {
			sources: params.sources,
			sinceMs: params.sinceMs,
			limit: params.limit,
		});

		const summary =
			ranked.length === 0
				? "No new messages across connected platforms."
				: `Triaged ${ranked.length} message(s). Top priority: ${ranked[0].triageScore?.priority ?? "unknown"}.`;

		logger.info(`[TriageMessages] ${summary}`);

		if (callback) {
			await callback({
				text: summary,
				action: "MESSAGE",
			});
		}

		return {
			success: true,
			text: summary,
			data: {
				count: ranked.length,
				messages: ranked.map((m) => ({
					id: m.id,
					source: m.source,
					from: m.from.identifier,
					subject: m.subject ?? null,
					snippet: m.snippet,
					priority: m.triageScore?.priority ?? null,
					suggestedAction: m.triageScore?.suggestedAction ?? null,
				})),
			},
		};
	},
};
