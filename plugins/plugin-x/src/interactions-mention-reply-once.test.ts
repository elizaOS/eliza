/**
 * A reply to a mention is posted at most once. X has no idempotency key for
 * posts, so when X accepted part of a reply (or the outcome is unknown), the
 * next poll must not post it again. Only an explicit refusal of the first
 * chunk reopens the mention. Real TwitterInteractionClient and thread sender;
 * the X client and the message service are stubbed.
 */
import {
  ElizaError,
  type IAgentRuntime,
  logger,
  type UUID,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientBase } from "./base";
import type { Tweet } from "./client";
import { TwitterInteractionClient } from "./interactions";
import type { TwitterClientState } from "./types";
import { sendTextAsTweetThread } from "./utils";

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
function createClient(
  runtime: IAgentRuntime,
  send: ReturnType<typeof vi.fn>,
  options: {
    uploadMedia?: ReturnType<typeof vi.fn>;
    /** True while the next acquired session is rotated before it is used. */
    rotateNextSession?: () => boolean;
  } = {},
) {
  let cursor: bigint | null = null;
  const rotatedSessions = new Set<unknown>();
  const authenticatedProfile = {
    id: PROFILE_ID,
    username: "bot",
    screenName: "Bot",
    bio: "",
    nicknames: [],
  };
  const twitterClient = {
    sendTweet: send,
    uploadMedia: options.uploadMedia ?? vi.fn(async () => "media-1"),
    getTweetsV2: vi.fn(async () => []),
  };
  const client = {
    accountId: "default",
    runtime,
    profile: authenticatedProfile,
    twitterClient,
    withAuthenticatedSession: vi.fn(
      async (operation: (session: unknown) => Promise<unknown>) => {
        const session = {
          client: twitterClient,
          profile: authenticatedProfile,
          revision: 1,
        };
        if (options.rotateNextSession?.()) rotatedSessions.add(session);
        return operation(session);
      },
    ),
    isAuthenticatedSessionCurrent: vi.fn(
      (session: unknown) => !rotatedSessions.has(session),
    ),
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

/** The stubbed message service's handleMessage (createRuntime always sets it). */
function handleMessageOf(runtime: ReturnType<typeof createRuntime>) {
  return runtime.messageService.handleMessage;
}

const LONG_REPLY = `${"part one ".repeat(40)}${"part two ".repeat(40)}`.trim();

function replyingRuntime(
  reply: { text: string; attachments?: unknown[] } = { text: LONG_REPLY },
  beforeReply?: () => void,
) {
  const runtime = createRuntime();
  vi.mocked(handleMessageOf(runtime)).mockImplementation((async (
    _runtime: unknown,
    _message: unknown,
    callback: (c: { text: string }) => Promise<unknown>,
  ) => {
    beforeReply?.();
    await callback(reply);
    return { responseMessages: [] };
  }) as never);
  return runtime;
}

async function poll(interactions: TwitterInteractionClient) {
  try {
    await interactions.processMentionTweets([mention()]);
  } catch {
    // A failed send ends this poll; the next poll decides what to do.
  }
}

describe("mention reply is posted at most once", () => {
  beforeEach(() => {
    logger.log = vi.fn();
    logger.info = vi.fn();
    logger.warn = vi.fn();
    logger.error = vi.fn();
  });

  it("does not post the reply again after X accepted its first chunk", async () => {
    const runtime = replyingRuntime();
    let sends = 0;
    const send = vi.fn(async () => {
      sends += 1;
      if (sends === 1)
        return { data: { data: { id: "2000000000000000001", text: "1" } } };
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    });
    const client = createClient(runtime, send);
    const interactions = new TwitterInteractionClient(
      client,
      runtime,
      {} as TwitterClientState,
    );

    await poll(interactions);
    expect(send).toHaveBeenCalledTimes(2);
    await poll(interactions);
    await poll(interactions);

    // No second public reply: the model is not asked again and nothing is sent.
    expect(send).toHaveBeenCalledTimes(2);
    expect(handleMessageOf(runtime)).toHaveBeenCalledTimes(1);
  });

  it("retries a reply whose first chunk X explicitly refused", async () => {
    const runtime = replyingRuntime();
    let sends = 0;
    const send = vi.fn(async () => {
      sends += 1;
      if (sends === 1)
        throw Object.assign(new Error("Too Many Requests"), { code: 429 });
      return {
        data: { data: { id: `20000000000000000${sends}`, text: "ok" } },
      };
    });
    const client = createClient(runtime, send);
    const interactions = new TwitterInteractionClient(
      client,
      runtime,
      {} as TwitterClientState,
    );

    await poll(interactions);
    await poll(interactions);

    expect(handleMessageOf(runtime)).toHaveBeenCalledTimes(2);
  });

  it("retries a reply when credentials rotate before its first chunk is sent", async () => {
    // The rotation lands after the poll acquired its session and before the
    // reply's own session is used, so no post request is ever issued.
    let rotationArmed = false;
    let rotated = false;
    const runtime = replyingRuntime(undefined, () => {
      if (!rotated) rotationArmed = true;
    });
    const send = vi.fn(async () => ({
      data: { data: { id: "2000000000000000001", text: "ok" } },
    }));
    const client = createClient(runtime, send, {
      rotateNextSession: () => {
        if (!rotationArmed) return false;
        rotationArmed = false;
        rotated = true;
        return true;
      },
    });
    const interactions = new TwitterInteractionClient(
      client,
      runtime,
      {} as TwitterClientState,
    );

    await poll(interactions);
    expect(send).not.toHaveBeenCalled();
    await poll(interactions);

    expect(handleMessageOf(runtime)).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalled();
  });

  it("retries a reply whose media upload failed before any post was sent", async () => {
    const runtime = replyingRuntime({
      text: "here is the picture",
      attachments: [
        {
          id: "image-1",
          url: "data:image/png;base64,iVBORw0KGgo=",
          contentType: "image",
        },
      ],
    });
    let uploads = 0;
    const uploadMedia = vi.fn(async () => {
      uploads += 1;
      if (uploads === 1)
        throw Object.assign(new Error("Service Unavailable"), { code: 503 });
      return "media-1";
    });
    const send = vi.fn(async () => ({
      data: { data: { id: "2000000000000000001", text: "ok" } },
    }));
    const client = createClient(runtime, send, { uploadMedia });
    const interactions = new TwitterInteractionClient(
      client,
      runtime,
      {} as TwitterClientState,
    );

    await poll(interactions);
    expect(send).not.toHaveBeenCalled();
    await poll(interactions);

    expect(handleMessageOf(runtime)).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("thread sender failure after a chunk was posted", () => {
  const twoChunks = `${"a ".repeat(200)}${"b ".repeat(200)}`;
  async function failSecondChunk(error: unknown) {
    let calls = 0;
    return sendTextAsTweetThread(twoChunks, async () => {
      calls += 1;
      if (calls === 1) return { id: "2000000000000000001" } as never;
      throw error;
    }).catch((thrown: unknown) => thrown as { code?: unknown });
  }

  it("keeps a credential rotation unchanged so callers still abort the cycle", async () => {
    const rotated = new ElizaError("rotated", {
      code: "X_AUTH_SESSION_ROTATED",
    });
    expect(await failSecondChunk(rotated)).toBe(rotated);
  });

  it("marks any other failure as a partly posted thread", async () => {
    const thrown = await failSecondChunk(
      Object.assign(new Error("Too Many Requests"), { code: 429 }),
    );
    expect(thrown.code).toBe("X_THREAD_PARTIALLY_POSTED");
  });
});
