/** Unit tests for `TwitterInteractionClient` engagement on search-discovered tweets — like/retweet/quote/none per model choice, plus dry-run; mocked runtime. */
import { type IAgentRuntime, logger, type UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ClientBase, NO_REQUEST_RETRY } from "./base";
import type { Tweet } from "./client";
import { TwitterInteractionClient } from "./interactions";
import type { TwitterClientState } from "./types";

// The lightweight plugin test shim for `@elizaos/core` omits prompt helpers used
// by this action-decision flow. Use the node source entry for this suite.
vi.mock("@elizaos/core", async () => {
  const node = await import("@elizaos/core/node");
  return node;
});

function asRuntime<T extends object>(runtime: T): IAgentRuntime & T {
  return runtime as IAgentRuntime & T;
}

function createRuntime(
  modelResponse: string,
  settings: Record<string, string> = {},
) {
  const cache = new Map<string, unknown>();
  return asRuntime({
    agentId: "agent-1" as UUID,
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
    getSetting: vi.fn((key: string) => settings[key]),
    reportError: vi.fn(),
    useModel: vi.fn(async () => modelResponse),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    messageService: {
      handleMessage: vi.fn(async () => ({ responseMessages: [] })),
    },
  });
}

interface TwitterClientMock {
  likeTweet: ReturnType<typeof vi.fn>;
  retweet: ReturnType<typeof vi.fn>;
  sendQuoteTweet: ReturnType<typeof vi.fn>;
  getTweetsV2: ReturnType<typeof vi.fn>;
}

function createClient(
  twitterClient: TwitterClientMock,
  runtime: ReturnType<typeof createRuntime>,
): ClientBase {
  let lastCheckedTweetId: bigint | null = null;
  const authenticatedProfile = {
    id: "bot-user",
    username: "bot",
    screenName: "Bot",
    bio: "",
    nicknames: [],
  };
  const requestQueueAdd = vi.fn(async (fn: () => Promise<unknown>) => fn());
  const client = {
    accountId: "default",
    runtime,
    get lastCheckedTweetId() {
      return lastCheckedTweetId;
    },
    set lastCheckedTweetId(value: bigint | null) {
      lastCheckedTweetId = value;
    },
    profile: { id: "bot-user", username: "bot" },
    getAuthenticatedProfile: vi.fn(async () => authenticatedProfile),
    withAuthenticatedSession: vi.fn(
      async (
        operation: (session: {
          client: TwitterClientMock;
          profile: typeof authenticatedProfile;
          revision: number;
        }) => Promise<unknown>,
      ) =>
        operation({
          client: twitterClient,
          profile: authenticatedProfile,
          revision: 1,
        }),
    ),
    getLatestCheckedTweetId: vi.fn(() => lastCheckedTweetId),
    recordLatestCheckedTweetId: vi.fn((_profileId: string, id: bigint) => {
      lastCheckedTweetId = id;
    }),
    cacheLatestCheckedTweetId: vi.fn(async () => undefined),
    isAuthenticatedSessionCurrent: vi.fn(() => true),
    identityCacheKey: vi.fn(
      (profile: typeof authenticatedProfile, suffix: string) =>
        `twitter/default/${profile.id}/${suffix}`,
    ),
    getIdentityCache: vi.fn(
      (profile: typeof authenticatedProfile, suffix: string) =>
        runtime.getCache(`twitter/default/${profile.id}/${suffix}`),
    ),
    setIdentityCache: vi.fn(
      (profile: typeof authenticatedProfile, suffix: string, value: unknown) =>
        runtime.setCache(`twitter/default/${profile.id}/${suffix}`, value),
    ),
    twitterClient,
    requestQueue: { add: requestQueueAdd },
    fetchSearchTweets: vi.fn(),
    fetchHomeTimeline: vi.fn(async () => []),
  };
  return client as unknown as ClientBase;
}

function tweet(overrides: Partial<Tweet> = {}): Tweet {
  return {
    id: "500",
    userId: "user-1",
    username: "alice",
    name: "Alice",
    conversationId: "conversation-1",
    text: "interesting on-topic post",
    timestamp: Date.now(),
    thread: [],
    permanentUrl: "https://x.com/alice/status/500",
    ...overrides,
  } as Tweet;
}

function createTwitterClientMock(): TwitterClientMock {
  return {
    likeTweet: vi.fn(async () => undefined),
    retweet: vi.fn(async () => undefined),
    sendQuoteTweet: vi.fn(async () => ({ id: "quote-1" })),
    getTweetsV2: vi.fn(async () => []),
  };
}

/**
 * Drive the search-engagement path: a target user's posts are discovered via
 * search (fetchSearchTweets) and the action decision (useModel) selects which of
 * like / retweet / quote / reply to execute.
 */
async function runTargetUserEngagement(
  client: TwitterInteractionClient,
  clientBase: ClientBase,
  candidate: Tweet,
) {
  vi.mocked(clientBase.fetchSearchTweets).mockResolvedValue({
    tweets: [candidate],
    previous: undefined,
    next: undefined,
  } as Awaited<ReturnType<ClientBase["fetchSearchTweets"]>>);

  await client.handleTwitterInteractions();
}

