import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  pullXFeed,
  readXDms,
  searchX,
  XReadError,
  type XReaderCredentials,
} from "../src/lifeops/x-reader.js";
import { withXRead } from "../src/lifeops/service-mixin-x-read.js";
import type {
  LifeOpsXFeedItem,
  LifeOpsXFeedType,
  LifeOpsXDm,
} from "@elizaos/shared/contracts/lifeops";

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_ENV = { ...process.env };
const SAME_ID = "00000000-0000-0000-0000-000000000001";

const CREDS: XReaderCredentials = {
  apiKey: "ak",
  apiSecret: "as",
  accessToken: "at",
  accessTokenSecret: "ats",
  userId: "user-42",
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

beforeEach(() => {
  delete process.env.TWITTER_API_KEY;
  delete process.env.TWITTER_API_SECRET;
  delete process.env.TWITTER_ACCESS_TOKEN;
  delete process.env.TWITTER_ACCESS_TOKEN_SECRET;
  delete process.env.TWITTER_USER_ID;
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  delete process.env.TWITTER_API_KEY;
  delete process.env.TWITTER_API_SECRET;
  delete process.env.TWITTER_ACCESS_TOKEN;
  delete process.env.TWITTER_ACCESS_TOKEN_SECRET;
  delete process.env.TWITTER_USER_ID;
  Object.assign(process.env, ORIGINAL_ENV);
  vi.restoreAllMocks();
});

describe("readXDms", () => {
  test("hits Twitter API v2 dm_events endpoint with OAuth Authorization header", async () => {
    let capturedUrl = "";
    let capturedAuth = "";
    global.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        const headers = init?.headers as Record<string, string> | undefined;
        capturedAuth = headers?.Authorization ?? "";
        return jsonResponse({ data: [], meta: {} });
      },
    ) as unknown as typeof fetch;

    const page = await readXDms(CREDS, { limit: 10 });
    expect(capturedUrl).toContain("/2/");
    expect(capturedUrl).toContain("/dm_events");
    expect(capturedAuth.startsWith("OAuth ")).toBe(true);
    expect(capturedAuth).toContain("oauth_signature=");
    expect(page.items).toEqual([]);
  });
});

describe("pullXFeed", () => {
  test('"home_timeline" hits /2/users/{id}/timelines/reverse_chronological', async () => {
    let capturedUrl = "";
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return jsonResponse({ data: [] });
    }) as unknown as typeof fetch;

    await pullXFeed(CREDS, "home_timeline");
    expect(capturedUrl).toContain(
      "/2/users/user-42/timelines/reverse_chronological",
    );
  });

  test('"mentions" hits /2/users/{id}/mentions', async () => {
    let capturedUrl = "";
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return jsonResponse({ data: [] });
    }) as unknown as typeof fetch;

    await pullXFeed(CREDS, "mentions");
    expect(capturedUrl).toContain("/2/users/user-42/mentions");
  });
});

describe("searchX", () => {
  test("hits /2/tweets/search/recent with query param", async () => {
    let capturedUrl = "";
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return jsonResponse({ data: [] });
    }) as unknown as typeof fetch;

    await searchX(CREDS, "elizaOS");
    expect(capturedUrl).toContain("/2/tweets/search/recent");
    expect(capturedUrl).toContain("query=elizaOS");
  });
});

describe("XReadError categorization", () => {
  test("throws auth error on 401", async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse({ errors: [{ detail: "Unauthorized" }] }, { status: 401 }),
    ) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await readXDms(CREDS);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(XReadError);
    expect((caught as XReadError).category).toBe("auth");
    expect((caught as XReadError).status).toBe(401);
  });

  test("throws rate_limit error on 429 with Retry-After header", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ errors: [{ detail: "Too Many" }] }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "42",
          },
        }),
    ) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await readXDms(CREDS);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(XReadError);
    expect((caught as XReadError).category).toBe("rate_limit");
    expect((caught as XReadError).retryAfterSeconds).toBe(42);
  });
});

