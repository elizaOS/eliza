/**
 * With TWITTER_POST_IMMEDIATELY the post client retries the first post up to
 * five times while it reports "not posted". A post that went out as a thread
 * and failed after its first part is already public, so it must count as
 * posted; otherwise each retry generates and posts another one. Real
 * TwitterPostClient start-up and post callback; the X client and the post
 * generator (the POST_GENERATED handler) are stubbed.
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
  vi.useRealTimers();
});

it("posts the start-up post once when its thread is only partly posted", async () => {
  const cache = new Map<string, unknown>();
  const runtime = {
    agentId: "00000000-0000-0000-0000-0000000000ad" as UUID,
    character: { name: "Agent", templates: {} },
    getSetting: vi.fn(() => undefined),
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
          text: `Attempt ${attempt}. ${"Shipping notes for the week. ".repeat(14)}`,
        });
      },
    ),
  };
  const profile = { id: "bot-user", username: "bot" };
  // The first part of each thread is accepted; the follow-up is rate limited.
  const sendTweet = vi.fn(async (_text: string, replyTo?: string) => {
    if (replyTo) throw new Error("429 Too Many Requests");
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
      TWITTER_POST_IMMEDIATELY: "true",
    } as unknown as TwitterClientState,
  );

  const started = posts.start();
  await vi.advanceTimersByTimeAsync(60_000);
  await posts.stop();
  await started;

  const firstParts = sendTweet.mock.calls.filter(([, replyTo]) => !replyTo);
  expect(firstParts).toHaveLength(1);
});
