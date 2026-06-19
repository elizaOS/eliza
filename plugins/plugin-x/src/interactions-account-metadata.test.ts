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
  return {
    accountId,
    lastCheckedTweetId: null,
    profile: { id: "bot-user", username: "bot" },
    twitterClient: { getTweetsV2: vi.fn(async () => []) },
  } as unknown as ClientBase;
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
    expect(clientBase.lastCheckedTweetId).toBe(300n);
  });
});
