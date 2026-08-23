/**
 * Deterministic unit coverage for the channel-topics HTTP route contract.
 *
 * The suite drives the real route handler with an in-memory response recorder
 * and a minimal channel-topics service, covering request normalization, limit
 * validation, unavailable-service failures, and successful response shaping.
 */

import { describe, expect, it, vi } from "vitest";
import type { TopicSearchHit } from "../../services/channel-topics.ts";
import {
	CHANNEL_TOPICS_ROUTES,
	CHANNEL_TOPICS_SEARCH_ROUTE,
} from "./channel-topics-routes.ts";

function createResponse() {
	const response = {
		statusCode: 0,
		body: undefined as unknown,
		status(code: number) {
			response.statusCode = code;
			return response;
		},
		json(body: unknown) {
			response.body = body;
			return response;
		},
	};
	return response;
}

function createRuntime(service: unknown) {
	return {
		getService: vi.fn((name: string) =>
			name === "channel_topics" ? service : null,
		),
	} as never;
}

async function invokeRoute(
	query: Record<string, string | string[] | undefined>,
) {
	const response = createResponse();
	const searchTopics = vi.fn<
		(query: string, limit?: number) => TopicSearchHit[]
	>(() => []);
	const runtime = createRuntime({ searchTopics });
	const handler = CHANNEL_TOPICS_SEARCH_ROUTE.handler;
	if (!handler) throw new Error("channel-topics search route has no handler");

	await handler({ query } as never, response as never, runtime);
	return { response, runtime, searchTopics };
}

describe("channel-topics routes", () => {
	it("exports the private GET search route in the route collection", () => {
		expect(CHANNEL_TOPICS_SEARCH_ROUTE).toMatchObject({
			type: "GET",
			path: "/api/channel-topics/search",
			public: false,
			name: "channel-topics-search",
		});
		expect(CHANNEL_TOPICS_ROUTES).toEqual([CHANNEL_TOPICS_SEARCH_ROUTE]);
	});

	it.each([
		[{}, "missing query"],
		[{ q: "   " }, "blank query"],
		[{ q: [] }, "empty query array"],
	] as const)("returns 400 for a %s", async (query) => {
		const { response, searchTopics } = await invokeRoute(query);

		expect(response.statusCode).toBe(400);
		expect(response.body).toEqual({
			error: "query parameter 'q' is required",
		});
		expect(searchTopics).not.toHaveBeenCalled();
	});

	it("uses and trims the first query and limit values", async () => {
		const { response, searchTopics } = await invokeRoute({
			q: ["  billing  ", "ignored"],
			limit: [" 7 ", "99"],
		});

		expect(searchTopics).toHaveBeenCalledExactlyOnceWith("billing", 7);
		expect(response.statusCode).toBe(200);
	});

	it.each([
		[undefined, 20],
		[[], 20],
		["", 20],
		["0", 20],
		["-1", 20],
		["1.5", 20],
		["12items", 20],
		["9007199254740993", 20],
		["0012", 12],
		["100", 100],
		["101", 100],
	] as const)("normalizes limit %j to %d", async (limit, expected) => {
		const { searchTopics } = await invokeRoute({ q: "topic", limit });

		expect(searchTopics).toHaveBeenCalledExactlyOnceWith("topic", expected);
	});

	it.each([null, {}])(
		"returns 503 when the channel-topics service is %j",
		async (service) => {
			const response = createResponse();
			const runtime = createRuntime(service);
			const handler = CHANNEL_TOPICS_SEARCH_ROUTE.handler;
			if (!handler)
				throw new Error("channel-topics search route has no handler");

			await handler(
				{ query: { q: "billing" } } as never,
				response as never,
				runtime,
			);

			expect(response.statusCode).toBe(503);
			expect(response.body).toEqual({
				error: "channel topics service unavailable",
				hits: [],
			});
		},
	);

	it("returns the service hits and their exact count", async () => {
		const hits: TopicSearchHit[] = [
			{
				roomId: "room-a" as never,
				matchedTopics: ["billing"],
				topics: ["billing", "invoices"],
			},
			{
				roomId: "room-b" as never,
				matchedTopics: ["billing"],
				topics: ["billing"],
			},
		];
		const searchTopics = vi.fn(() => hits);
		const response = createResponse();
		const handler = CHANNEL_TOPICS_SEARCH_ROUTE.handler;
		if (!handler) throw new Error("channel-topics search route has no handler");

		await handler(
			{ query: { q: " billing ", limit: "2" } } as never,
			response as never,
			createRuntime({ searchTopics }),
		);

		expect(response.statusCode).toBe(200);
		expect(response.body).toEqual({ query: "billing", count: 2, hits });
		expect(searchTopics).toHaveBeenCalledExactlyOnceWith("billing", 2);
	});
});
