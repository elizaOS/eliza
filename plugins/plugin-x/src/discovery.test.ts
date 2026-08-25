/** Exercises discovery-cycle session binding, fail-closed read behavior, and the engagement dedup guard (#22710) with deterministic provider fakes. */
import {
  createUniqueUuid,
  type GenerateTextResult,
  type IAgentRuntime,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { ClientBase, TwitterAccountSession } from "./base";
import { TwitterDiscoveryClient } from "./discovery";
import type { TwitterClientState } from "./types";

type DiscoveryHarness = {
  runDiscoveryCycle(): Promise<void>;
  discoverContent(): Promise<{ tweets: unknown[]; accounts: unknown[] }>;
  discoverFromTopics(): Promise<{ tweets: unknown[]; accounts: unknown[] }>;
  processAccounts(
    accounts: unknown[],
    session: TwitterAccountSession,
  ): Promise<number>;
  processTweets(
    tweets: unknown[],
    session: TwitterAccountSession,
  ): Promise<number>;
  generateReply(tweet: unknown): Promise<string>;
  generateQuote(tweet: unknown): Promise<string>;
  delay(ms: number): Promise<void>;
};

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "agent-1",
    character: { name: "Agent", topics: ["agents"] },
    getSetting: () => undefined,
    reportError: vi.fn(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as IAgentRuntime;
}

function makeClient(current: () => boolean): {
  client: ClientBase;
  session: TwitterAccountSession;
  withAuthenticatedSession: ReturnType<typeof vi.fn>;
} {
  const profile = {
    id: "account-a",
    username: "account-a",
    screenName: "Account A",
    bio: "",
    nicknames: [],
  };
  const api = {};
  const session = { client: api as never, profile, revision: 1 };
  const withAuthenticatedSession = vi.fn(
    async (operation: (value: TwitterAccountSession) => Promise<unknown>) =>
      operation(session),
  );
  return {
    client: {
      accountId: "default",
      twitterClient: api,
      withAuthenticatedSession,
      isAuthenticatedSessionCurrent: vi.fn(() => current()),
    } as unknown as ClientBase,
    session,
    withAuthenticatedSession,
  };
}

describe("TwitterDiscoveryClient session integrity", () => {
  it("keeps the read and both processing phases in one authenticated session", async () => {
    let depth = 0;
    const { client, session, withAuthenticatedSession } = makeClient(
      () => true,
    );
    withAuthenticatedSession.mockImplementation(
      async (operation: (value: TwitterAccountSession) => Promise<unknown>) => {
        depth += 1;
        try {
          return await operation(session);
        } finally {
          depth -= 1;
        }
      },
    );
    const discovery = new TwitterDiscoveryClient(
      client,
      makeRuntime(),
      {} as TwitterClientState,
    ) as unknown as DiscoveryHarness;
    vi.spyOn(discovery, "discoverContent").mockImplementation(async () => {
      expect(depth).toBe(1);
      return { tweets: [], accounts: [] };
    });
    vi.spyOn(discovery, "processAccounts").mockImplementation(
      async (_accounts, captured) => {
        expect(depth).toBe(1);
        expect(captured).toBe(session);
        return 0;
      },
    );
    vi.spyOn(discovery, "processTweets").mockImplementation(
      async (_tweets, captured) => {
        expect(depth).toBe(1);
        expect(captured).toBe(session);
        return 0;
      },
    );

    await discovery.runDiscoveryCycle();

    expect(withAuthenticatedSession).toHaveBeenCalledOnce();
    expect(depth).toBe(0);
  });

  it("aborts after a delayed read when the credential generation rotated", async () => {
    let current = true;
    let releaseRead!: () => void;
    const readBlocked = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const { client } = makeClient(() => current);
    const discovery = new TwitterDiscoveryClient(
      client,
      makeRuntime(),
      {} as TwitterClientState,
    ) as unknown as DiscoveryHarness;
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    vi.spyOn(discovery, "discoverContent").mockImplementation(async () => {
      readStarted();
      await readBlocked;
      return { tweets: [], accounts: [] };
    });
    const processAccounts = vi.spyOn(discovery, "processAccounts");
    const processTweets = vi.spyOn(discovery, "processTweets");

    const cycle = discovery.runDiscoveryCycle();
    await started;
    current = false;
    releaseRead();

    await expect(cycle).rejects.toMatchObject({
      code: "X_AUTH_SESSION_ROTATED",
    });
    expect(processAccounts).not.toHaveBeenCalled();
    expect(processTweets).not.toHaveBeenCalled();
  });

  it("surfaces a failed discovery source instead of returning zero work", async () => {
    const { client } = makeClient(() => true);
    const discovery = new TwitterDiscoveryClient(
      client,
      makeRuntime(),
      {} as TwitterClientState,
    ) as unknown as DiscoveryHarness;
    vi.spyOn(discovery, "discoverFromTopics").mockRejectedValue(
      new Error("provider unavailable"),
    );

    await expect(discovery.discoverContent()).rejects.toMatchObject({
      code: "X_DISCOVERY_READ_FAILED",
    });
  });
});

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;

type EngagementRuntimeHandle = {
  runtime: IAgentRuntime;
  memories: Map<string, Memory>;
};

/**
 * Map-backed runtime whose `getMemoryById`/`createMemory` share one store, so a
 * dedup marker written by `saveEngagementMemory` is observable by the
 * `processTweets` guard on the following cycle — the exact read/write agreement
 * that #22710 broke.
 */
function makeEngagementRuntime(
  replyText: string | GenerateTextResult = "a thoughtful reply",
): EngagementRuntimeHandle {
  const memories = new Map<string, Memory>();
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Agent", topics: ["agents"] },
    getSetting: () => undefined,
    reportError: vi.fn(),
    getMemoryById: vi.fn(async (id: UUID) => memories.get(id) ?? null),
    createMemory: vi.fn(async (memory: Memory) => {
      if (memory.id && !memories.has(memory.id)) {
        memories.set(memory.id, memory);
      }
      return memory.id as UUID;
    }),
    ensureWorldExists: vi.fn(async () => {}),
    updateWorld: vi.fn(async () => {}),
    ensureRoomExists: vi.fn(async () => {}),
    ensureConnection: vi.fn(async () => {}),
    useModel: vi.fn(async () => replyText as never),
  } as unknown as IAgentRuntime;
  return { runtime, memories };
}