describe("withXRead mixin", () => {
  type XReadService = {
    readXInboundDms(opts?: { limit?: number }): Promise<LifeOpsXDm[]>;
    searchXPosts(
      query: string,
      opts?: { limit?: number },
    ): Promise<LifeOpsXFeedItem[]>;
    syncXDms(opts?: { limit?: number }): Promise<{ synced: number }>;
  };

  function makeDm(overrides: Partial<LifeOpsXDm> = {}): LifeOpsXDm {
    const now = "2026-04-19T12:00:00.000Z";
    return {
      id: "dm-1",
      agentId: SAME_ID,
      externalDmId: "external-dm-1",
      conversationId: "conversation-1",
      senderHandle: "alice",
      senderId: "user-alice",
      isInbound: true,
      text: "Milady update",
      receivedAt: now,
      readAt: null,
      repliedAt: null,
      metadata: {},
      syncedAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  function makeFeedItem(
    id: string,
    feedType: LifeOpsXFeedType,
    text: string,
  ): LifeOpsXFeedItem {
    const now = "2026-04-19T12:00:00.000Z";
    return {
      id,
      agentId: SAME_ID,
      externalTweetId: id,
      authorHandle: "alice",
      authorId: "user-alice",
      text,
      createdAtSource: now,
      feedType,
      metadata: {},
      syncedAt: now,
      updatedAt: now,
    };
  }

  test("uses cached DM rows when X credentials are absent", async () => {
    const cachedDms = [
      makeDm({ id: "dm-in", isInbound: true }),
      makeDm({ id: "dm-out", externalDmId: "external-dm-2", isInbound: false }),
    ];
    class StubBase {
      runtime = { agentId: SAME_ID, logger: { warn: () => undefined } };
      ownerEntityId = null;
      agentId() {
        return SAME_ID;
      }
      repository = {
        upsertXDm: vi.fn(),
        upsertXFeedItem: vi.fn(),
        upsertXSyncState: vi.fn(),
        listXDms: vi.fn(async () => cachedDms),
        listXFeedItems: vi.fn(async () => []),
      };
    }
    const Composed = withXRead(StubBase as never);
    const svc = new (Composed as unknown as new () => StubBase &
      XReadService)();

    await expect(svc.syncXDms({ limit: 2 })).resolves.toEqual({ synced: 0 });
    await expect(svc.readXInboundDms({ limit: 2 })).resolves.toEqual([
      cachedDms[0],
    ]);
    expect(svc.repository.upsertXDm).not.toHaveBeenCalled();
    expect(svc.repository.upsertXSyncState).not.toHaveBeenCalled();
  });

  test("searchXPosts searches and dedupes cached feed rows when X credentials are absent", async () => {
    const duplicate = makeFeedItem("tweet-1", "home_timeline", "Milady launch");
    const cachedByFeed: Record<LifeOpsXFeedType, LifeOpsXFeedItem[]> = {
      search: [makeFeedItem("tweet-1", "search", "Milady launch")],
      home_timeline: [
        duplicate,
        makeFeedItem("tweet-2", "home_timeline", "unrelated"),
      ],
      mentions: [makeFeedItem("tweet-3", "mentions", "Milady mention")],
    };
    class StubBase {
      runtime = { agentId: SAME_ID, logger: { warn: () => undefined } };
      ownerEntityId = null;
      agentId() {
        return SAME_ID;
      }
      repository = {
        upsertXDm: vi.fn(),
        upsertXFeedItem: vi.fn(),
        upsertXSyncState: vi.fn(),
        listXDms: vi.fn(async () => []),
        listXFeedItems: vi.fn(
          async (_agentId: string, feedType: LifeOpsXFeedType) =>
            cachedByFeed[feedType],
        ),
      };
    }
    const Composed = withXRead(StubBase as never);
    const svc = new (Composed as unknown as new () => StubBase &
      XReadService)();

    const results = await svc.searchXPosts("milady");

    expect(results.map((item) => item.externalTweetId)).toEqual([
      "tweet-1",
      "tweet-3",
    ]);
    expect(svc.repository.upsertXFeedItem).not.toHaveBeenCalled();
  });
});
