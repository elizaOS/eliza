/**
 * Deterministic unit tests for the channel-topics search capability (#8927): the
 * SEARCH_CHANNEL_TOPICS action and the GET /api/channel-topics/search route. The
 * `channel_topics` service is a vi.fn stub, covering validate gating on service
 * presence, param-vs-message-text query resolution, the external-content
 * envelope unwrap/echo-clamp regression, and the route's 200/400/503 status
 * contract.
 */
import { describe, expect, it, vi } from "vitest";
import { hardenIncomingUserMessage } from "../../security/incoming-message-security.ts";
import { CHANNEL_TOPICS_LRU_CAPACITY } from "../../services/channel-topics.ts";
import type { Memory } from "../../types/memory.ts";
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

	it("unwraps a hardened message and never echoes the security envelope", async () => {
		const searchTopics = vi.fn(() => []);
		// A message as a hardened connector delivers it: content.text is core's
		// external-content envelope with the user's sentence as payload.
		const memory = {
			content: { text: "billing dashboards", source: "discord" },
		} as unknown as Memory;
		hardenIncomingUserMessage(memory);
		expect(memory.content.text).toContain("SECURITY NOTICE");
		expect(memory.content.text).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT>>>");

		const res = await channelTopicSearchAction.handler(
			runtimeWith({ searchTopics }),
			memory as never,
			undefined,
			undefined,
		);
		// Matching runs on the user's words, not the envelope.
		expect(searchTopics).toHaveBeenCalledWith("billing dashboards", 10);
		expect(res.text).not.toContain("EXTERNAL_UNTRUSTED_CONTENT");
		expect(res.text).not.toContain("SECURITY NOTICE");
		expect(res.text).toContain('"billing dashboards"');
		const query = (res.data as { query: string }).query;
		expect(query).not.toContain("\n");
		expect(query.length).toBeLessThanOrEqual(121);
	});

	it("renders a blob-shaped planner query as a neutral noun", async () => {
		const blob = `first line of a pasted document\n${"lorem ipsum ".repeat(30)}`;
		const res = await channelTopicSearchAction.handler(
			runtimeWith({ searchTopics: vi.fn(() => []) }),
			{ content: { text: "" } } as never,
			undefined,
			{ parameters: { query: blob } },
		);
		expect(res.text).toContain("No channels found discussing that topic.");
		// The blob is named, never echoed.
		expect(res.text).not.toContain("lorem ipsum");
		expect(res.text).not.toContain("first line of a pasted document");
		const query = (res.data as { query: string }).query;
		expect(query).not.toContain("\n");
		expect(query.length).toBeLessThanOrEqual(121);
	});

	// Scope disclosure: the corpus is the per-room topic LRU — rooms touched
	// since process start, each capped at CHANNEL_TOPICS_LRU_CAPACITY topics —
	// and the action takes the top 10 hits. A bare "no channels found" reads as
	// "no channel has ever discussed this".
	it("names the searched room count and the topic-memory limits when empty", async () => {
		const res = await channelTopicSearchAction.handler(
			runtimeWith({
				searchTopics: vi.fn(() => []),
				getTopicsForAllRooms: () => ({ "room-a": ["billing"] }),
			}),
			{ content: { text: "" } } as never,
			undefined,
			{ parameters: { query: "stripe" } },
		);
		expect(res.text).not.toBe("No channels found discussing that topic.");
		expect(res.text).toContain("1 room(s) with topics in memory");
		expect(res.text).toContain("since the last restart");
		expect(res.text).toContain(`last ${CHANNEL_TOPICS_LRU_CAPACITY} topics`);
	});

	it("says the hit limit was reached instead of reporting it as the total", async () => {
		const hits = Array.from({ length: 10 }, (_, i) => ({
			roomId: `room-${i}`,
			matchedTopics: ["stripe payout"],
			topics: ["stripe payout"],
		}));
		const res = await channelTopicSearchAction.handler(
			runtimeWith({
				searchTopics: vi.fn(() => hits),
				getTopicsForAllRooms: () =>
					Object.fromEntries(hits.map((h) => [h.roomId, h.topics])),
			}),
			{ content: { text: "" } } as never,
			undefined,
			{ parameters: { query: "stripe" } },
		);
		expect(res.text).toContain("10-hit limit was reached");
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