function makeEngagementClient(): {
  client: ClientBase;
  session: TwitterAccountSession;
  likeTweet: ReturnType<typeof vi.fn>;
  sendTweet: ReturnType<typeof vi.fn>;
  sendQuoteTweet: ReturnType<typeof vi.fn>;
} {
  const profile = {
    id: "account-a",
    username: "account-a",
    screenName: "Account A",
    bio: "",
    nicknames: [],
  };
  const likeTweet = vi.fn(async () => {});
  const sendTweet = vi.fn(async () => {});
  const sendQuoteTweet = vi.fn(async () => {});
  const api = { likeTweet, sendTweet, sendQuoteTweet };
  const session = { client: api as never, profile, revision: 1 };
  return {
    client: {
      accountId: "default",
      twitterClient: api,
      withAuthenticatedSession: vi.fn(),
      isAuthenticatedSessionCurrent: vi.fn(() => true),
    } as unknown as ClientBase,
    session,
    likeTweet,
    sendTweet,
    sendQuoteTweet,
  };
}

function scoredTweet(
  engagementType: "like" | "reply" | "quote" | "skip",
  overrides: Record<string, unknown> = {},
) {
  return {
    tweet: {
      id: "1750000000000000001",
      userId: "9001",
      username: "builder",
      name: "Builder",
      text: "agents are the future",
      conversationId: "1750000000000000001",
      ...overrides,
    },
    relevanceScore: 0.6,
    engagementType,
  };
}

