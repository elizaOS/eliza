/**
 * Regression for the replies toggle after `validateTwitterConfig` runs.
 *
 * `TWITTER_ENABLE_REPLIES` is read twice: `validateTwitterConfig` normalizes it
 * into the account state, and the interaction client reads that state before
 * the runtime setting. A strict `=== "true"` in the validator turned `1`,
 * `yes` and `on` into `"false"`, so those agents stopped polling mentions even
 * though the same values keep replies on everywhere else.
 */
import { type IAgentRuntime, logger, type UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientBase } from "./base";
import { validateTwitterConfig } from "./environment";
import { TwitterInteractionClient } from "./interactions";
import type { TwitterClientState } from "./types";

const CREDENTIALS = {
  TWITTER_API_KEY: "test-key",
  TWITTER_API_SECRET_KEY: "test-secret",
  TWITTER_ACCESS_TOKEN: "test-token",
  TWITTER_ACCESS_TOKEN_SECRET: "test-token-secret",
};

function createRuntime(settings: Record<string, string>) {
  const runtime = {
    agentId: "00000000-0000-0000-0000-0000000000aa" as UUID,
    character: { name: "Agent", templates: {}, settings },
    composeState: vi.fn(async () => ({ values: {}, data: {}, text: "" })),
    createMemory: vi.fn(async () => undefined),
    emitEvent: vi.fn(),
    ensureConnection: vi.fn(async () => undefined),
    ensureRoomExists: vi.fn(async () => undefined),
    ensureWorldExists: vi.fn(async () => undefined),
    updateWorld: vi.fn(async () => undefined),
    getCache: vi.fn(async () => undefined),
    setCache: vi.fn(async () => true),
    deleteCache: vi.fn(async () => false),
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
  return runtime as unknown as IAgentRuntime;
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

describe("TWITTER_ENABLE_REPLIES after validation", () => {
  beforeEach(() => {
    logger.log = vi.fn();
    logger.info = vi.fn();
    logger.warn = vi.fn();
    logger.error = vi.fn();
  });

  it.each(["1", "yes", "on", "true", "TRUE", "enable"])(
    "keeps polling mentions when the validated setting is %s",
    async (value) => {
      const runtime = createRuntime({
        ...CREDENTIALS,
        TWITTER_ENABLE_REPLIES: value,
      });
      const validated = await validateTwitterConfig(runtime);
      expect(validated.TWITTER_ENABLE_REPLIES).toBe("true");

      const fetchSearchTweets = vi.fn(async () => ({
        tweets: [],
        next: undefined,
      }));
      const interactions = new TwitterInteractionClient(
        createClient(runtime, fetchSearchTweets) as unknown as ClientBase,
        runtime,
        validated as unknown as TwitterClientState,
      );

      await interactions.handleTwitterInteractions();

      expect(fetchSearchTweets).toHaveBeenCalled();
    },
  );

  it.each(["false", "0", "no", "off", "disable"])(
    "stops polling mentions when the validated setting is %s",
    async (value) => {
      const runtime = createRuntime({
        ...CREDENTIALS,
        TWITTER_ENABLE_REPLIES: value,
      });
      const validated = await validateTwitterConfig(runtime);
      expect(validated.TWITTER_ENABLE_REPLIES).toBe("false");

      const fetchSearchTweets = vi.fn(async () => ({
        tweets: [],
        next: undefined,
      }));
      const interactions = new TwitterInteractionClient(
        createClient(runtime, fetchSearchTweets) as unknown as ClientBase,
        runtime,
        validated as unknown as TwitterClientState,
      );

      await interactions.handleTwitterInteractions();

      expect(fetchSearchTweets).not.toHaveBeenCalled();
    },
  );

  it("keeps replies on by default when the setting is unset", async () => {
    const runtime = createRuntime({ ...CREDENTIALS });
    const validated = await validateTwitterConfig(runtime);

    expect(validated.TWITTER_ENABLE_REPLIES).toBe("true");
  });
});
