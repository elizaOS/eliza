/**
 * A discovery reply is posted at most once per tweet. When a long reply goes
 * out as a thread and a later part fails (for example X rate-limits it), the
 * first part is already public, so the tweet must be marked engaged; otherwise
 * the next cycle generates and posts a new reply thread under the same tweet.
 * Real TwitterDiscoveryClient engagement step; the X client and the reply
 * generator are stubbed.
 */
import {
  type IAgentRuntime,
  logger,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { beforeEach, expect, it, vi } from "vitest";
import type { ClientBase } from "./base";
import { TwitterDiscoveryClient } from "./discovery";
import type { TwitterClientState } from "./types";

type DiscoveryInternals = {
  processTweets(tweets: unknown[], session: unknown): Promise<number>;
  generateReply(tweet: unknown): Promise<string>;
  delay(ms: number): Promise<void>;
};

beforeEach(() => {
  logger.log = vi.fn();
  logger.info = vi.fn();
  logger.warn = vi.fn();
  logger.error = vi.fn();
  logger.debug = vi.fn();
});

it("does not reply again to a tweet whose reply thread was only partly posted", async () => {
  const memories = new Map<string, Memory>();
  const runtime = {
    agentId: "00000000-0000-0000-0000-0000000000ac" as UUID,
    character: { name: "Agent", templates: {}, topics: ["rust"] },
    getSetting: vi.fn(() => undefined),
    reportError: vi.fn(),
    ensureRoomExists: vi.fn(async () => undefined),
    ensureWorldExists: vi.fn(async () => undefined),
    ensureConnection: vi.fn(async () => undefined),
    createMemory: vi.fn(async (memory: Memory) => {
      if (memory.id) memories.set(memory.id, memory);
      return memory.id;
    }),
    getMemoryById: vi.fn(async (id: UUID) => memories.get(id) ?? null),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;
  const target = "1000000000000000888";
  // The first post of each thread is accepted; the follow-up is rate limited.
  const sendTweet = vi.fn(async (_text: string, replyTo?: string) => {
    if (replyTo !== target) throw new Error("429 Too Many Requests");
    return { id: `reply-${sendTweet.mock.calls.length}` };
  });
  const client = {
    accountId: "default",
    runtime,
    twitterClient: { sendTweet },
    isAuthenticatedSessionCurrent: vi.fn(() => true),
  } as unknown as ClientBase;
  const discovery = new TwitterDiscoveryClient(
    client,
    runtime,
    {} as TwitterClientState,
  );
  const internals = discovery as unknown as DiscoveryInternals;
  vi.spyOn(internals, "generateReply").mockResolvedValue(
    `${"Rust ownership makes this safe. ".repeat(12)}That is the point.`,
  );
  vi.spyOn(internals, "delay").mockResolvedValue(undefined);
  const scored = {
    tweet: {
      id: target,
      userId: "user-2",
      username: "bob",
      conversationId: target,
      text: "Why does Rust have ownership?",
    },
    relevanceScore: 0.9,
    engagementType: "reply",
  };

  for (let cycle = 0; cycle < 2; cycle++) {
    await internals
      .processTweets([scored], { revision: 1 })
      .catch(() => undefined);
  }

  const firstPosts = sendTweet.mock.calls.filter(([, to]) => to === target);
  expect(firstPosts).toHaveLength(1);
});