describe("TwitterDiscoveryClient engagement dedup (#22710)", () => {
  it("engages a discovered tweet once and short-circuits on the next cycle", async () => {
    const { runtime, memories } = makeEngagementRuntime();
    const { client, session, likeTweet } = makeEngagementClient();
    const discovery = new TwitterDiscoveryClient(
      client,
      runtime,
      {} as TwitterClientState,
    ) as unknown as DiscoveryHarness;
    vi.spyOn(discovery, "delay").mockResolvedValue(undefined);

    const tweets = [scoredTweet("like")];
    const first = await discovery.processTweets(tweets, session);
    // The guard's read key must resolve to the memory the write produced.
    const guardHit = await runtime.getMemoryById(
      createUniqueUuid(runtime, "1750000000000000001"),
    );
    const second = await discovery.processTweets(tweets, session);

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(guardHit).not.toBeNull();
    expect(likeTweet).toHaveBeenCalledTimes(1);
    expect(likeTweet).toHaveBeenCalledWith("1750000000000000001");
    // Exactly one dedup marker persisted; the engagement type stays in metadata.
    expect(memories.size).toBe(1);
    const stored = [...memories.values()][0];
    expect(
      (stored.content.metadata as { engagementType?: string }).engagementType,
    ).toBe("like");
  });

  it("does not retry a 403-skipped tweet on the following cycle", async () => {
    const { runtime } = makeEngagementRuntime();
    const { client, session, likeTweet } = makeEngagementClient();
    likeTweet.mockRejectedValueOnce(new Error("Request failed with code 403"));
    const discovery = new TwitterDiscoveryClient(
      client,
      runtime,
      {} as TwitterClientState,
    ) as unknown as DiscoveryHarness;
    vi.spyOn(discovery, "delay").mockResolvedValue(undefined);

    const tweets = [scoredTweet("like")];
    // First cycle: the like call is denied (403) and a skip marker is written.
    await discovery.processTweets(tweets, session);
    const skipMarker = await runtime.getMemoryById(
      createUniqueUuid(runtime, "1750000000000000001"),
    );
    // Second cycle: the guard must find the skip marker and not retry.
    await discovery.processTweets(tweets, session);

    expect(skipMarker).not.toBeNull();
    const skipMeta = skipMarker?.content.metadata as {
      engagementType?: string;
    };
    expect(skipMeta.engagementType).toBe("skip");
    expect(likeTweet).toHaveBeenCalledTimes(1);
  });

  it("replies to a discovered tweet once across cycles", async () => {
    const { runtime } = makeEngagementRuntime("welcome to the timeline");
    const useModel = runtime.useModel as ReturnType<typeof vi.fn>;
    const { client, session, sendTweet, likeTweet } = makeEngagementClient();
    const discovery = new TwitterDiscoveryClient(
      client,
      runtime,
      {} as TwitterClientState,
    ) as unknown as DiscoveryHarness;
    vi.spyOn(discovery, "delay").mockResolvedValue(undefined);

    const tweets = [scoredTweet("reply")];
    const first = await discovery.processTweets(tweets, session);
    const second = await discovery.processTweets(tweets, session);

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(sendTweet).toHaveBeenCalledTimes(1);
    expect(sendTweet).toHaveBeenCalledWith(
      "welcome to the timeline",
      "1750000000000000001",
    );
    expect(useModel.mock.calls[0]?.[1]).toMatchObject({
      omitMaxTokens: true,
    });
    expect(useModel.mock.calls[0]?.[1]).not.toHaveProperty("maxTokens");
    expect(likeTweet).not.toHaveBeenCalled();
  });

  it("does not impose hidden model-output caps on reply or quote drafts", async () => {
    const { runtime } = makeEngagementRuntime({
      text: "complete draft",
      finishReason: "stop",
    });
    const useModel = runtime.useModel as ReturnType<typeof vi.fn>;
    const { client } = makeEngagementClient();
    const discovery = new TwitterDiscoveryClient(
      client,
      runtime,
      {} as TwitterClientState,
    ) as unknown as DiscoveryHarness;
    const tweet = scoredTweet("reply").tweet;

    await expect(discovery.generateReply(tweet)).resolves.toBe(
      "complete draft",
    );
    await expect(discovery.generateQuote(tweet)).resolves.toBe(
      "complete draft",
    );

    for (const [, request] of useModel.mock.calls) {
      expect(request).toMatchObject({
        messages: [
          {
            role: "user",
            content: expect.stringMatching(/under 280 characters/i),
          },
        ],
        omitMaxTokens: true,
      });
      expect(request).not.toHaveProperty("prompt");
      expect(request).not.toHaveProperty("maxTokens");
    }
  });

  it.each([
    ["generateReply", "length"],
    ["generateQuote", "MAX_TOKENS"],
    ["generateReply", "output-limit"],
  ] as const)(
    "%s rejects provider completion-limit signal %s instead of accepting partial text",
    async (method, finishReason) => {
      const { runtime } = makeEngagementRuntime({
        text: "This sounds complete but the provider says it was cut off",
        finishReason,
      });
      const { client } = makeEngagementClient();
      const discovery = new TwitterDiscoveryClient(
        client,
        runtime,
        {} as TwitterClientState,
      ) as unknown as DiscoveryHarness;

      await expect(
        discovery[method](scoredTweet("reply").tweet),
      ).rejects.toMatchObject({
        code: "X_DISCOVERY_DRAFT_PROVIDER_TRUNCATED",
        context: { finishReason },
      });
    },
  );

  it("does not call X or persist a receipt for a provider-truncated draft", async () => {
    const { runtime, memories } = makeEngagementRuntime({
      text: "partial draft",
      finishReason: "length",
    });
    const { client, session, sendTweet } = makeEngagementClient();
    const discovery = new TwitterDiscoveryClient(
      client,
      runtime,
      {} as TwitterClientState,
    ) as unknown as DiscoveryHarness;

    await expect(
      discovery.processTweets([scoredTweet("reply")], session),
    ).rejects.toMatchObject({
      code: "X_DISCOVERY_EFFECT_FAILED",
      cause: { code: "X_DISCOVERY_DRAFT_PROVIDER_TRUNCATED" },
    });
    expect(sendTweet).not.toHaveBeenCalled();
    expect(memories).toHaveProperty("size", 0);
  });

  it("rejects a complete overlength draft instead of clipping it", async () => {
    const completeDraft = "\u4f60".repeat(141);
    const { runtime } = makeEngagementRuntime(completeDraft);
    const useModel = runtime.useModel as ReturnType<typeof vi.fn>;
    const { client } = makeEngagementClient();
    const discovery = new TwitterDiscoveryClient(
      client,
      runtime,
      {} as TwitterClientState,
    ) as unknown as DiscoveryHarness;

    await expect(
      discovery.generateReply(scoredTweet("reply").tweet),
    ).rejects.toMatchObject({
      code: "X_DISCOVERY_DRAFT_LENGTH_EXCEEDED",
      context: { weightedLength: 282, maxWeightedLength: 280 },
    });
    expect(useModel).toHaveBeenCalledTimes(1);
  });

  it("sorts discovered tweets safely when relevanceScore contains NaN", () => {
    const tweets = [
      { tweet: { id: "tweet-nan" }, relevanceScore: NaN },
      { tweet: { id: "tweet-valid" }, relevanceScore: 0.85 },
    ];

    tweets.sort((a, b) => {
      const bScore =
        typeof b.relevanceScore === "number" &&
        Number.isFinite(b.relevanceScore)
          ? b.relevanceScore
          : 0;
      const aScore =
        typeof a.relevanceScore === "number" &&
        Number.isFinite(a.relevanceScore)
          ? a.relevanceScore
          : 0;
      return bScore - aScore || a.tweet.id.localeCompare(b.tweet.id);
    });

    expect(tweets[0]?.tweet.id).toBe("tweet-valid");
    expect(tweets[1]?.tweet.id).toBe("tweet-nan");
  });
});
