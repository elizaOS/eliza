/**
 * SEARCH_CHANNEL_TOPICS — cross-channel topic search (#8927).
 *
 * Surfaces the per-channel topic LRUs (#8925/#8926) as a query: "which channels
 * have been talking about X?". Ranks rooms whose recent topics match the query
 * tokens via `ChannelTopicsService.searchTopics`. Pairs with the
 * `/api/channel-topics/search` route registered by the basic-capabilities plugin.
 */

import { unwrapUserMessageText } from "../../../security/incoming-message-security.ts";
import {
	CHANNEL_TOPICS_LRU_CAPACITY,
	type TopicSearchHit,
} from "../../../services/channel-topics.ts";
import type {
	Action,
	ActionResult,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import {
	describeUserReference,
	userReferenceLogView as queryLogView,
} from "../../../utils/reference-echo.ts";

interface TopicSearchService {
	searchTopics(query: string, limit?: number): TopicSearchHit[];
	getTopicsForAllRooms?(): Record<string, string[]>;
}

function getTopicsService(
	runtime: IAgentRuntime,
): TopicSearchService | undefined {
	const svc = runtime.getService("channel_topics") as
		| (TopicSearchService & object)
		| null;
	return svc && typeof svc.searchTopics === "function" ? svc : undefined;
}

/**
 * Pull the search query from explicit params, else the message text — unwrapped,
 * because on hardened connectors content.text is core's external-content
 * security envelope, not the user's words.
 */
function resolveQuery(
	message: Memory,
	options?: { parameters?: Record<string, unknown> },
): string {
	const param = options?.parameters?.query;
	if (typeof param === "string" && param.trim()) return param.trim();
	return unwrapUserMessageText(message);
}

// Blob-safe rendering rationale lives in utils/reference-echo.ts.
const describeQuery = (query: string): string =>
	describeUserReference(query, "that topic");

export const channelTopicSearchAction: Action = {
	name: "SEARCH_CHANNEL_TOPICS",
	similes: ["TOPIC_SEARCH", "FIND_CHANNELS_BY_TOPIC", "SEARCH_TOPICS"],
	description:
		"Search recent per-channel topics across all rooms and return the channels most relevant to a query.",
	parameters: [
		{
			name: "query",
			description: "Topic keywords to search for across channels.",
			required: true,
			schema: { type: "string" as const },
		},
	],
	validate: async (runtime: IAgentRuntime): Promise<boolean> =>
		getTopicsService(runtime) !== undefined,
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		options?: { parameters?: Record<string, unknown> },
	): Promise<ActionResult> => {
		const svc = getTopicsService(runtime);
		if (!svc) {
			return {
				success: false,
				text: "Channel topic search is unavailable.",
				values: { success: false },
				data: { actionName: "SEARCH_CHANNEL_TOPICS" },
			};
		}
		const query = resolveQuery(message, options);
		if (!query) {
			return {
				success: false,
				text: "Provide a topic to search for.",
				values: { success: false },
				data: { actionName: "SEARCH_CHANNEL_TOPICS" },
			};
		}
		const hits = svc.searchTopics(query);
		const roomCount = svc.getTopicsForAllRooms
			? Object.keys(svc.getTopicsForAllRooms()).length
			: null;
		const scopeText =
			roomCount === null
				? `the in-memory room topic index (up to ${CHANNEL_TOPICS_LRU_CAPACITY} recent distinct topics per active or hydrated room)`
				: `${roomCount} active or hydrated room(s) in memory (up to ${CHANNEL_TOPICS_LRU_CAPACITY} recent distinct topics per room)`;
		const text =
			hits.length === 0
				? `No channels in ${scopeText} matched ${describeQuery(query)}.`
				: `Channels discussing ${describeQuery(query)}:\n${hits
						.map((h) => `- ${h.roomId}: ${h.matchedTopics.join(", ")}`)
						.join(
							"\n",
						)}\n\nScope: searched ${scopeText}; rooms not active or hydrated since process start were not scanned.`;
		return {
			success: true,
			text,
			values: { success: true, matchCount: hits.length, hasMore: false },
			data: {
				actionName: "SEARCH_CHANNEL_TOPICS",
				query: queryLogView(query),
				hits,
				scope: {
					kind: "in_memory_lru",
					roomCount,
					topicsPerRoom: CHANNEL_TOPICS_LRU_CAPACITY,
					hasMore: false,
				},
			},
		};
	},
	examples: [],
};
