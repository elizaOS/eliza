/** Unit tests for generated X post admission, credential-bound identity, bounded duplicate state, and receipt persistence; mocked provider client. */
import {
  ElizaError,
  type IAgentRuntime,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientBase } from "../base";
import { countTwitterWeightedLength } from "../tweet-length";
import { addToRecentTweets, getRecentTweets, isDuplicateTweet } from "./memory";
import { createTwitterPostCallback } from "./twitter-post-callback";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const X_MAX_POST_LENGTH = 280;
const RECENT_TWEETS_KEY = "twitter/default/twitter-user-1/recentTweets";

function makeRuntime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime & {
  cache: Map<string, unknown>;
  createdMemories: Memory[];
} {
  const cache = new Map<string, unknown>();
  const createdMemories: Memory[] = [];

  return {
    agentId: AGENT_ID,
    cache,
    createdMemories,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      log: vi.fn(),
    },
    getSetting: vi.fn(() => undefined),
    getCache: vi.fn(async (key: string) => cache.get(key)),
    setCache: vi.fn(async (key: string, value: unknown) => {
      cache.set(key, value);
    }),
    deleteCache: vi.fn(async (key: string) => cache.delete(key)),
    reportError: vi.fn(),
    ensureWorldExists: vi.fn(async () => undefined),
    updateWorld: vi.fn(async () => undefined),
    ensureRoomExists: vi.fn(async () => undefined),
    ensureConnection: vi.fn(async () => undefined),
    createMemory: vi.fn(async (memory: Memory) => {
      createdMemories.push(memory);
    }),
    ...overrides,
  } as IAgentRuntime & {
    cache: Map<string, unknown>;
    createdMemories: Memory[];
  };
}

function makeClient(): ClientBase {
  const profile = {
    id: "twitter-user-1",
    username: "agent",
    screenName: "Agent",
    bio: "",
    nicknames: [],
  };
  return {
    accountId: "default",
    lastCheckedTweetId: null,
    runtime: { reportError: vi.fn() },
    profile,
    withAuthenticatedSession: async (
      operation: (session: {
        client: unknown;
        profile: typeof profile;
        revision: number;
      }) => Promise<unknown>,
    ) => operation({ client: {}, profile, revision: 1 }),
    isAuthenticatedSessionCurrent: () => true,
    twitterClient: {
      sendTweet: vi.fn().mockImplementation(async (text: string) => ({
        data: {
          data: {
            id: "123",
            text,
          },
        },
      })),
    },
    cacheLatestCheckedTweetId: vi.fn(async () => undefined),
    recordLatestCheckedTweetId: vi.fn(),
    cacheTweet: vi.fn(async () => undefined),
  } as unknown as ClientBase;
}

function makeCallback({
  client = makeClient(),
  runtime = makeRuntime(),
  state = {},
  onPosted,
}: {
  client?: ClientBase;
  runtime?: IAgentRuntime;
  state?: Record<string, unknown>;
  onPosted?: () => void;
} = {}) {
  return createTwitterPostCallback({
    client,
    runtime,
    state,
    roomId: ROOM_ID,
    userId: "twitter-user-1",
    username: "agent",
    onPosted,
  });
}

