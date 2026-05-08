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
import { ALL_MESSAGE_SOURCES } from "../types.ts";
import { parseSearchMessagesParams, validateMessageAction } from "./_shared.ts";

export const searchMessagesAction: Action = {
	name: "MESSAGE",
	contexts: ["messaging", "email", "documents"],
	roleGate: { minRole: "ADMIN" },
	description:
		"Read-only search across connected message channels with combinable filters: source/connector, world (account), channel, sender, content keyword, tags, time range. Returns merged hits with citations. Do not use for requests to draft, reply, send, unsubscribe, block, archive, trash, label, or otherwise mutate messages; use MESSAGE, MESSAGE, MESSAGE, or MESSAGE instead.",
	descriptionCompressed:
		"read-only search msgs; not for draft reply send unsubscribe archive trash label mutate",
	similes: [
		"SEARCH_INBOX",
		"FIND_MESSAGE",
		"SEARCH_EMAIL",
		"SEARCH_CHATS",
		"CROSS_CHANNEL_SEARCH",
	],
	parameters: [
		{
			name: "content",
			description: "Message text or keyword query.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "sources",
			description:
				"Optional message sources to search, such as email, slack, discord, imessage, signal, whatsapp, telegram, or x.",
			required: false,
			schema: {
				type: "array" as const,
				items: { type: "string" as const, enum: [...ALL_MESSAGE_SOURCES] },
			},
		},
		{
			name: "sender",
			description:
				"Sender identifier, handle, or object with identifier/displayName.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "limit",
			description: "Maximum messages to return.",
			required: false,
			schema: { type: "number" as const, minimum: 1, maximum: 100 },
		},
		{
			name: "since",
			description: "Start timestamp or parseable date for the search window.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "until",
			description: "End timestamp or parseable date for the search window.",
			required: false,
			schema: { type: "string" as const },
		},
	],
	examples: [
		[
			{
				name: "User",
				content: { text: "Find emails from Alice about the launch this week" },
			},
			{
				name: "Agent",
				content: {
					text: "Searching across connected channels.",
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
		const filters = parseSearchMessagesParams(options);
		const service = getDefaultTriageService();
		const hits = await service.search(runtime, filters);

		const sourcesHit = new Set(hits.map((m) => m.source));
		const text =
			hits.length === 0
				? "No matching messages found across connected channels."
				: `Found ${hits.length} match(es) across ${sourcesHit.size} channel(s).`;

		logger.info(
			`[SearchMessages] ${hits.length} hits across [${[...sourcesHit].join(",")}]`,
		);

		if (callback) {
			await callback({ text, action: "MESSAGE" });
		}

		return {
			success: true,
			text,
			data: {
				count: hits.length,
				messages: hits.map((m) => ({
					id: m.id,
					source: m.source,
					worldId: m.worldId ?? null,
					channelId: m.channelId ?? null,
					from: m.from.identifier,
					subject: m.subject ?? null,
					snippet: m.snippet,
					receivedAtMs: m.receivedAtMs,
					tags: m.tags ?? [],
					priority: m.triageScore?.priority ?? null,
				})),
			},
		};
	},
};
