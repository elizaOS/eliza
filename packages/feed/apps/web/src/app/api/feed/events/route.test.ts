import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { NextRequest } from "next/server";

const insertMock = mock(() => ({
  values: mock(() => Promise.resolve()),
}));
const generateSnowflakeIdMock = mock(() => Promise.resolve("evt-1"));
const checkRateLimitAsyncMock = mock(() =>
  Promise.resolve({ allowed: true, retryAfter: 0 }),
);

mock.module("@feed/api", () => ({
  addPublicReadHeaders: () => {},
  checkRateLimitAsync: checkRateLimitAsyncMock,
  rateLimitError: (retryAfter: number) =>
    new Response(
      JSON.stringify({
        success: false,
        error: "Rate limit exceeded",
        retryAfter,
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(retryAfter),
        },
      },
    ),
  authenticate: () =>
    Promise.resolve({
      userId: "privy-user-1",
      walletAddress: "0x1234567890abcdef",
    }),
  ensureUserForAuth: () =>
    Promise.resolve({
      user: { id: "user-1" },
    }),
  publicRateLimit: () =>
    Promise.resolve({
      error: null,
      user: null,
      rateLimitInfo: null,
    }),
  RATE_LIMIT_CONFIGS: {
    FEED_EVENT_BATCH: {
      maxRequests: 120,
      windowMs: 60000,
      actionType: "feed_event_batch",
    },
  },
  successResponse: (data: unknown) =>
    new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" },
    }),
  withErrorHandling: (handler: (request: NextRequest) => Promise<Response>) =>
    handler,
}));

mock.module("@feed/db", () => ({
  db: {
    insert: insertMock,
  },
  feedEvents: { _table: "FeedEvent" },
}));

mock.module("@feed/shared", () => ({
  generateSnowflakeId: generateSnowflakeIdMock,
}));

const { POST } = await import("./route");

beforeEach(() => {
  insertMock.mockClear();
  generateSnowflakeIdMock.mockClear();
  checkRateLimitAsyncMock.mockClear();
});

describe("POST /api/feed/events", () => {
  it("accepts and stores a batch of feed events", async () => {
    const request = {
      json: () =>
        Promise.resolve({
          events: [
            {
              actionType: "impression",
              surface: "for_you",
              itemId: "post-1",
              itemType: "post",
              clusterId: "cluster-1",
              topicKey: "openai",
              authorId: "author-1",
              feedPosition: 0,
            },
            {
              actionType: "trade_after_view",
              surface: "for_you",
              itemId: "market-1",
              itemType: "market",
              clusterId: "market-1",
              marketId: "market-1",
              topicKey: "openai",
              feedPosition: 1,
              dwellMs: 2500,
            },
          ],
        }),
    } as unknown as NextRequest;

    const response = await POST(request);
    const payload = await response.json();

    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(generateSnowflakeIdMock).toHaveBeenCalledTimes(2);
    expect(payload.success).toBe(true);
    expect(payload.accepted).toBe(2);
  });

  it("returns 429 when the user exceeds the feed event batch limit", async () => {
    checkRateLimitAsyncMock.mockResolvedValueOnce({
      allowed: false,
      retryAfter: 30,
    });

    const request = {
      json: () =>
        Promise.resolve({
          events: [
            {
              actionType: "impression",
              surface: "for_you",
              itemId: "post-1",
              itemType: "post",
            },
          ],
        }),
    } as unknown as NextRequest;

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(429);
    expect(insertMock).not.toHaveBeenCalled();
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("Rate limit exceeded");
    expect(payload.retryAfter).toBe(30);
  });
});
