/**
 * Cross-channel topic search HTTP endpoint (#8927).
 *
 * GET /api/channel-topics/search?q=<query>&limit=<n> → ranks rooms whose recent
 * per-channel topic LRUs match the query, via `ChannelTopicsService.searchTopics`.
 * The in-chat counterpart is the SEARCH_CHANNEL_TOPICS action.
 */

import type { TopicSearchHit } from "../../services/channel-topics.ts";
import type { Route } from "../../types/plugin.ts";

interface TopicSearchService {
	searchTopics(query: string, limit?: number): TopicSearchHit[];
}

function firstQueryValue(value: string | string[] | undefined): string {
	if (Array.isArray(value)) return value[0] ?? "";
	return value ?? "";
}

export const CHANNEL_TOPICS_SEARCH_ROUTE: Route = {
	type: "GET",
	path: "/api/channel-topics/search",
	public: false,
	name: "channel-topics-search",
	description:
		"Search recent per-channel topics across all rooms; returns matching rooms ranked by relevance.",
	async handler(req, res, runtime) {
		const query = firstQueryValue(req.query?.q).trim();
		if (!query) {
			res.status(400).json({ error: "query parameter 'q' is required" });
			return;
		}
		const rawLimit = Number.parseInt(firstQueryValue(req.query?.limit), 10);
		const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 20;
		const svc = runtime.getService("channel_topics") as
			| (TopicSearchService & object)
			| null;
		if (!svc || typeof svc.searchTopics !== "function") {
			res
				.status(503)
				.json({ error: "channel topics service unavailable", hits: [] });
			return;
		}
		const hits = svc.searchTopics(query, limit);
		res.status(200).json({ query, count: hits.length, hits });
	},
};

export const CHANNEL_TOPICS_ROUTES: Route[] = [CHANNEL_TOPICS_SEARCH_ROUTE];
