/**
 * SEARCH_CHANNEL_TOPICS — cross-channel topic search (#8927).
 *
 * Surfaces the per-channel topic LRUs (#8925/#8926) as a query: "which channels
 * have been talking about X?". Ranks rooms whose recent topics match the query
 * tokens via `ChannelTopicsService.searchTopics`. Pairs with the
 * `/api/channel-topics/search` route registered by the basic-capabilities plugin.
 */

import type { TopicSearchHit } from "../../../services/channel-topics.ts";
import type {
	Action,
	ActionResult,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";

interface TopicSearchService {
	searchTopics(query: string, limit?: number): TopicSearchHit[];
}

function getTopicsService(
	runtime: IAgentRuntime,
): TopicSearchService | undefined {
	const svc = runtime.getService("channel_topics") as
		| (TopicSearchService & object)
		| null;
	return svc && typeof svc.searchTopics === "function" ? svc : undefined;
}

/** Pull the search query from explicit params, else the message text. */
function resolveQuery(
	message: Memory,
	options?: { parameters?: Record<string, unknown> },
): string {
	const param = options?.parameters?.query;
	if (typeof param === "string" && param.trim()) return param.trim();
	return (message.content?.text ?? "").trim();
}

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
		const hits = svc.searchTopics(query, 10);
		const text =
			hits.length === 0
				? `No channels found discussing "${query}".`
				: `Channels discussing "${query}":\n${hits
						.map((h) => `- ${h.roomId}: ${h.matchedTopics.join(", ")}`)
						.join("\n")}`;
		return {
			success: true,
			text,
			values: { success: true, matchCount: hits.length },
			data: { actionName: "SEARCH_CHANNEL_TOPICS", query, hits },
		};
	},
	examples: [],
};
