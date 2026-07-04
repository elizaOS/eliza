/** Unit tests for `createTwitterPostCallback`: dry-run skip, duplicate suppression, normalized-length posting, and returned memory even when persistence fails after publish; mocked client. */
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientBase } from "../base";
import { createTwitterPostCallback } from "./twitter-post-callback";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const X_MAX_POST_LENGTH = 280;

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
    ensureWorldExists: vi.fn(async () => undefined),
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
  return {
    accountId: "default",
    lastCheckedTweetId: null,
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
    runtime.cache.set("twitter/agent/recentTweets", ["duplicate text"]);
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
    expect(runtime.cache.get("twitter/agent/recentTweets")).toEqual([
      "new post text",
    ]);
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

    expect(onPosted).toHaveBeenCalledTimes(1);
    expect(client.twitterClient.sendTweet).toHaveBeenCalledTimes(1);
    expect(runtime.cache.get("twitter/agent/recentTweets")).toEqual([
      "new post text",
    ]);
  });

  it("checks duplicates and posts with the normalized X-length text", async () => {
    const runtime = makeRuntime();
    const client = makeClient();
    const callback = makeCallback({ client, runtime });
    const longText = "hello ".repeat(70);

    await callback({ text: longText });

    expect(client.twitterClient.sendTweet).toHaveBeenCalledTimes(1);
    const recentTweets = runtime.cache.get("twitter/agent/recentTweets") as
      | string[]
      | undefined;
    expect(recentTweets).toHaveLength(1);
    expect(typeof recentTweets?.[0]).toBe("string");
    expect(recentTweets?.[0]?.length).toBeLessThanOrEqual(X_MAX_POST_LENGTH);
  });
});
