/**
 * The read-only cross-channel search action for the messaging-triage
 * capability, registered under the shared `MESSAGE` action name. It runs
 * combinable filters (source/connector, world/account, channel, sender,
 * content keyword, tags, time range) through the TriageService and returns
 * merged, cited hits with priority annotations. Strictly non-mutating —
 * drafting, replying, sending, and other message mutations are handled by the
 * sibling triage actions.
 */
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
import {
	describeMessageScope,
	parseSearchMessagesParams,
	validateMessageAction,
} from "./_shared.ts";

export const searchMessagesAction: Action = {
	name: "MESSAGE",
	contexts: ["messaging", "email", "documents"],
	roleGate: { minRole: "ADMIN" },
	description:
		"Read-only search across connected message channels with combinable filters: source/connector, world (account), channel, sender, content keyword, tags, time range. Returns merged hits with citations. Do not use for requests to draft, reply, send, unsubscribe, block, archive, trash, label, or otherwise mutate messages; use MESSAGE, MESSAGE, MESSAGE, or MESSAGE instead.",
	descriptionCompressed:
		"read-only search msgs; not for draft reply send unsubscribe archive trash label mutate",
	similes: [
		"SEARCH_MESSAGES",
		"MESSAGE_SEARCH",
		"SEARCH_INBOX",
		"SEARCH_CHAT",
		"FIND_MESSAGE",
		"FIND_MESSAGES",
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
		_callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const filters = parseSearchMessagesParams(options);
		const service = getDefaultTriageService();
		const { refs: hits, receipt } = await service.searchWithReceipt(
			runtime,
			filters,
		);

		const sourcesHit = new Set(hits.map((m) => m.source));
		// The filters are the search: an empty result that claims coverage
		// "across connected channels" tells the user nobody messaged them about
		// X when the message sits in a source or time window the planner filtered
		// out, and a limit-capped count reads as the total.
		const scope = describeMessageScope({
			requestedSources: filters.sources,
			registeredSources: service.listRegisteredSources(),
			coverage: { kind: "swept", receipt },
			worldIds: filters.worldIds,
			channelIds: filters.channelIds,
			sender: filters.sender,
			content: filters.content,
			tags: filters.tags,
			sinceMs: filters.sinceMs,
			untilMs: filters.untilMs,
			limit: filters.limit,
		});
		const capped =
			typeof filters.limit === "number" && hits.length >= filters.limit;
		const text =
			hits.length === 0
				? `No matching messages found in the searched scope (${scope}). This is a filtered search, not a statement that no such message exists — drop or widen the filters to search everything.`
				: `Found ${hits.length} match(es) across ${sourcesHit.size} channel(s) in the searched scope (${scope}).${
						capped
							? ` The ${filters.limit}-result limit was reached, so more may match.`
							: ""
					}`;

		logger.info(
			`[SearchMessages] ${hits.length} hits across [${[...sourcesHit].join(",")}]`,
		);

		// No visible callback: the match count is not the user's answer — the
		// evaluator presents the matches from data.messages in voice.
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
					contactWeight: m.triageScore?.contactWeight ?? null,
				})),
			},
		};
	},
};
