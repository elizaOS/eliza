/**
 * Regression coverage for #18965 across every timestamp collection boundary:
 * mixed valid+corrupt rows through the post/message list services and the
 * XService search connector must surface only the valid rows (normalized to
 * epoch ms exactly once), invalid `parseTweetV2ToV1` conversions must fail
 * closed downstream, and the interaction row normalizer must skip
 * present-but-unusable timestamps. Deterministic; mocked ClientBase only —
 * the services under test are real.
 */

import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { ClientBase } from "../base";
import { parseTweetV2ToV1 } from "../client/tweets";
import { normalizeTweet } from "../interactions";
import { MessageType } from "./IMessageService";
import { TwitterMessageService } from "./MessageService";
import { TwitterPostService } from "./PostService";
import { XService } from "./x.service";

const NOW = 1_755_000_000_000;
const VALID_SECONDS = 1_710_969_600; // 2024-03-20T22:40:00Z as Unix seconds
const VALID_MS = VALID_SECONDS * 1000;

function createRuntime() {
  return {
    agentId: "00000000-0000-0000-0000-000000000001" as UUID,
    getSetting: vi.fn(() => undefined),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
}

function rawTweet(overrides: Record<string, unknown> = {}) {
  return {
    id: "valid-1",
    userId: "user-1",
    username: "alice",
    name: "Alice",
    conversationId: "conversation-1",
    text: "a healthy row",
    timestamp: VALID_SECONDS,
    permanentUrl: "https://x.com/alice/status/valid-1",
    ...overrides,
  };
}

function createClient(overrides: Record<string, unknown> = {}): ClientBase {
  return {
    accountId: "default",
    runtime: createRuntime(),
    profile: { id: "bot-user", username: "bot" },
    twitterClient: {},
    fetchSearchTweets: vi.fn(),
    fetchHomeTimeline: vi.fn(async () => []),
    ...overrides,
  } as unknown as ClientBase;
}

describe("TwitterPostService mixed valid+corrupt collections (#18965)", () => {
  it("getPosts surfaces only rows with usable timestamps, normalized to ms", async () => {
    const client = createClient({
      fetchHomeTimeline: vi.fn(async () => [
        rawTweet(),
        rawTweet({ id: "corrupt-1", timestamp: Number.NaN }),
        rawTweet({ id: "valid-2", timestamp: VALID_MS }),
      ]),
    });
    const service = new TwitterPostService(client);

    const posts = await service.getPosts({
      agentId: "00000000-0000-0000-0000-000000000001" as UUID,
    });

    expect(posts.map((p) => p.id)).toEqual(["valid-1", "valid-2"]);
    expect(posts.map((p) => p.timestamp)).toEqual([VALID_MS, VALID_MS]);
    // No skipped row may reappear with a "now"-shaped timestamp.
    for (const post of posts) {
      expect(post.timestamp).toBeLessThan(NOW);
    }
  });

  it("getMentions drops corrupt rows instead of dating them now", async () => {
    const client = createClient({
      fetchSearchTweets: vi.fn(async () => ({
        tweets: [
          rawTweet({ id: "corrupt-1", timestamp: Number.POSITIVE_INFINITY }),
          rawTweet(),
        ],
      })),
    });
    const service = new TwitterPostService(client);

    const mentions = await service.getMentions(
      "00000000-0000-0000-0000-000000000001" as UUID,
    );

    expect(mentions.map((p) => p.id)).toEqual(["valid-1"]);
    expect(mentions[0].timestamp).toBe(VALID_MS);
  });
});

describe("TwitterMessageService mixed valid+corrupt collections (#18965)", () => {
  it("getMessages surfaces only rows with usable timestamps", async () => {
    const client = createClient({
      fetchSearchTweets: vi.fn(async () => ({
        tweets: [
          rawTweet({ inReplyToStatusId: "root-1" }),
          rawTweet({ id: "corrupt-1", timestamp: -5 }),
        ],
      })),
    });
    const service = new TwitterMessageService(client);

    const messages = await service.getMessages({
      roomId: undefined as unknown as UUID,
    });

    expect(messages.map((m) => m.id)).toEqual(["valid-1"]);
    expect(messages[0].timestamp).toBe(VALID_MS);
    expect(messages[0].type).toBe(MessageType.REPLY);
  });
});

describe("XService.searchConnectorPosts boundary (#18965)", () => {
  it("skips corrupt rows and never emits a memory with undefined createdAt", async () => {
    const runtime = createRuntime();
    const service = Object.create(XService.prototype) as XService & {
      runtime: IAgentRuntime;
      defaultAccountId: string;
      getTwitterClientForAccount: (id: string) => Promise<unknown>;
    };
    service.runtime = runtime;
    service.defaultAccountId = "default";
    service.getTwitterClientForAccount = vi.fn(async () => ({
      client: createClient({
        fetchSearchTweets: vi.fn(async () => ({
          tweets: [
            rawTweet(),
            rawTweet({ id: "corrupt-1", timestamp: Number.NaN }),
          ],
        })),
      }),
    }));

    const memories: Memory[] = await service.searchConnectorPosts(
      { runtime },
      { query: "anything" },
    );

    expect(memories).toHaveLength(1);
    expect(memories[0].createdAt).toBe(VALID_MS);
    expect(
      (memories[0].metadata as { timestamp?: number } | undefined)?.timestamp,
    ).toBe(VALID_MS);
  });
});

describe("invalid parseTweetV2ToV1 conversions fail closed downstream (#18965)", () => {
  it("a garbage created_at converts to an unusable timestamp that collections skip", async () => {
    const converted = parseTweetV2ToV1({
      id: "v2-corrupt",
      text: "corrupt v2 row",
      author_id: "user-2",
      conversation_id: "conversation-2",
      created_at: "not-a-real-date",
    } as Parameters<typeof parseTweetV2ToV1>[0]);

    expect(Number.isFinite(converted.timestamp)).toBe(false);

    const client = createClient({
      fetchHomeTimeline: vi.fn(async () => [rawTweet(), converted]),
    });
    const posts = await new TwitterPostService(client).getPosts({
      agentId: "00000000-0000-0000-0000-000000000001" as UUID,
    });

    expect(posts.map((p) => p.id)).toEqual(["valid-1"]);
  });
});

describe("interaction row normalizer (#18965)", () => {
  it("skips present-but-unusable timestamps and normalizes valid ones once", () => {
    expect(normalizeTweet(rawTweet({ timestamp: Number.NaN }))).toBeNull();
    expect(normalizeTweet(rawTweet({ timestamp: -1 }))).toBeNull();

    const seconds = normalizeTweet(rawTweet());
    expect(seconds?.timestamp).toBe(VALID_MS);

    const absent = normalizeTweet(rawTweet({ timestamp: undefined }));
    expect(absent?.timestamp).toBeGreaterThanOrEqual(NOW);
  });
});
