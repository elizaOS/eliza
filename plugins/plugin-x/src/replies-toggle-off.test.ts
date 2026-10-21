/**
 * `TWITTER_ENABLE_REPLIES` is a boolean toggle next to `TWITTER_ENABLE_DMS`.
 * The DM toggle accepts the shared boolean vocabulary, so an owner who writes
 * `off` gets DMs off. Replies must read the same values, or "off" still replies.
 */
import { type IAgentRuntime, logger, type UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientBase } from "./base";
import { TwitterInteractionClient } from "./interactions";
import type { TwitterClientState } from "./types";

function createRuntime(repliesSetting: string) {
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
      key === "TWITTER_ENABLE_REPLIES" ? repliesSetting : undefined,
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

function createClient(runtime: IAgentRuntime, fetchSearchTweets: unknown) {
  const profile = {
    id: "bot-user",
    username: "bot",
    screenName: "Bot",
    bio: "",
    nicknames: [],
  };
  return {
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
}

describe("TWITTER_ENABLE_REPLIES off", () => {
  beforeEach(() => {
    logger.log = vi.fn();
    logger.info = vi.fn();
    logger.warn = vi.fn();
    logger.error = vi.fn();
  });

  it.each(["false", "FALSE", "off", "0", "no", "disable"])(
    "does not poll mentions when the value is %s",
    async (value) => {
      const runtime = createRuntime(value);
      const fetchSearchTweets = vi.fn(async () => ({
        tweets: [],
        next: undefined,
      }));
      const interactions = new TwitterInteractionClient(
        createClient(runtime, fetchSearchTweets) as unknown as ClientBase,
        runtime,
        {} as TwitterClientState,
      );

      await interactions.handleTwitterInteractions();

      expect(fetchSearchTweets).not.toHaveBeenCalled();
    },
  );

  it("does not poll mentions when the account state turns replies off", async () => {
    // The account state holds the validated value. It must win over a runtime
    // setting that still says "true".
    const runtime = createRuntime("true");
    const fetchSearchTweets = vi.fn(async () => ({
      tweets: [],
      next: undefined,
    }));
    const interactions = new TwitterInteractionClient(
      createClient(runtime, fetchSearchTweets) as unknown as ClientBase,
      runtime,
      { TWITTER_ENABLE_REPLIES: "false" } as TwitterClientState,
    );

    await interactions.handleTwitterInteractions();

    expect(fetchSearchTweets).not.toHaveBeenCalled();
  });
});
