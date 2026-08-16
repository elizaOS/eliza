/** Unit tests for `TwitterInteractionClient` mention processing: malformed-candidate skipping, no-double-reply, and engagement-limit clamping; mocked runtime. */
import {
  createUniqueUuid,
  type IAgentRuntime,
  logger,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientBase } from "./base";
import type { Tweet } from "./client";
import { TwitterInteractionClient } from "./interactions";
import type { TwitterClientState } from "./types";

function asRuntime<T extends object>(runtime: T): IAgentRuntime & T {
  return runtime as IAgentRuntime & T;
}

function createRuntime(settings: Record<string, string> = {}) {
  return asRuntime({
    agentId: "agent-1" as UUID,
    character: { name: "Agent" },
    createMemory: vi.fn(async () => undefined),
    emitEvent: vi.fn(),
    ensureConnection: vi.fn(async () => undefined),
    ensureRoomExists: vi.fn(async () => undefined),
    ensureWorldExists: vi.fn(async () => undefined),
    updateWorld: vi.fn(async () => undefined),
    getMemoryById: vi.fn(async () => null),
    getMemories: vi.fn(async () => []),
    getSetting: vi.fn((key: string) => settings[key]),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    messageService: {
      handleMessage: vi.fn(async () => ({ responseMessages: [] })),
    },
  });
}

function createClient(accountId = "secondary"): ClientBase {
  let lastCheckedTweetId: bigint | null = null;
  const identityCache = new Map<string, unknown>();
  const authenticatedProfile = {
    id: "bot-user",
    username: "bot",
    screenName: "Bot",
    bio: "",
    nicknames: [],
  };
  const client = {
    accountId,
    get lastCheckedTweetId() {
      return lastCheckedTweetId;
    },
    set lastCheckedTweetId(value: bigint | null) {
      lastCheckedTweetId = value;
    },
    profile: { id: "bot-user", username: "bot" },
    getAuthenticatedProfile: vi.fn(async () => authenticatedProfile),
    twitterClient: { getTweetsV2: vi.fn(async () => []) },
    withAuthenticatedSession: vi.fn(
      async (
        operation: (session: {
          client: unknown;
          profile: typeof authenticatedProfile;
          revision: number;
        }) => Promise<unknown>,
      ) =>
        operation({
          client: client.twitterClient,
          profile: await client.getAuthenticatedProfile(),
          revision: 1,
        }),
    ),
    isAuthenticatedSessionCurrent: vi.fn(() => true),
    identityCacheKey: (profile: { id: string }, suffix: string) =>
      `twitter/${accountId}/${profile.id}/${suffix}`,
    getIdentityCache: vi.fn(async (profile: { id: string }, suffix: string) =>
      identityCache.get(`twitter/${accountId}/${profile.id}/${suffix}`),
    ),
    setIdentityCache: vi.fn(
      async (profile: { id: string }, suffix: string, value: unknown) => {
        identityCache.set(
          `twitter/${accountId}/${profile.id}/${suffix}`,
          value,
        );
      },
    ),
    getLatestCheckedTweetId: vi.fn(() => lastCheckedTweetId),
    recordLatestCheckedTweetId: vi.fn((_profileId: string, id: bigint) => {
      lastCheckedTweetId = id;
    }),
  };
  return client as unknown as ClientBase;
}

function tweet(overrides: Partial<Tweet> = {}): Tweet {
  return {
    id: "100",
    userId: "user-1",
    username: "alice",
    name: "Alice",
    conversationId: "conversation-1",
    text: "@bot hello",
    timestamp: Date.now(),
    thread: [],
    ...overrides,
  } as Tweet;
}

describe("Twitter interaction processing", () => {
  beforeEach(() => {
    logger.log = vi.fn();
    logger.info = vi.fn();
    logger.warn = vi.fn();
  });

  it("skips malformed mention candidates before storage or reply handling", async () => {
    const runtime = createRuntime();
    const client = new TwitterInteractionClient(
      createClient(),
      runtime,
      {} as TwitterClientState,
    );
    const handleTweet = vi.spyOn(client, "handleTweet");

    await client.processMentionTweets([
      tweet({ id: "", userId: "user-1" }),
      tweet({ id: "101", userId: "" }),
    ]);

    expect(runtime.ensureWorldExists).not.toHaveBeenCalled();
    expect(runtime.createMemory).not.toHaveBeenCalled();
    expect(handleTweet).not.toHaveBeenCalled();
  });

  it("does not reply again when conversation history already contains a response", async () => {
    const runtime = createRuntime();
    const duplicateTweet = tweet({ id: "200" });
    const tweetMemoryId = createUniqueUuid(runtime, duplicateTweet.id);
    runtime.getMemories.mockResolvedValueOnce([
      { content: { inReplyTo: tweetMemoryId } },
    ] as Memory[]);
    const client = new TwitterInteractionClient(
      createClient(),
      runtime,
      {} as TwitterClientState,
    );
    const handleTweet = vi.spyOn(client, "handleTweet");

    await client.processMentionTweets([duplicateTweet]);

    expect(runtime.createMemory).not.toHaveBeenCalled();
    expect(handleTweet).not.toHaveBeenCalled();
  });

  it("falls back to the default mention limit for hostile max engagement config", async () => {
    const runtime = createRuntime({ TWITTER_MAX_ENGAGEMENTS_PER_RUN: "NaN" });
    const clientBase = createClient("account-2");
    const client = new TwitterInteractionClient(
      clientBase,
      runtime,
      {} as TwitterClientState,
    );
    const handleTweet = vi
      .spyOn(client, "handleTweet")
      .mockResolvedValue({ text: "reply", actions: ["REPLY"] });

    await client.processMentionTweets([tweet({ id: "300" })]);

    expect(runtime.createMemory).toHaveBeenCalledTimes(1);
    expect(handleTweet).toHaveBeenCalledTimes(1);
    const world = runtime.ensureWorldExists.mock.calls[0]?.[0];
    const connection = runtime.ensureConnection.mock.calls[0]?.[0];
    expect(world?.metadata?.ownership?.ownerId).toBe(connection?.entityId);
    expect(world?.metadata?.ownership?.ownerId).not.toBe("user-1");
    expect(clientBase.lastCheckedTweetId).toBe(300n);
  });

  it("filters self mentions and advances the cursor using refreshed identity", async () => {
    const runtime = createRuntime();
    const clientBase = createClient();
    clientBase.profile = {
      id: "account-a",
      username: "stale-a",
      screenName: "Stale A",
      bio: "",
      nicknames: [],
    };
    vi.mocked(clientBase.getAuthenticatedProfile).mockResolvedValue({
      id: "account-b",
      username: "current-b",
      screenName: "Current B",
      bio: "",
      nicknames: [],
    });
    const client = new TwitterInteractionClient(
      clientBase,
      runtime,
      {} as TwitterClientState,
    );
    const handleTweet = vi
      .spyOn(client, "handleTweet")
      .mockResolvedValue({ text: "reply", actions: ["REPLY"] });

    await client.processMentionTweets([
      tweet({ id: "400", userId: "account-b", username: "current-b" }),
      tweet({ id: "401", userId: "person-1", username: "alice" }),
    ]);

    expect(handleTweet).toHaveBeenCalledOnce();
    expect(handleTweet).toHaveBeenCalledWith(
      expect.objectContaining({
        tweet: expect.objectContaining({ id: "401" }),
      }),
    );
    expect(clientBase.recordLatestCheckedTweetId).toHaveBeenCalledWith(
      "account-b",
      401n,
    );
  });
});
