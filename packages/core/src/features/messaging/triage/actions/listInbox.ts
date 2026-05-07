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
import { ALL_MESSAGE_SOURCES } from "../types.ts";
import { parseListInboxParams, validateMessageAction } from "./_shared.ts";

export const listInboxAction: Action = {
	name: "LIST_INBOX",
	contexts: ["messaging", "email", "connectors"],
	roleGate: { minRole: "ADMIN" },
	description:
		"List unread messages from every connected platform as one feed, sorted by priority and recency. Use when the user asks 'what's in my inbox across everything' or 'show me unread across all platforms'.",
	similes: ["LIST_MESSAGES", "SHOW_UNREAD_ACROSS"],
	parameters: [
		{
			name: "sources",
			description:
				"Optional message sources to include, such as email, slack, discord, imessage, signal, whatsapp, telegram, or x.",
			required: false,
			schema: {
				type: "array" as const,
				items: { type: "string" as const, enum: [...ALL_MESSAGE_SOURCES] },
			},
		},
		{
			name: "limit",
			description: "Maximum unread messages to return.",
			required: false,
			schema: { type: "number" as const, minimum: 1, maximum: 100 },
		},
		{
			name: "sinceMs",
			description: "Only include messages received at or after this timestamp.",
			required: false,
			schema: { type: "number" as const },
		},
	],
	examples: [
		[
			{
				name: "User",
				content: { text: "Show me unread across all platforms" },
			},
			{
				name: "Agent",
				content: {
					text: "Here's your inbox.",
					action: "LIST_INBOX",
				},
			},
		],
	] as ActionExample[][],

	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		state?: State,
	): Promise<boolean> =>
		validateMessageAction(message, state, ["messaging", "email", "connectors"]),

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		try {
			const params = parseListInboxParams(options);
			const service = getDefaultTriageService();
			const store = service.getStore();

			const cached = store.listMessages();
			let messages = cached.filter((m) => !params.sources?.includes(m.source));

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
				`[ListInbox] returning ${trimmed.length} of ${unread.length} unread message(s)`,
			);

			const text =
				trimmed.length === 0
					? "No unread messages across connected platforms."
					: `You have ${unread.length} unread across ${new Set(unread.map((m) => m.source)).size} platform(s).`;

			if (callback) {
				await callback({ text, action: "LIST_INBOX" });
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
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn(`[ListInbox] failed: ${message}`);
			return {
				success: false,
				text: `Failed to list inbox: ${message}`,
				error: message,
				data: { actionName: "LIST_INBOX" },
			};
		}
	},
};
