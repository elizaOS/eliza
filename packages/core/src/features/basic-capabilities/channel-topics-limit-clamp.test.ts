/**
 * Route-level tests for GET /api/channel-topics/search limit clamp.
 *
 * Exercises CHANNEL_TOPICS_SEARCH_ROUTE handler with a mocked service, asserting
 * the strict contract: trimmed decimal digits via /^\d+$/, safe integers, positive
 * limits with fallback 20 and max 100. Malformed inputs such as "5junk", "1e4",
 * "5.5", signed and unsafe integers map to the documented fallback.
 */
import { describe, expect, it, vi } from "vitest";
import { CHANNEL_TOPICS_SEARCH_ROUTE } from "./channel-topics-routes.ts";

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

function runtimeWith(svc: unknown) {
	return {
		getService: (name: string) => (name === "channel_topics" ? svc : null),
	} as never;
}

describe("channel-topics strict limit clamp", () => {
	it('falls back to 20 for partially numeric "5junk" (strict: regex rejects)', async () => {
		const searchTopics = vi.fn(() => []);
		const res = makeRes();
		await CHANNEL_TOPICS_SEARCH_ROUTE.handler?.(
			{ query: { q: "stripe", limit: "5junk" } } as never,
			res as never,
			runtimeWith({ searchTopics }),
		);
		expect(res.code).toBe(200);
		expect(searchTopics).toHaveBeenCalledWith("stripe", 20);
	});

	it('rejects exponential "1e4" -> 20 (weak Number("1e4")=10000 -> 100)', async () => {
		const searchTopics = vi.fn(() => []);
		const res = makeRes();
		await CHANNEL_TOPICS_SEARCH_ROUTE.handler?.(
			{ query: { q: "stripe", limit: "1e4" } } as never,
			res as never,
			runtimeWith({ searchTopics }),
		);
		expect(res.code).toBe(200);
		expect(searchTopics).toHaveBeenCalledWith("stripe", 20);
	});

	it('rejects exponential "1e2" -> 20 (weak Number("1e2")=100 -> 100)', async () => {
		const searchTopics = vi.fn(() => []);
		const res = makeRes();
		await CHANNEL_TOPICS_SEARCH_ROUTE.handler?.(
			{ query: { q: "stripe", limit: "1e2" } } as never,
			res as never,
			runtimeWith({ searchTopics }),
		);
		expect(res.code).toBe(200);
		expect(searchTopics).toHaveBeenCalledWith("stripe", 20);
	});

	it('rejects "0" -> 20 (parsed >0 check)', async () => {
		const searchTopics = vi.fn(() => []);
		const res = makeRes();
		await CHANNEL_TOPICS_SEARCH_ROUTE.handler?.(
			{ query: { q: "stripe", limit: "0" } } as never,
			res as never,
			runtimeWith({ searchTopics }),
		);
		expect(res.code).toBe(200);
		expect(searchTopics).toHaveBeenCalledWith("stripe", 20);
	});

	it('rejects "-5" -> 20 (regex rejects minus)', async () => {
		const searchTopics = vi.fn(() => []);
		const res = makeRes();
		await CHANNEL_TOPICS_SEARCH_ROUTE.handler?.(
			{ query: { q: "stripe", limit: "-5" } } as never,
			res as never,
			runtimeWith({ searchTopics }),
		);
		expect(res.code).toBe(200);
		expect(searchTopics).toHaveBeenCalledWith("stripe", 20);
	});

	it('rejects "5.5" -> 20 (regex rejects dot)', async () => {
		const searchTopics = vi.fn(() => []);
		const res = makeRes();
		await CHANNEL_TOPICS_SEARCH_ROUTE.handler?.(
			{ query: { q: "stripe", limit: "5.5" } } as never,
			res as never,
			runtimeWith({ searchTopics }),
		);
		expect(res.code).toBe(200);
		expect(searchTopics).toHaveBeenCalledWith("stripe", 20);
	});

	it('rejects "+5" -> 20 (regex rejects plus)', async () => {
		const searchTopics = vi.fn(() => []);
		const res = makeRes();
		await CHANNEL_TOPICS_SEARCH_ROUTE.handler?.(
			{ query: { q: "stripe", limit: "+5" } } as never,
			res as never,
			runtimeWith({ searchTopics }),
		);
		expect(res.code).toBe(200);
		expect(searchTopics).toHaveBeenCalledWith("stripe", 20);
	});

	it('allows leading zeros "007" -> 7', async () => {
		const searchTopics = vi.fn(() => []);
		const res = makeRes();
		await CHANNEL_TOPICS_SEARCH_ROUTE.handler?.(
			{ query: { q: "stripe", limit: "007" } } as never,
			res as never,
			runtimeWith({ searchTopics }),
		);
		expect(res.code).toBe(200);
		expect(searchTopics).toHaveBeenCalledWith("stripe", 7);
	});

	it('rejects unsafe integer "9007199254740993" -> 20', async () => {
		const searchTopics = vi.fn(() => []);
		const res = makeRes();
		await CHANNEL_TOPICS_SEARCH_ROUTE.handler?.(
			{ query: { q: "stripe", limit: "9007199254740993" } } as never,
			res as never,
			runtimeWith({ searchTopics }),
		);
		expect(res.code).toBe(200);
		expect(searchTopics).toHaveBeenCalledWith("stripe", 20);
	});

	it("falls back to 20 when limit is missing (undefined)", async () => {
		const searchTopics = vi.fn(() => []);
		const res = makeRes();
		await CHANNEL_TOPICS_SEARCH_ROUTE.handler?.(
			{ query: { q: "stripe" } } as never,
			res as never,
			runtimeWith({ searchTopics }),
		);
		expect(res.code).toBe(200);
		expect(searchTopics).toHaveBeenCalledWith("stripe", 20);
	});

	it('passes valid "50" through as 50', async () => {
		const searchTopics = vi.fn(() => []);
		const res = makeRes();
		await CHANNEL_TOPICS_SEARCH_ROUTE.handler?.(
			{ query: { q: "stripe", limit: "50" } } as never,
			res as never,
			runtimeWith({ searchTopics }),
		);
		expect(res.code).toBe(200);
		expect(searchTopics).toHaveBeenCalledWith("stripe", 50);
	});

	it('clamps "9999" -> 100', async () => {
		const searchTopics = vi.fn(() => []);
		const res = makeRes();
		await CHANNEL_TOPICS_SEARCH_ROUTE.handler?.(
			{ query: { q: "stripe", limit: "9999" } } as never,
			res as never,
			runtimeWith({ searchTopics }),
		);
		expect(res.code).toBe(200);
		expect(searchTopics).toHaveBeenCalledWith("stripe", 100);
	});

	it('uses first value for array limit ["5junk","20"] -> 20 (firstQueryValue)', async () => {
		const searchTopics = vi.fn(() => []);
		const res = makeRes();
		await CHANNEL_TOPICS_SEARCH_ROUTE.handler?.(
			{ query: { q: "stripe", limit: ["5junk", "20"] } } as never,
			res as never,
			runtimeWith({ searchTopics }),
		);
		expect(res.code).toBe(200);
		expect(searchTopics).toHaveBeenCalledWith("stripe", 20);
	});
});
