/**
 * Regression test for #22433: an outgoing publish (`sendTweet`) must not advance
 * the incoming @mention cursor, so a mention that arrived before a scheduled post
 * is still processed by `processMentionTweets` instead of being silently skipped.
 * The harness wires the real `sendTweet` and `TwitterInteractionClient` against a
 * deterministic in-memory cursor and a mocked runtime/messageService.
 */
import { type IAgentRuntime, logger, type UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientBase } from "./base";
import type { Tweet } from "./client";
import { TwitterInteractionClient } from "./interactions";
import type { TwitterClientState } from "./types";
import { sendTweet } from "./utils";

// The plugin test shim for `@elizaos/core` omits prompt helpers the mention flow
// depends on. Use the node source entry, matching the sibling interactions suites.
vi.mock("@elizaos/core", async () => {
  const node = await import("@elizaos/core/node");
  return node;
});

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

describe("outgoing post vs. incoming mention cursor (#22433)", () => {
  beforeEach(() => {
    logger.log = vi.fn();
    logger.info = vi.fn();
    logger.warn = vi.fn();
    logger.error = vi.fn();
  });

  it("still processes a pre-existing mention after a scheduled post publishes a newer tweet", async () => {
    const runtime = createRuntime();
    const send = vi.fn().mockResolvedValue({
      data: { data: { id: "1000000000000001000", text: "gm" } },
    });
    const client = createClient(runtime, send);
    const interactions = new TwitterInteractionClient(
      client,
      runtime,
      {} as TwitterClientState,
    );

    // A mention arrived and the interactions loop has advanced the cursor to a
    // point strictly below it (e.g. the previous run stopped just before it).
    const mentionId = "1000000000000000500";
    const startingCursor = 1_000_000_000_000_000_400n;
    client.recordLatestCheckedTweetId(PROFILE_ID, startingCursor);
    // Sanity: with this cursor the mention is considered new.
    expect(client.getLatestCheckedTweetId(PROFILE_ID)).toBe(startingCursor);
    expect(BigInt(mentionId) > startingCursor).toBe(true);

    // A scheduled post fires first and publishes a much newer tweet id.
    await sendTweet(client, "gm");
    expect(send).toHaveBeenCalledTimes(1);

    // The cursor must be unchanged by the outgoing publish (the core of #22433).
    // Had it advanced to the outgoing id, the older mention would be skipped.
    expect(client.getLatestCheckedTweetId(PROFILE_ID)).toBe(startingCursor);

    // Now the interactions loop runs and must process the pending mention.
    await interactions.processMentionTweets([mention({ id: mentionId })]);

    // The incoming mention was saved as a memory (handled, not skipped) ...
    expect(runtime.createMemory).toHaveBeenCalledTimes(1);
    const savedMemory = vi.mocked(runtime.createMemory).mock.calls[0]?.[0] as
      | { content: { text: string } }
      | undefined;
    expect(savedMemory?.content.text).toBe("@bot are you there?");
    // ... and it was routed through the message service for a reply decision.
    expect(runtime.messageService?.handleMessage).toHaveBeenCalledTimes(1);
    // ... and only now does the cursor advance to the processed mention id.
    expect(client.getLatestCheckedTweetId(PROFILE_ID)).toBe(BigInt(mentionId));
  });

  it("skips a mention already at or below the cursor without a send in between", async () => {
    const runtime = createRuntime();
    const send = vi.fn();
    const client = createClient(runtime, send);
    const interactions = new TwitterInteractionClient(
      client,
      runtime,
      {} as TwitterClientState,
    );

    const mentionId = "1000000000000000500";
    // The interactions loop legitimately owns the cursor and has already passed
    // this mention id; it must not be reprocessed.
    client.recordLatestCheckedTweetId(PROFILE_ID, BigInt(mentionId));

    await interactions.processMentionTweets([mention({ id: mentionId })]);

    expect(runtime.createMemory).not.toHaveBeenCalled();
    expect(runtime.messageService?.handleMessage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
