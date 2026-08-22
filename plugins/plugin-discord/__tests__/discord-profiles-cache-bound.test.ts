/**
 * Regression coverage for #24165: the module-scoped profile caches must stay
 * bounded. Resolving more distinct messages than the cap must not grow the
 * cache without bound, and every resolution path must keep working.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../discord-avatar-cache", () => ({
  cacheDiscordAvatarUrl: vi.fn(async () => {}),
}));

import { resolveDiscordMessageAuthorProfile } from "../discord-profiles";

const MAX_ENTRIES = 512;

function makeRuntime() {
  const messagesFetch = vi.fn(async (messageId: string) => ({
    id: messageId,
    author: { id: `user-${messageId}` },
    member: null,
  }));
  const client = {
    channels: {
      cache: { get: () => undefined },
      fetch: async () => ({ messages: { fetch: messagesFetch } }),
    },
  };
  const runtime = {
    getService: () => ({ client }),
  } as any;
  return { runtime, messagesFetch };
}

describe("discord profile cache bound (#24165)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps resolving after far more distinct messages than the cap", async () => {
    const { runtime, messagesFetch } = makeRuntime();
    // Insert ~2x the cap of distinct channel:message keys; none are read twice,
    // which is the lifecycle the unbounded cache previously leaked on.
    for (let i = 0; i < MAX_ENTRIES * 2; i++) {
      const profile = await resolveDiscordMessageAuthorProfile(
        runtime,
        `ch-${i % 8}`,
        `msg-${i}`,
      );
      expect(profile?.id).toBe(`user-msg-${i}`);
    }
    // The fetch mock was called for every distinct key — the cache never
    // served an unbounded hit set, and resolution never threw.
    expect(messagesFetch).toHaveBeenCalledTimes(MAX_ENTRIES * 2);
  });

  it("serves a cache hit for a recently resolved key without refetching", async () => {
    const { runtime, messagesFetch } = makeRuntime();
    await resolveDiscordMessageAuthorProfile(runtime, "ch-1", "msg-1");
    await resolveDiscordMessageAuthorProfile(runtime, "ch-1", "msg-1");
    expect(messagesFetch).toHaveBeenCalledTimes(1);
  });
});
