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
		expect(searchTopics).toHaveBeenCalledWith("stripe");
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
		expect(searchTopics).toHaveBeenCalledWith("billing");
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
		expect(searchTopics).toHaveBeenCalledWith("billing dashboards");
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
		expect(res.text).toContain("No channels in the in-memory room topic index");
		expect(res.text).toContain("that topic");
		const query = (res.data as { query: string }).query;
		expect(query).not.toContain("\n");
		expect(query.length).toBeLessThanOrEqual(121);
	});

	it("returns every matching room without hidden overflow", async () => {
		const hits = Array.from({ length: 11 }, (_, index) => ({
			roomId: `room-${index}`,
			matchedTopics: ["billing"],
			topics: ["billing"],
		}));
		const result = await channelTopicSearchAction.handler(
			runtimeWith({
				searchTopics: () => hits,
				getTopicsForAllRooms: () => ({ "room-0": ["billing"] }),
			}),
			{ content: { text: "" } } as never,
			undefined,
			{ parameters: { query: "billing" } },
		);
		expect(result.values?.hasMore).toBe(false);
		expect((result.data as { hits: unknown[] }).hits).toHaveLength(11);
		expect(result.text).toContain("room-10");
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

	it("falls back to the default limit for a partially numeric value", async () => {
		const searchTopics = vi.fn(() => HITS);
		const res = makeRes();
		await CHANNEL_TOPICS_SEARCH_ROUTE.handler?.(
			{ query: { q: "stripe", limit: "5junk" } } as never,
			res as never,
			runtimeWith({ searchTopics }),
		);
		expect(res.code).toBe(200);
		expect(searchTopics).toHaveBeenCalledWith("stripe", 20);
	});

	it("clamps an oversized limit before calling the service", async () => {
		const searchTopics = vi.fn(() => HITS);
		const res = makeRes();
		await CHANNEL_TOPICS_SEARCH_ROUTE.handler?.(
			{ query: { q: "stripe", limit: "999999" } } as never,
			res as never,
			runtimeWith({ searchTopics }),
		);

		expect(res.code).toBe(200);
		expect(searchTopics).toHaveBeenCalledWith("stripe", 100);
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

describe("SEARCH_CHANNEL_TOPICS handler branch coverage (#8927)", () => {
	it("returns the unavailable result from the handler when the service is absent", async () => {
		const res = await channelTopicSearchAction.handler(
			runtimeWith(null),
			{ content: { text: "billing" } } as never,
			undefined,
			undefined,
		);
		expect(res.success).toBe(false);
		expect(res.text).toBe("Channel topic search is unavailable.");
		expect(res.values?.success).toBe(false);
		expect((res.data as { actionName: string }).actionName).toBe(
			"SEARCH_CHANNEL_TOPICS",
		);
	});

	it("validate rejects a service whose searchTopics is not callable", async () => {
		expect(
			await channelTopicSearchAction.validate?.(
				runtimeWith({ searchTopics: "not-a-function" }),
				{} as never,
			),
		).toBe(false);
	});

	it("asks for a topic when neither params nor message text supply a query", async () => {
		const searchTopics = vi.fn(() => HITS);
		const res = await channelTopicSearchAction.handler(
			runtimeWith({ searchTopics }),
			{ content: { text: "" } } as never,
			undefined,
			undefined,
		);
		expect(searchTopics).not.toHaveBeenCalled();
		expect(res.success).toBe(false);
		expect(res.text).toBe("Provide a topic to search for.");
		expect(res.values?.success).toBe(false);
	});

	it("ignores a whitespace-only param query and uses the message text", async () => {
		const searchTopics = vi.fn(() => []);
		await channelTopicSearchAction.handler(
			runtimeWith({ searchTopics }),
			{ content: { text: "invoice delays" } } as never,
			undefined,
			{ parameters: { query: "   " } },
		);
		expect(searchTopics).toHaveBeenCalledWith("invoice delays");
	});

	it("trims surrounding whitespace from an explicit param query", async () => {
		const searchTopics = vi.fn(() => []);
		await channelTopicSearchAction.handler(
			runtimeWith({ searchTopics }),
			{ content: { text: "" } } as never,
			undefined,
			{ parameters: { query: "  stripe payouts  " } },
		);
		expect(searchTopics).toHaveBeenCalledWith("stripe payouts");
	});

	it("renders joined matched topics and the null-room-count scope without getTopicsForAllRooms", async () => {
		const res = await channelTopicSearchAction.handler(
			runtimeWith({
				searchTopics: () => [
					{
						roomId: "room-9",
						matchedTopics: ["billing", "refunds"],
						topics: ["billing", "refunds"],
					},
				],
			}),
			{ content: { text: "" } } as never,
			undefined,
			{ parameters: { query: "billing" } },
		);
		expect(res.success).toBe(true);
		expect(res.values?.matchCount).toBe(1);
		expect(res.text).toContain("- room-9: billing, refunds");
		expect(res.text).toContain(
			"Scope: searched the in-memory room topic index",
		);
		const data = res.data as {
			scope: { kind: string; roomCount: number | null };
			hits: unknown[];
		};
		expect(data.scope.kind).toBe("in_memory_lru");
		expect(data.scope.roomCount).toBeNull();
		expect(data.hits).toHaveLength(1);
	});

	it("counts in-memory rooms in the no-hit scope message when getTopicsForAllRooms is present", async () => {
		const res = await channelTopicSearchAction.handler(
			runtimeWith({
				searchTopics: () => [],
				getTopicsForAllRooms: () => ({
					"room-a": ["pricing"],
					"room-b": ["roadmap"],
				}),
			}),
			{ content: { text: "" } } as never,
			undefined,
			{ parameters: { query: "nonexistent-topic" } },
		);
		expect(res.success).toBe(true);
		expect(res.values?.matchCount).toBe(0);
		expect(res.values?.hasMore).toBe(false);
		expect(res.text).toContain(
			"No channels in 2 active or hydrated room(s) in memory",
		);
		expect(res.text).toContain('"nonexistent-topic"');
	});
});
