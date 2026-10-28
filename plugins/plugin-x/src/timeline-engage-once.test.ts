/**
 * A home-timeline engagement is attempted at most once per tweet. When the
 * quote is already public and a later action fails (for example a reply that
 * X refuses), the tweet must still be marked processed; otherwise the next
 * cycle asks the model again and posts the quote a second time. The same
 * holds when a quote or reply thread is only partly posted: the handler wraps
 * that failure, but the first chunk is already public. Real
 * TwitterTimelineClient cycle; the X client, the model and (in some cases)
 * the action handlers are stubbed.
 */
import {
  type IAgentRuntime,
  logger,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { beforeEach, expect, it, vi } from "vitest";
import type { ClientBase } from "./base";
import type { Tweet } from "./client";
import { TwitterTimelineClient } from "./timeline";
import type { TwitterClientState } from "./types";

type TimelineInternals = {
  getTimelineForProfile(count: number, profile: unknown): Promise<Tweet[]>;
  handleQuoteAction(...args: unknown[]): Promise<boolean>;
  handleReplyAction(...args: unknown[]): Promise<boolean>;
};

beforeEach(() => {
  logger.log = vi.fn();
  logger.info = vi.fn();
  logger.warn = vi.fn();
  logger.error = vi.fn();
});

const LONG_POST = "thread ".repeat(70).trim();

function timelineHarness(
  actions: string,
  twitterClient: Record<string, unknown> = {},
) {
  const memories = new Map<string, Memory>();
  const runtime = {
    agentId: "00000000-0000-0000-0000-0000000000ab" as UUID,
    character: { name: "Agent", templates: {} },
    composeState: vi.fn(async () => ({ values: {}, data: {}, text: "" })),
    createMemory: vi.fn(async (memory: Memory) => {
      if (memory.id) memories.set(memory.id, memory);
      return memory.id;
    }),
    getMemoryById: vi.fn(async (id: UUID) => memories.get(id) ?? null),
    ensureRoomExists: vi.fn(async () => undefined),
    ensureWorldExists: vi.fn(async () => undefined),
    ensureConnection: vi.fn(async () => undefined),
    getSetting: vi.fn(() => undefined),
    reportError: vi.fn(),
    useModel: vi.fn(async (_type: unknown, params: { prompt?: string }) =>
      params.prompt?.includes("You are responding to this tweet") ||
      params.prompt?.includes("You are replying to this tweet")
        ? JSON.stringify({ post: LONG_POST })
        : actions,
    ),
  } as unknown as IAgentRuntime;
  const profile = { id: "bot-user", username: "bot" };
  const client = {
    accountId: "default",
    runtime,
    profile,
    twitterClient,
    requestQueue: {
      add: vi.fn(async (operation: () => Promise<unknown>) => operation()),
    },
    cacheTweet: vi.fn(async () => undefined),
    withAuthenticatedSession: vi.fn(
      async (operation: (session: unknown) => Promise<unknown>) =>
        operation({ profile, revision: 1 }),
    ),
    isAuthenticatedSessionCurrent: vi.fn(() => true),
  } as unknown as ClientBase;
  const timeline = new TwitterTimelineClient(
    client,
    runtime,
    {} as TwitterClientState,
  );
  const internals = timeline as unknown as TimelineInternals;
  const tweet = {
    id: "1000000000000000777",
    userId: "user-1",
    username: "alice",
    name: "Alice",
    conversationId: "1000000000000000777",
    text: "Replies are limited on this post",
    timestamp: Date.now(),
    thread: [],
    photos: [],
    permanentUrl: "https://x.com/alice/status/1000000000000000777",
  } as unknown as Tweet;
  vi.spyOn(internals, "getTimelineForProfile").mockResolvedValue([tweet]);
  const runCycles = async (count: number) => {
    for (let cycle = 0; cycle < count; cycle++) {
      await timeline.handleTimeline().catch(() => undefined);
    }
  };
  return { internals, runCycles };
}

it("does not quote the same timeline tweet again after a later action failed", async () => {
  const { internals, runCycles } = timelineHarness("[QUOTE]\n[REPLY]");
  const quote = vi
    .spyOn(internals, "handleQuoteAction")
    .mockResolvedValue(true);
  vi.spyOn(internals, "handleReplyAction").mockRejectedValue(
    new Error("403: you are not allowed to reply to this post"),
  );

  await runCycles(2);

  expect(quote).toHaveBeenCalledTimes(1);
});

it("retries a timeline tweet when the failed action published nothing", async () => {
  const { internals, runCycles } = timelineHarness("[QUOTE]");
  const quote = vi
    .spyOn(internals, "handleQuoteAction")
    .mockRejectedValue(new Error("429 Too Many Requests"));

  await runCycles(2);

  expect(quote).toHaveBeenCalledTimes(2);
});

it("does not quote again after a quote thread was only partly posted", async () => {
  const sendQuoteTweet = vi.fn(async () => ({
    data: { id: "2000000000000000001" },
  }));
  const sendTweet = vi.fn(async () => {
    throw new Error("503 Service Unavailable");
  });
  const { runCycles } = timelineHarness("[QUOTE]", {
    sendQuoteTweet,
    sendTweet,
  });

  await runCycles(2);

  expect(sendQuoteTweet).toHaveBeenCalledTimes(1);
});

it("does not quote again after X accepted a quote without a usable receipt", async () => {
  const sendQuoteTweet = vi.fn(async () => ({ data: {} }));
  const { runCycles } = timelineHarness("[QUOTE]", { sendQuoteTweet });

  await runCycles(2);

  expect(sendQuoteTweet).toHaveBeenCalledTimes(1);
});

it("does not reply again after a reply thread was only partly posted", async () => {
  const sendTweet = vi
    .fn()
    .mockResolvedValueOnce({ data: { id: "2000000000000000002" } })
    .mockRejectedValue(new Error("429 Too Many Requests"));
  const { runCycles } = timelineHarness("[REPLY]", { sendTweet });

  await runCycles(2);

  const replyStarts = sendTweet.mock.calls.filter(
    (call) => call[1] === "1000000000000000777",
  );
  expect(replyStarts).toHaveLength(1);
});

it("does not reply again after X accepted a reply without a usable receipt", async () => {
  const sendTweet = vi.fn(async () => ({ data: {} }));
  const { runCycles } = timelineHarness("[REPLY]", { sendTweet });

  await runCycles(2);

  expect(sendTweet).toHaveBeenCalledTimes(1);
});
