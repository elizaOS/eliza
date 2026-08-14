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
	/** Present on ChannelTopicsService; used only to measure the scanned scope. */
	getTopicsForAllRooms?(): Record<string, string[]>;
}

/** Hits returned per search; the corpus can hold more matching rooms. */
const TOPIC_SEARCH_LIMIT = 10;

/**
 * State the real reach of a topic search. The corpus is the per-room topic LRU:
 * only rooms touched since process start, only each room's last
 * {@link CHANNEL_TOPICS_LRU_CAPACITY} topics, and only the top
 * {@link TOPIC_SEARCH_LIMIT} hits. Without that, a flat "no channels found"
 * reads as "no channel has ever discussed this".
 */
function describeTopicScope(svc: TopicSearchService, hitCount: number): string {
	const rooms = svc.getTopicsForAllRooms?.();
	const roomNote =
		rooms === undefined
			? "the rooms with topics in memory"
			: `${Object.keys(rooms).length} room(s) with topics in memory`;
	const capNote =
		hitCount >= TOPIC_SEARCH_LIMIT
			? ` The ${TOPIC_SEARCH_LIMIT}-hit limit was reached, so more channels may match.`
			: "";
	return ` Searched ${roomNote}: topic memory covers only rooms active since the last restart, and only each room's last ${CHANNEL_TOPICS_LRU_CAPACITY} topics.${capNote}`;
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
		const hits = svc.searchTopics(query, TOPIC_SEARCH_LIMIT);
		const scope = describeTopicScope(svc, hits.length);
		const text =
			hits.length === 0
				? `No channels found discussing ${describeQuery(query)}.${scope}`
				: `Channels discussing ${describeQuery(query)}:${scope}\n${hits
						.map((h) => `- ${h.roomId}: ${h.matchedTopics.join(", ")}`)
						.join("\n")}`;
		return {
			success: true,
			text,
			values: { success: true, matchCount: hits.length },
			data: {
				actionName: "SEARCH_CHANNEL_TOPICS",
				query: queryLogView(query),
				hits,
			},
		};
	},
	examples: [],
};