describe("Twitter search engagement actions", () => {
  beforeEach(() => {
    logger.log = vi.fn();
    logger.info = vi.fn();
    logger.warn = vi.fn();
    logger.error = vi.fn();
  });

  it("likes and retweets a search-discovered tweet when the model selects those actions", async () => {
    const runtime = createRuntime("[LIKE]\n[RETWEET]", {
      TWITTER_ENABLE_REPLIES: "false",
      TWITTER_TARGET_USERS: "alice",
    });
    const twitterClient = createTwitterClientMock();
    const clientBase = createClient(twitterClient, runtime);
    const client = new TwitterInteractionClient(
      clientBase,
      runtime,
      {} as TwitterClientState,
    );

    await runTargetUserEngagement(client, clientBase, tweet());

    expect(twitterClient.likeTweet).toHaveBeenCalledWith("500");
    expect(twitterClient.retweet).toHaveBeenCalledWith("500");
    expect(twitterClient.sendQuoteTweet).not.toHaveBeenCalled();
    expect(runtime.reportError).not.toHaveBeenCalled();
  });

  it("quote tweets a search-discovered tweet with generated commentary", async () => {
    const runtime = createRuntime("[QUOTE]", {
      TWITTER_ENABLE_REPLIES: "false",
      TWITTER_TARGET_USERS: "alice",
    });
    // First useModel call returns the action decision; second returns the quote JSON.
    runtime.useModel
      .mockResolvedValueOnce("[QUOTE]")
      .mockResolvedValueOnce('{"post":"sharp take, agreed"}');
    const twitterClient = createTwitterClientMock();
    const clientBase = createClient(twitterClient, runtime);
    const client = new TwitterInteractionClient(
      clientBase,
      runtime,
      {} as TwitterClientState,
    );

    await runTargetUserEngagement(client, clientBase, tweet());

    expect(twitterClient.sendQuoteTweet).toHaveBeenCalledWith(
      "sharp take, agreed",
      "500",
    );
    expect(clientBase.requestQueue.add).toHaveBeenCalledWith(
      expect.any(Function),
      NO_REQUEST_RETRY,
    );
    expect(twitterClient.likeTweet).not.toHaveBeenCalled();
    expect(twitterClient.retweet).not.toHaveBeenCalled();
    expect(runtime.reportError).not.toHaveBeenCalled();
  });

  it("takes no engagement action when the model selects none", async () => {
    const runtime = createRuntime("", {
      TWITTER_ENABLE_REPLIES: "false",
      TWITTER_TARGET_USERS: "alice",
    });
    const twitterClient = createTwitterClientMock();
    const clientBase = createClient(twitterClient, runtime);
    const client = new TwitterInteractionClient(
      clientBase,
      runtime,
      {} as TwitterClientState,
    );

    await runTargetUserEngagement(client, clientBase, tweet());

    expect(twitterClient.likeTweet).not.toHaveBeenCalled();
    expect(twitterClient.retweet).not.toHaveBeenCalled();
    expect(twitterClient.sendQuoteTweet).not.toHaveBeenCalled();
    expect(runtime.reportError).not.toHaveBeenCalled();
  });

  it("simulates like / retweet / quote in dry-run mode", async () => {
    const runtime = createRuntime("[LIKE]\n[RETWEET]\n[QUOTE]", {
      TWITTER_ENABLE_REPLIES: "false",
      TWITTER_TARGET_USERS: "alice",
      TWITTER_DRY_RUN: "true",
    });
    runtime.useModel
      .mockResolvedValueOnce("[LIKE]\n[RETWEET]\n[QUOTE]")
      .mockResolvedValueOnce('{"post":"sharp take, agreed"}');
    const twitterClient = createTwitterClientMock();
    const clientBase = createClient(twitterClient, runtime);
    const client = new TwitterInteractionClient(
      clientBase,
      runtime,
      {} as TwitterClientState,
    );

    await runTargetUserEngagement(client, clientBase, tweet());

    expect(twitterClient.likeTweet).not.toHaveBeenCalled();
    expect(twitterClient.retweet).not.toHaveBeenCalled();
    expect(twitterClient.sendQuoteTweet).not.toHaveBeenCalled();
    expect(runtime.reportError).not.toHaveBeenCalled();
  });

  it("does not act or mark a search result processed after the authenticated account rotates", async () => {
    let resolveDecision!: (value: string) => void;
    const decision = new Promise<string>((resolve) => {
      resolveDecision = resolve;
    });
    const runtime = createRuntime("", {
      TWITTER_ENABLE_REPLIES: "false",
      TWITTER_TARGET_USERS: "alice",
    });
    runtime.useModel.mockImplementationOnce(() => decision);
    const twitterClient = createTwitterClientMock();
    const clientBase = createClient(twitterClient, runtime);
    const current = vi.mocked(clientBase.isAuthenticatedSessionCurrent);
    const client = new TwitterInteractionClient(
      clientBase,
      runtime,
      {} as TwitterClientState,
    );

    const run = runTargetUserEngagement(client, clientBase, tweet());
    await vi.waitFor(() => expect(runtime.useModel).toHaveBeenCalledOnce());
    current.mockReturnValue(false);
    resolveDecision("[LIKE]");
    await run;

    expect(twitterClient.likeTweet).not.toHaveBeenCalled();
    expect(runtime.createMemory).not.toHaveBeenCalled();
    expect(runtime.reportError).toHaveBeenCalledWith(
      "XInteractionClient.handleInteractions",
      expect.objectContaining({ code: "X_AUTH_SESSION_ROTATED" }),
    );
  });
});
