/**
 * A target-user engagement is attempted at most once per tweet. When the
 * quote is already public and a later action fails, the tweet must still be
 * marked processed; otherwise the next poll asks the model again and posts the
 * quote a second time. Real TwitterInteractionClient; the actions and the X
 * client are stubbed.
 */
import {
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

const PROFILE_ID = "bot-user";

function createRuntime(settings: Record<string, string> = {}) {
  const cache = new Map<string, unknown>();
  const createMemory = vi.fn(async () => undefined);
  const runtime = {
    agentId: "00000000-0000-0000-0000-0000000000aa" as UUID,
    character: { name: "Agent", templates: {} },
    composeState: vi.fn(async () => ({ values: {}, data: {}, text: "" })),
    createMemory,
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
    useModel: vi.fn(async () => ""),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    messageService: {
      handleMessage: vi.fn(async () => ({ responseMessages: [] })),
    },
  };
  return runtime as unknown as IAgentRuntime & typeof runtime;
}

/**
 * Build a ClientBase whose mention cursor is a real, monotonic in-memory value
 * updated through the same `record`/`get` methods the production code uses, so
 * both `sendTweet` and `processMentionTweets` observe one shared cursor.
 */
function createClient(runtime: IAgentRuntime, send: ReturnType<typeof vi.fn>) {
  let cursor: bigint | null = null;
  const authenticatedProfile = {
    id: PROFILE_ID,
    username: "bot",
    screenName: "Bot",
    bio: "",
    nicknames: [],
  };
  const twitterClient = {
    sendTweet: send,
    getTweetsV2: vi.fn(async () => []),
  };
  const client = {
    accountId: "default",
    runtime,
    profile: authenticatedProfile,
    twitterClient,
    withAuthenticatedSession: vi.fn(
      async (operation: (session: unknown) => Promise<unknown>) =>
        operation({
          client: twitterClient,
          profile: authenticatedProfile,
          revision: 1,
        }),
    ),
    isAuthenticatedSessionCurrent: vi.fn(() => true),
    getLatestCheckedTweetId: vi.fn((profileId: string) =>
      profileId === PROFILE_ID ? cursor : null,
    ),
    recordLatestCheckedTweetId: vi.fn((profileId: string, id: bigint) => {
      if (profileId !== PROFILE_ID) return;
      if (cursor !== null && id <= cursor) return;
      cursor = id;
    }),
    cacheLatestCheckedTweetId: vi.fn(async () => undefined),
    cacheTweet: vi.fn(async () => undefined),
  };
  return client as unknown as ClientBase;
}

function mention(overrides: Partial<Tweet> = {}): Tweet {
  return {
    id: "1000000000000000500",
    userId: "user-1",
    username: "alice",
    name: "Alice",
    conversationId: "1000000000000000500",
    text: "@bot are you there?",
    timestamp: Date.now(),
    thread: [],
    permanentUrl: "https://x.com/alice/status/1000000000000000500",
    ...overrides,
  } as Tweet;
}

type EngagementInternals = {
  processTargetUserTweets(
    tweets: Tweet[],
    username: string,
    session: unknown,
  ): Promise<void>;
  decideTweetActions(tweet: unknown): Promise<Record<string, boolean>>;
  handleQuoteAction(tweet: unknown, session: unknown): Promise<boolean>;
  handleReplyAction(tweet: unknown, session: unknown): Promise<boolean>;
};

describe("target-user engagement", () => {
  beforeEach(() => {
    logger.log = vi.fn();
    logger.info = vi.fn();
    logger.warn = vi.fn();
    logger.error = vi.fn();
  });

  it("does not quote the same tweet again after a later action failed", async () => {
    const runtime = createRuntime();
    const memories = new Map<string, Memory>();
    vi.mocked(runtime.createMemory).mockImplementation((async (
      memory: Memory,
    ) => {
      if (memory.id) memories.set(memory.id, memory);
      return memory.id;
    }) as never);
    vi.spyOn(runtime as IAgentRuntime, "getMemoryById").mockImplementation(
      (async (id: UUID) => memories.get(id) ?? null) as never,
    );
    const client = createClient(runtime, vi.fn());
    const interactions = new TwitterInteractionClient(
      client,
      runtime,
      {} as TwitterClientState,
    );
    const internals = interactions as unknown as EngagementInternals;
    vi.spyOn(internals, "decideTweetActions").mockResolvedValue({
      like: false,
      retweet: false,
      quote: true,
      reply: true,
    });
    const quote = vi
      .spyOn(internals, "handleQuoteAction")
      .mockResolvedValue(true);
    vi.spyOn(internals, "handleReplyAction").mockRejectedValue(
      new Error("reply failed"),
    );

    const tweet = mention({ timestamp: Date.now() });
    for (let poll = 0; poll < 2; poll++) {
      await internals
        .processTargetUserTweets([tweet], "alice", { revision: 1 })
        .catch(() => undefined);
    }

    expect(quote).toHaveBeenCalledTimes(1);
  });
});
