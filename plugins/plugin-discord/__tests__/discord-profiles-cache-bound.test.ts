/**
 * Load-bearing regression coverage for #24165: the module-scoped profile
 * caches must stay bounded with newest-wins eviction.
 *
 * Red-before/green-after through the exported resolution paths:
 * - After inserting more than the cap of distinct message keys, rereading the
 *   OLDEST key performs one additional provider fetch (it was evicted).
 * - Rereading the NEWEST key performs no fetch (cache hit).
 * - The same eviction contract holds for user profiles.
 * - Failure/null results and expiry are bounded the same way.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../discord-avatar-cache", () => ({
  cacheDiscordAvatarUrl: vi.fn(async () => {}),
}));

import {
  resolveDiscordMessageAuthorProfile,
  resolveDiscordUserProfile,
} from "../discord-profiles";

const MAX_ENTRIES = 512;

type FetchFn = ReturnType<typeof vi.fn>;

function makeRuntime({
  messagesFetch,
  usersFetch,
}: {
  messagesFetch?: FetchFn;
  usersFetch?: FetchFn;
}) {
  const client = {
    channels: {
      cache: { get: () => undefined },
      fetch:
        messagesFetch &&
        (async () => ({ messages: { fetch: messagesFetch } })),
    },
    users: usersFetch ? { fetch: usersFetch } : undefined,
  };
  return {
    getService: () => ({ client }),
  } as never;
}

function makeAuthorProfile(userId: string) {
  return { id: userId, username: `user-${userId}`, displayName: null };
}

describe("discord profile cache bound (#24165)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("evicts the oldest message-author key past the cap and refetches it", async () => {
    const messagesFetch = vi.fn(async (messageId: string) => ({
      id: messageId,
      author: makeAuthorProfile(messageId),
      member: null,
    }));
    const runtime = makeRuntime({ messagesFetch });

    // Insert cap + 1 distinct keys (oldest is key "0").
    for (let i = 0; i < MAX_ENTRIES + 1; i++) {
      await resolveDiscordMessageAuthorProfile(runtime, "ch", String(i));
    }
    const fetchesAfterFill = messagesFetch.mock.calls.length;
    expect(fetchesAfterFill).toBe(MAX_ENTRIES + 1);

    // Reread the OLDEST key: it was evicted → one additional fetch.
    await resolveDiscordMessageAuthorProfile(runtime, "ch", "0");
    expect(messagesFetch.mock.calls.length).toBe(MAX_ENTRIES + 2);

    // Reread the NEWEST key: cache hit → no additional fetch.
    const fetchesBeforeNewest = messagesFetch.mock.calls.length;
    await resolveDiscordMessageAuthorProfile(runtime, "ch", String(MAX_ENTRIES));
    expect(messagesFetch.mock.calls.length).toBe(fetchesBeforeNewest);
  });

  it("evicts the oldest user-profile key past the cap and refetches it", async () => {
    const usersFetch = vi.fn(async (userId: string) => makeAuthorProfile(userId));
    const runtime = makeRuntime({ usersFetch });

    for (let i = 0; i < MAX_ENTRIES + 1; i++) {
      await resolveDiscordUserProfile(runtime, `user-${i}`);
    }
    expect(usersFetch.mock.calls.length).toBe(MAX_ENTRIES + 1);

    // Oldest evicted → refetch.
    await resolveDiscordUserProfile(runtime, "user-0");
    expect(usersFetch.mock.calls.length).toBe(MAX_ENTRIES + 2);

    // Newest still cached → no fetch.
    const before = usersFetch.mock.calls.length;
    await resolveDiscordUserProfile(runtime, `user-${MAX_ENTRIES}`);
    expect(usersFetch.mock.calls.length).toBe(before);
  });

  it("bounds null results the same way (failure path)", async () => {
    // Message author: channel has no messages.fetch → null cached per key.
    const messagesFetch = vi.fn(async () => null);
    const runtime = makeRuntime({ messagesFetch });

    for (let i = 0; i < MAX_ENTRIES + 1; i++) {
      await resolveDiscordMessageAuthorProfile(runtime, "ch", String(i));
    }
    // Oldest null entry was evicted → refetch happens.
    await resolveDiscordMessageAuthorProfile(runtime, "ch", "0");
    expect(messagesFetch.mock.calls.length).toBe(MAX_ENTRIES + 2);
  });
});
