/**
 * Load-bearing regression coverage for #24165: the module-scoped profile
 * caches must stay bounded with newest-wins eviction.
 *
 * Red-before/green-after through the exported resolution paths:
 * - After inserting more than the cap of distinct message keys, rereading the
 *   OLDEST key performs one additional provider fetch (it was evicted).
 * - Rereading the NEWEST key performs no fetch (cache hit).
 * - Rewriting a key moves it to the newest slot (refresh-on-write).
 * - Expired entries are dropped on read (deterministic clock).
 * - The same eviction contract holds for user profiles and null results.
 *
 * Module-scoped cache state is reset between tests via the supported
 * test-only reset seam, so suites never share state.
 */
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../discord-avatar-cache", () => ({
	cacheDiscordAvatarUrl: vi.fn(async () => {}),
}));

import {
	__resetProfileCachesForTests,
	resolveDiscordMessageAuthorProfile,
	resolveDiscordUserProfile,
} from "../discord-profiles";

const MAX_ENTRIES = 512;

type FetchFn = ReturnType<typeof vi.fn>;

function makeMessageRuntime(messagesFetch: FetchFn): AgentRuntime {
	const client = {
		channels: {
			cache: { get: () => undefined },
			fetch: async () => ({ messages: { fetch: messagesFetch } }),
		},
	};
	return { getService: () => ({ client }) } as unknown as AgentRuntime;
}

function makeUserRuntime(usersFetch: FetchFn): AgentRuntime {
	const client = {
		users: { fetch: usersFetch },
	};
	return { getService: () => ({ client }) } as unknown as AgentRuntime;
}

describe("discord profile cache bound (#24165)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-22T00:00:00Z"));
		__resetProfileCachesForTests();
	});

	afterEach(() => {
		vi.useRealTimers();
		__resetProfileCachesForTests();
	});

	it("evicts the oldest message-author key past the cap and refetches it", async () => {
		const messagesFetch = vi.fn(async (messageId: string) => ({
			id: messageId,
			author: { id: messageId, username: messageId, displayName: null },
			member: null,
		}));
		const runtime = makeMessageRuntime(messagesFetch);

		for (let i = 0; i < MAX_ENTRIES + 1; i++) {
			await resolveDiscordMessageAuthorProfile(runtime, "ch", String(i));
		}
		expect(messagesFetch.mock.calls.length).toBe(MAX_ENTRIES + 1);

		// Oldest key was evicted → refetch.
		await resolveDiscordMessageAuthorProfile(runtime, "ch", "0");
		expect(messagesFetch.mock.calls.length).toBe(MAX_ENTRIES + 2);

		// Newest key still cached → no fetch.
		const before = messagesFetch.mock.calls.length;
		await resolveDiscordMessageAuthorProfile(runtime, "ch", String(MAX_ENTRIES));
		expect(messagesFetch.mock.calls.length).toBe(before);
	});

	it("moves a rewritten key to the newest slot (refresh-on-write)", async () => {
		const messagesFetch = vi.fn(async (messageId: string) => ({
			id: messageId,
			author: { id: messageId, username: messageId, displayName: null },
			member: null,
		}));
		const runtime = makeMessageRuntime(messagesFetch);

		// Fill to the cap with keys 0..511.
		for (let i = 0; i < MAX_ENTRIES; i++) {
			await resolveDiscordMessageAuthorProfile(runtime, "ch", String(i));
		}
		// Rewrite key 0 (now the oldest slot).
		await resolveDiscordMessageAuthorProfile(runtime, "ch", "0");
		expect(messagesFetch.mock.calls.length).toBe(MAX_ENTRIES + 1);

		// Insert one more key: eviction must take the NEW oldest (key 1),
		// not the rewritten key 0 (which moved to newest).
		await resolveDiscordMessageAuthorProfile(runtime, "ch", String(MAX_ENTRIES));
		const before = messagesFetch.mock.calls.length;
		await resolveDiscordMessageAuthorProfile(runtime, "ch", "0");
		expect(messagesFetch.mock.calls.length).toBe(before); // key 0 still cached
		await resolveDiscordMessageAuthorProfile(runtime, "ch", "1");
		expect(messagesFetch.mock.calls.length).toBe(before + 1); // key 1 evicted
	});

	it("drops expired entries on read (deterministic clock)", async () => {
		const messagesFetch = vi.fn(async (messageId: string) => ({
			id: messageId,
			author: { id: messageId, username: messageId, displayName: null },
			member: null,
		}));
		const runtime = makeMessageRuntime(messagesFetch);

		await resolveDiscordMessageAuthorProfile(runtime, "ch", "1");
		expect(messagesFetch.mock.calls.length).toBe(1);

		// Advance past the 5-minute TTL.
		vi.setSystemTime(new Date("2026-08-22T00:06:00Z"));
		await resolveDiscordMessageAuthorProfile(runtime, "ch", "1");
		expect(messagesFetch.mock.calls.length).toBe(2); // expired → refetch
	});

	it("evicts the oldest user-profile key past the cap", async () => {
		const usersFetch = vi.fn(async (userId: string) => ({
			id: userId,
			username: userId,
			displayName: null,
		}));
		const runtime = makeUserRuntime(usersFetch);

		for (let i = 0; i < MAX_ENTRIES + 1; i++) {
			await resolveDiscordUserProfile(runtime, `user-${i}`);
		}
		expect(usersFetch.mock.calls.length).toBe(MAX_ENTRIES + 1);

		await resolveDiscordUserProfile(runtime, "user-0");
		expect(usersFetch.mock.calls.length).toBe(MAX_ENTRIES + 2);
	});

	it("bounds null results (failure path) the same way", async () => {
		const messagesFetch = vi.fn(async () => null);
		const runtime = makeMessageRuntime(messagesFetch);

		for (let i = 0; i < MAX_ENTRIES + 1; i++) {
			await resolveDiscordMessageAuthorProfile(runtime, "ch", String(i));
		}
		// Oldest null entry evicted → refetch.
		await resolveDiscordMessageAuthorProfile(runtime, "ch", "0");
		expect(messagesFetch.mock.calls.length).toBe(MAX_ENTRIES + 2);
	});
});
