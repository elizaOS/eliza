/**
 * Real `TwitterInteractionClient.handleTwitterInteractions` coverage for mention
 * paging: a live next_token is followed until the snowflake watermark, so
 * mentions past the first page are not dropped.
 */
import { type IAgentRuntime, logger, type UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientBase } from "./base";
import type { Tweet } from "./client";
import { TwitterInteractionClient } from "./interactions";
import type { TwitterClientState } from "./types";

vi.mock("@elizaos/core", async () => {
  const node = await import("@elizaos/core/node");
  return node;
});

const PROFILE_ID = "bot-user";

function createRuntime() {
  const cache = new Map<string, unknown>();
  const runtime = {
    agentId: "00000000-0000-0000-0000-0000000000aa" as UUID,
    character: { name: "Agent", templates: {} },
    composeState: vi.fn(async () => ({ values: {}, data: {}, text: "" })),
    createMemory: vi.fn(async () => undefined),
    emitEvent: vi.fn(),
    ensureConnection: vi.fn(async () => undefined),
    ensureRoomExists: vi.fn(async () => undefined),
    ensureWorldExists: vi.fn(async () => undefined),
    updateWorld: vi.fn(async () => undefined),
    cache,
    getCache: vi.fn(async (key: string) => cache.get(key)),
    setCache: vi.fn(async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    }),
    deleteCache: vi.fn(async (key: string) => cache.delete(key)),
    getMemoryById: vi.fn(async () => null),
    getMemories: vi.fn(async () => []),
    getSetting: vi.fn((key: string) =>
      key === "TWITTER_ENABLE_REPLIES" ? "true" : undefined,
    ),
    reportError: vi.fn(),
    useModel: vi.fn(async () => ""),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    messageService: {
      handleMessage: vi.fn(async () => ({ responseMessages: [] })),
    },
  };
  return runtime as unknown as IAgentRuntime & typeof runtime;
}

function mention(id: string): Tweet {
  return {
    id,
    userId: "user-1",
    username: "alice",
    name: "Alice",
    conversationId: id,
    text: `@bot mention ${id}`,
    timestamp: Date.now(),
    thread: [],
    permanentUrl: `https://x.com/alice/status/${id}`,
  } as Tweet;
}

describe("mention search pagination", () => {
  beforeEach(() => {
    logger.log = vi.fn();
    logger.info = vi.fn();
    logger.warn = vi.fn();
    logger.error = vi.fn();
  });

  it("follows next_token until the lastChecked watermark instead of stopping at 20", async () => {
    const runtime = createRuntime();
    const page1 = Array.from({ length: 20 }, (_, i) =>
      mention(String(200 - i)),
    );
    const page2 = Array.from({ length: 10 }, (_, i) =>
      mention(String(180 - i)),
    );
    const fetchSearchTweets = vi.fn(
      async (_query: string, _max: number, _mode: unknown, cursor?: string) => {
        if (cursor === "page-2") {
          return { tweets: page2 };
        }
        return { tweets: page1, next: "page-2" };
      },
    );

    let lastChecked: bigint | null = 175n;
    const profile = {
      id: PROFILE_ID,
      username: "bot",
      screenName: "Bot",
      bio: "",
      nicknames: [],
    };
    const client = {
      accountId: "default",
      runtime,
      profile,
      twitterClient: { getTweetsV2: vi.fn(async () => []) },
      withAuthenticatedSession: vi.fn(
        async (operation: (session: unknown) => Promise<unknown>) =>
          operation({ client: {}, profile, revision: 1 }),
      ),
      isAuthenticatedSessionCurrent: vi.fn(() => true),
      getLatestCheckedTweetId: vi.fn((profileId: string) =>
        profileId === PROFILE_ID ? lastChecked : null,
      ),
      recordLatestCheckedTweetId: vi.fn((profileId: string, id: bigint) => {
        if (profileId !== PROFILE_ID) return;
        if (lastChecked !== null && id <= lastChecked) return;
        lastChecked = id;
      }),
      cacheLatestCheckedTweetId: vi.fn(async () => undefined),
      getIdentityCache: vi.fn(async () => undefined),
      setIdentityCache: vi.fn(async () => undefined),
      fetchSearchTweets,
    };

    const interactions = new TwitterInteractionClient(
      client as unknown as ClientBase,
      runtime,
      {} as TwitterClientState,
    );
    const collected: Tweet[][] = [];
    Object.assign(interactions, {
      processMentionTweetsForSession: async (candidates: Tweet[]) => {
        collected.push(candidates);
      },
    });

    await interactions.handleTwitterInteractions();

    expect(fetchSearchTweets).toHaveBeenCalledTimes(2);
    expect(fetchSearchTweets.mock.calls[0]?.[3]).toBeUndefined();
    expect(fetchSearchTweets.mock.calls[1]?.[3]).toBe("page-2");
    expect(collected).toHaveLength(1);
    expect(collected[0]?.map((tweet) => tweet.id)).toEqual([
      ...page1.map((tweet) => tweet.id),
      ...page2.map((tweet) => tweet.id),
    ]);
  });

  it("does not request a second page when the first page has no next_token", async () => {
    const runtime = createRuntime();
    const fetchSearchTweets = vi.fn(async () => ({
      tweets: [mention("50")],
    }));
    const profile = {
      id: PROFILE_ID,
      username: "bot",
      screenName: "Bot",
      bio: "",
      nicknames: [],
    };
    const client = {
      accountId: "default",
      runtime,
      profile,
      twitterClient: { getTweetsV2: vi.fn(async () => []) },
      withAuthenticatedSession: vi.fn(
        async (operation: (session: unknown) => Promise<unknown>) =>
          operation({ client: {}, profile, revision: 1 }),
      ),
      isAuthenticatedSessionCurrent: vi.fn(() => true),
      getLatestCheckedTweetId: vi.fn(() => null),
      recordLatestCheckedTweetId: vi.fn(),
      cacheLatestCheckedTweetId: vi.fn(async () => undefined),
      getIdentityCache: vi.fn(async () => undefined),
      setIdentityCache: vi.fn(async () => undefined),
      fetchSearchTweets,
    };
    const interactions = new TwitterInteractionClient(
      client as unknown as ClientBase,
      runtime,
      {} as TwitterClientState,
    );
    Object.assign(interactions, {
      processMentionTweetsForSession: async () => undefined,
    });

    await interactions.handleTwitterInteractions();
    expect(fetchSearchTweets).toHaveBeenCalledTimes(1);
  });
});
