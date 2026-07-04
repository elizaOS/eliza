/**
 * Deterministic unit tests for the channel-topics search capability (#8927): the
 * SEARCH_CHANNEL_TOPICS action and the GET /api/channel-topics/search route. The
 * `channel_topics` service is a vi.fn stub, covering validate gating on service
 * presence, param-vs-message-text query resolution, and the route's 200/400/503
 * status contract.
 */
import { describe, expect, it, vi } from "vitest";
import { channelTopicSearchAction } from "./actions/channel-topic-search.ts";
import { CHANNEL_TOPICS_SEARCH_ROUTE } from "./channel-topics-routes.ts";

const HITS = [
	{
		roomId: "room-a",
		matchedTopics: ["stripe payout"],
		topics: ["stripe payout"],
	},
];

function runtimeWith(svc: unknown) {
	return {
		getService: (name: string) => (name === "channel_topics" ? svc : null),
	} as never;
}

describe("SEARCH_CHANNEL_TOPICS action (#8927)", () => {
	it("validates only when the topics service is present", async () => {
		expect(
			await channelTopicSearchAction.validate?.(
				runtimeWith({ searchTopics: () => [] }),
				{} as never,
			),
		).toBe(true);
		expect(
			await channelTopicSearchAction.validate?.(runtimeWith(null), {} as never),
		).toBe(false);
	});

	it("searches with the param query and returns ranked rooms", async () => {
		const searchTopics = vi.fn(() => HITS);
		const res = await channelTopicSearchAction.handler(
			runtimeWith({ searchTopics }),
			{ content: { text: "" } } as never,
			undefined,
			{ parameters: { query: "stripe" } },
		);
		expect(searchTopics).toHaveBeenCalledWith("stripe", 10);
		expect(res.values?.success).toBe(true);
		expect(res.values?.matchCount).toBe(1);
		expect(res.text).toContain("room-a");
	});

	it("falls back to message text when no param query", async () => {
		const searchTopics = vi.fn(() => []);
		await channelTopicSearchAction.handler(
			runtimeWith({ searchTopics }),
			{ content: { text: "billing" } } as never,
			undefined,
			undefined,
		);
		expect(searchTopics).toHaveBeenCalledWith("billing", 10);
	});
});

describe("GET /api/channel-topics/search (#8927)", () => {
	function makeRes() {
		const res = {
			code: 0,
			body: undefined as unknown,
			status(c: number) {
				res.code = c;
				return res;
			},
			json(b: unknown) {
				res.body = b;
				return res;
			},
		};
		return res;
	}

	it("returns 200 with hits for a query", async () => {
		const res = makeRes();
		await CHANNEL_TOPICS_SEARCH_ROUTE.handler?.(
			{ query: { q: "stripe", limit: "5" } } as never,
			res as never,
			runtimeWith({ searchTopics: () => HITS }),
		);
		expect(res.code).toBe(200);
		expect((res.body as { count: number }).count).toBe(1);
	});

	it("returns 400 when q is missing", async () => {
		const res = makeRes();
		await CHANNEL_TOPICS_SEARCH_ROUTE.handler?.(
			{ query: {} } as never,
			res as never,
			runtimeWith({ searchTopics: () => [] }),
		);
		expect(res.code).toBe(400);
	});

	it("returns 503 when the service is unavailable", async () => {
		const res = makeRes();
		await CHANNEL_TOPICS_SEARCH_ROUTE.handler?.(
			{ query: { q: "x" } } as never,
			res as never,
			runtimeWith(null),
		);
		expect(res.code).toBe(503);
	});
});
