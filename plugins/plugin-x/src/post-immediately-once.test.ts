/**
 * Exercises post-client startup, restart, retries, and scheduling. A thread
 * that fails after its first part must count as posted to avoid startup
 * retries. A stopped run must not post or renew its loop after a restart.
 * Uses the real TwitterPostClient and post callback; timers, the X client,
 * and the post generator (the POST_GENERATED handler) are controlled.
 */
import {
  EventType,
  type IAgentRuntime,
  logger,
  type UUID,
} from "@elizaos/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClientBase } from "./base";
import { TwitterPostClient } from "./post";
import type { TwitterClientState } from "./types";

beforeEach(() => {
  vi.useFakeTimers();
  logger.log = vi.fn();
  logger.info = vi.fn();
  logger.warn = vi.fn();
  logger.error = vi.fn();
  logger.debug = vi.fn();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function createPostClient(postImmediately = false, failThread = false) {
  const cache = new Map<string, unknown>();
  const runtime = {
    agentId: "00000000-0000-0000-0000-0000000000ad" as UUID,
    character: { name: "Agent", templates: {} },
    getSetting: vi.fn((key: string) =>
      key === "TWITTER_POST_INTERVAL" ? "1" : undefined,
    ),
    getCache: vi.fn(async (key: string) => cache.get(key)),
    setCache: vi.fn(async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    }),
    reportError: vi.fn(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emitEvent: vi.fn(
      async (
        type: string,
        payload: { callback: (content: { text: string }) => Promise<unknown> },
      ) => {
        if (type !== EventType.POST_GENERATED) return;
        // Each attempt generates new text, longer than one post.
        const attempt = runtime.emitEvent.mock.calls.length;
        await payload.callback({
          text: failThread
            ? `Attempt ${attempt}. ${"Shipping notes for the week. ".repeat(14)}`
            : `Attempt ${attempt}.`,
        });
      },
    ),
  };
  const profile = { id: "bot-user", username: "bot" };
  // Optionally accept the first part and rate limit the follow-up.
  const sendTweet = vi.fn(async (_text: string, replyTo?: string) => {
    if (failThread && replyTo) throw new Error("429 Too Many Requests");
    return { data: { id: `post-${sendTweet.mock.calls.length}` } };
  });
  const client = {
    accountId: "default",
    runtime,
    profile,
    twitterClient: { sendTweet },
    withAuthenticatedSession: vi.fn(
      async (operation: (session: unknown) => Promise<unknown>) =>
        operation({ profile, revision: 1 }),
    ),
    isAuthenticatedSessionCurrent: vi.fn(() => true),
    cacheTweet: vi.fn(async () => undefined),
  } as unknown as ClientBase;
  const posts = new TwitterPostClient(
    client,
    runtime as unknown as IAgentRuntime,
    {
      TWITTER_POST_IMMEDIATELY: String(postImmediately),
    } as unknown as TwitterClientState,
  );
  return { posts, runtime, sendTweet };
}

it("posts the start-up post once when its thread is only partly posted", async () => {
  const { posts, sendTweet } = createPostClient(true, true);
  const started = posts.start();
  await vi.advanceTimersByTimeAsync(60_000);
  await posts.stop();
  await started;

  const firstParts = sendTweet.mock.calls.filter(([, replyTo]) => !replyTo);
  expect(firstParts).toHaveLength(1);
});

it("keeps one post loop when start is repeated during and after startup", async () => {
  const { posts, sendTweet } = createPostClient();
  const started = posts.start();
  const repeated = posts.start();
  await vi.advanceTimersByTimeAsync(5000);
  await Promise.all([started, repeated]);
  expect(vi.getTimerCount()).toBe(1);
  await posts.start();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sendTweet).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(1);
  await posts.stop();
});

it("does not post or renew the old loop after stop and restart", async () => {
  const { posts, sendTweet } = createPostClient();
  const started = posts.start();
  await vi.advanceTimersByTimeAsync(5000);
  await started;
  await vi.advanceTimersByTimeAsync(10_000);
  await posts.stop();

  const restarted = posts.start();
  await vi.advanceTimersByTimeAsync(5000);
  await restarted;
  // The first run is due at 65 seconds; the second is due at 80 seconds.
  await vi.advanceTimersByTimeAsync(45_000);
  expect(sendTweet).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(sendTweet).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(sendTweet).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(1);
  await posts.stop();
});

it("does not post or start a loop when stopped during startup", async () => {
  const { posts, sendTweet } = createPostClient(true);
  const started = posts.start();
  await posts.stop();
  await vi.advanceTimersByTimeAsync(5000);
  await started;
  expect(sendTweet).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("discards the old startup after a restart", async () => {
  const { posts, sendTweet } = createPostClient(true);
  const started = posts.start();
  await vi.advanceTimersByTimeAsync(1000);
  await posts.stop();
  const restarted = posts.start();
  await vi.advanceTimersByTimeAsync(4000);
  await started;
  expect(sendTweet).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  await restarted;
  expect(sendTweet).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(1);
  await posts.stop();
});

it("discards an immediate-post retry from the old run", async () => {
  const { posts, sendTweet } = createPostClient(true);
  sendTweet.mockRejectedValueOnce(new Error("503 Service Unavailable"));
  const started = posts.start();
  await vi.advanceTimersByTimeAsync(5000);
  expect(sendTweet).toHaveBeenCalledTimes(1);
  await posts.stop();
  const restarted = posts.start();
  await vi.advanceTimersByTimeAsync(3000);
  await started;
  expect(sendTweet).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2000);
  await restarted;
  expect(sendTweet).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(1);
  await posts.stop();
});

it("does not renew the old loop when an in-flight post finishes after restart", async () => {
  const { posts, runtime, sendTweet } = createPostClient();
  const started = posts.start();
  await vi.advanceTimersByTimeAsync(5000);
  await started;
  const { promise: pendingPost, resolve: finishPost } =
    Promise.withResolvers<void>();
  runtime.emitEvent.mockImplementationOnce(async () => pendingPost);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(runtime.emitEvent).toHaveBeenCalledTimes(1);
  await posts.stop();
  const restarted = posts.start();
  await vi.advanceTimersByTimeAsync(5000);
  await restarted;
  finishPost();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sendTweet).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(1);
  await posts.stop();
});