describe("createTwitterPostCallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips posting in dry-run mode", async () => {
    const client = makeClient();
    const callback = makeCallback({
      client,
      state: { TWITTER_DRY_RUN: true },
    });

    await expect(callback({ text: "hello" })).resolves.toEqual([]);
    expect(client.twitterClient.sendTweet).not.toHaveBeenCalled();
  });

  it("skips duplicate generated tweets", async () => {
    const runtime = makeRuntime();
    runtime.cache.set(RECENT_TWEETS_KEY, ["duplicate text"]);
    const client = makeClient();
    const callback = makeCallback({ client, runtime });

    await expect(callback({ text: "duplicate text" })).resolves.toEqual([]);
    expect(client.twitterClient.sendTweet).not.toHaveBeenCalled();
  });

  it("posts generated tweet, updates duplicate cache, and returns created memory", async () => {
    const runtime = makeRuntime();
    const client = makeClient();
    const onPosted = vi.fn();
    const callback = makeCallback({ client, runtime, onPosted });

    const memories = await callback({ text: "new post text" });

    expect(onPosted).toHaveBeenCalledTimes(1);
    expect(client.twitterClient.sendTweet).toHaveBeenCalledWith(
      "new post text",
      undefined,
      [],
      false,
      [],
    );
    expect(runtime.cache.get(RECENT_TWEETS_KEY)).toEqual(["new post text"]);
    expect(runtime.createMemory).toHaveBeenCalledTimes(1);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content?.text).toBe("new post text");
  });

  it("keeps duplicate suppression when memory persistence fails after posting", async () => {
    const runtime = makeRuntime({
      createMemory: vi.fn(async () => {
        throw new Error("db unavailable");
      }),
    });
    const client = makeClient();
    const onPosted = vi.fn();
    const callback = makeCallback({ client, runtime, onPosted });

    await expect(callback({ text: "new post text" })).resolves.toEqual([]);
    const laterCallback = makeCallback({ client, runtime, onPosted });
    await expect(laterCallback({ text: "new post text" })).resolves.toEqual([]);

    expect(onPosted).toHaveBeenCalledTimes(1);
    expect(client.twitterClient.sendTweet).toHaveBeenCalledTimes(1);
    expect(runtime.cache.get(RECENT_TWEETS_KEY)).toEqual(["new post text"]);
  });

  it("sends once for concurrent calls on one callback but permits the same text after recent history expires", async () => {
    const runtime = makeRuntime();
    const client = makeClient();
    const firstCallback = makeCallback({ client, runtime });

    const firstResults = await Promise.all([
      firstCallback({ text: "gm" }),
      firstCallback({ text: "gm" }),
    ]);

    expect(client.twitterClient.sendTweet).toHaveBeenCalledTimes(1);
    expect(firstResults.map((result) => result.length).sort()).toEqual([0, 1]);
    await expect(
      firstCallback({ text: "a second callback output" }),
    ).resolves.toEqual([]);
    expect(client.twitterClient.sendTweet).toHaveBeenCalledTimes(1);
    expect(
      [...runtime.cache.keys()].filter((key) => key.includes("/post_settled/")),
    ).toEqual([]);

    // The bounded recent-history cache is the duplicate authority after a
    // successful receipt. A later generation may reuse the text once it ages.
    runtime.cache.delete(RECENT_TWEETS_KEY);
    const laterCallback = makeCallback({ client, runtime });
    await expect(laterCallback({ text: "gm" })).resolves.toHaveLength(1);

    expect(client.twitterClient.sendTweet).toHaveBeenCalledTimes(2);
  });

  it("clears an explicit provider rejection so a later generation can retry", async () => {
    const runtime = makeRuntime();
    const client = makeClient();
    const providerSend = vi.mocked(client.twitterClient.sendTweet);
    providerSend
      .mockRejectedValueOnce({ status: 403, message: "forbidden" })
      .mockResolvedValue({
        data: { data: { id: "124", text: "retryable post" } },
      });
    const rejectedCallback = makeCallback({ client, runtime });

    await expect(
      rejectedCallback({ text: "retryable post" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(rejectedCallback({ text: "retryable post" })).resolves.toEqual(
      [],
    );
    expect(
      [...runtime.cache.keys()].filter((key) => key.includes("/post_settled/")),
    ).toEqual([]);

    const retryCallback = makeCallback({ client, runtime });
    await expect(
      retryCallback({ text: "retryable post" }),
    ).resolves.toHaveLength(1);
    expect(providerSend).toHaveBeenCalledTimes(2);
  });

  it("clears the pre-egress barrier when authentication rotates before the provider call", async () => {
    const runtime = makeRuntime();
    const client = makeClient();
    const originalSession = client.withAuthenticatedSession.bind(client);
    let admissionCount = 0;
    client.withAuthenticatedSession = vi.fn(async (operation) => {
      admissionCount += 1;
      if (admissionCount === 2) {
        throw new ElizaError("session rotated", {
          code: "X_AUTH_SESSION_ROTATED",
        });
      }
      return originalSession(operation);
    }) as ClientBase["withAuthenticatedSession"];
    const rotatedCallback = makeCallback({ client, runtime });

    await expect(
      rotatedCallback({ text: "identity-bound post" }),
    ).rejects.toMatchObject({ code: "X_AUTH_SESSION_ROTATED" });
    expect(client.twitterClient.sendTweet).not.toHaveBeenCalled();
    expect(
      [...runtime.cache.keys()].filter((key) => key.includes("/post_settled/")),
    ).toEqual([]);

    const retryCallback = makeCallback({ client, runtime });
    await expect(
      retryCallback({ text: "identity-bound post" }),
    ).resolves.toHaveLength(1);
    expect(client.twitterClient.sendTweet).toHaveBeenCalledTimes(1);
  });

  it("checks duplicates and posts with the normalized X-length text", async () => {
    const runtime = makeRuntime();
    const client = makeClient();
    const callback = makeCallback({ client, runtime });
    const longText = "hello ".repeat(70);

    await callback({ text: longText });

    expect(client.twitterClient.sendTweet).toHaveBeenCalledTimes(1);
    const recentTweets = runtime.cache.get(RECENT_TWEETS_KEY) as
      | string[]
      | undefined;
    expect(recentTweets).toHaveLength(1);
    expect(typeof recentTweets?.[0]).toBe("string");
    expect(recentTweets?.[0]?.length).toBeLessThanOrEqual(X_MAX_POST_LENGTH);
  });

  it("truncates generated CJK text to the X weighted cap before posting", async () => {
    const runtime = makeRuntime();
    const client = makeClient();
    const callback = makeCallback({ client, runtime });
    await callback({ text: "你".repeat(141) });
    expect(client.twitterClient.sendTweet).toHaveBeenCalledTimes(1);
    const posted = vi.mocked(client.twitterClient.sendTweet).mock.calls[0]?.[0];
    expect(typeof posted).toBe("string");
    expect(countTwitterWeightedLength(posted as string)).toBeLessThanOrEqual(
      X_MAX_POST_LENGTH,
    );
    expect(posted).not.toBe("你".repeat(141));
  });

  it("partitions recent-post duplicate state by account and profile identity", async () => {
    const runtime = makeRuntime();
    const accountA = { accountId: "account-a", profileId: "profile-1" };
    const accountB = { accountId: "account-b", profileId: "profile-1" };

    await addToRecentTweets(runtime, accountA, "same visible username post");

    await expect(
      isDuplicateTweet(runtime, accountA, "same visible username post"),
    ).resolves.toBe(true);
    await expect(
      isDuplicateTweet(runtime, accountB, "same visible username post"),
    ).resolves.toBe(false);
    await expect(getRecentTweets(runtime, accountB)).resolves.toEqual([]);
    expect(
      runtime.cache.get("twitter/account-a/profile-1/recentTweets"),
    ).toEqual(["same visible username post"]);
    expect(
      runtime.cache.get("twitter/account-b/profile-1/recentTweets"),
    ).toBeUndefined();
  });
});
