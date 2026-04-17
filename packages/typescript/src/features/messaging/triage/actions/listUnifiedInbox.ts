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
import { rankScored } from "../triage-engine.ts";
import { getDefaultTriageService } from "../triage-service.ts";
import { parseListInboxParams } from "./_shared.ts";

export const listUnifiedInboxAction: Action = {
	name: "LIST_UNIFIED_INBOX",
	description:
		"List unread messages from every connected platform as one unified feed, sorted by priority and recency. Use when the user asks 'what's in my inbox across everything' or 'show me unread across all platforms'.",
	similes: ["UNIFIED_INBOX", "LIST_MESSAGES", "SHOW_UNREAD_ACROSS"],
	examples: [
		[
			{
				name: "User",
				content: { text: "Show me unread across all platforms" },
			},
			{
				name: "Agent",
				content: {
					text: "Here's your unified inbox.",
					action: "LIST_UNIFIED_INBOX",
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
		const params = parseListInboxParams(options);
		const service = getDefaultTriageService();
		const store = service.getStore();

		const cached = store.listMessages();
		let messages = cached.filter(
			(m) => !params.sources || params.sources.includes(m.source),
		);

		if (messages.length === 0) {
			messages = await service.triage(runtime, {
				sources: params.sources,
				sinceMs: params.sinceMs,
				limit: params.limit,
			});
		} else {
			messages = rankScored(messages);
		}

		const unread = messages.filter((m) => !m.isRead);
		const limit = params.limit ?? unread.length;
		const trimmed = unread.slice(0, limit);

		logger.info(
			`[ListUnifiedInbox] returning ${trimmed.length} of ${unread.length} unread message(s)`,
		);

		const text =
			trimmed.length === 0
				? "No unread messages across connected platforms."
				: `You have ${unread.length} unread across ${new Set(unread.map((m) => m.source)).size} platform(s).`;

		if (callback) {
			await callback({ text, action: "LIST_UNIFIED_INBOX" });
		}

		return {
			success: true,
			text,
			data: {
				total: unread.length,
				returned: trimmed.length,
				messages: trimmed.map((m) => ({
					id: m.id,
					source: m.source,
					from: m.from.identifier,
					subject: m.subject ?? null,
					snippet: m.snippet,
					priority: m.triageScore?.priority ?? null,
				})),
			},
		};
	},
};
