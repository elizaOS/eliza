/**
 * Error-path test for GET /api/markets/predictions/[id]: a market that cannot be
 * loaded must distinguish a legitimate "not found" (404, preserved body) from a
 * real infra fault, which now propagates to withErrorHandling (500 + Sentry)
 * instead of being masked as a fabricated 404 (#12276). Deterministic — the
 * PredictionMarketService and DB layer are mocked; no live DB.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { NextRequest } from "next/server";

class NotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = "NOT_FOUND";
  constructor(resource: string, id?: string) {
    super(id ? `${resource} not found: ${id}` : `${resource} not found`);
    this.name = "NotFoundError";
  }
}

const mockGetMarket = mock(async () => null as unknown);
const mockEnsureMarketExists = mock(async () => ({}) as unknown);

mock.module("@feed/api", () => ({
  addPublicReadHeaders: mock(() => undefined),
  publicRateLimit: mock(async () => ({
    error: null,
    user: null,
    rateLimitInfo: null,
  })),
  successResponse: (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  // Faithful mini-boundary: maps a thrown FeedError-shaped statusCode to the
  // response status, otherwise 500 — the real withErrorHandling contract.
  withErrorHandling:
    (
      handler: (
        request: NextRequest,
        context: unknown,
      ) => Promise<Response> | Response,
    ) =>
    async (request: NextRequest, context: unknown) => {
      try {
        return await handler(request, context);
      } catch (error) {
        const status =
          error &&
          typeof (error as { statusCode?: unknown }).statusCode === "number"
            ? (error as { statusCode: number }).statusCode
            : 500;
        return new Response(
          JSON.stringify({
            error: { message: (error as Error)?.message ?? "error" },
          }),
          { status, headers: { "content-type": "application/json" } },
        );
      }
    },
}));

mock.module("@feed/core/markets/prediction", () => ({
  PredictionDbAdapter: class {},
  PredictionMarketService: class {
    getMarket = mockGetMarket;
    ensureMarketExists = mockEnsureMarketExists;
    listUserPositions = mock(async () => []);
  },
  PredictionPricing: { getCurrentPrice: () => 0.5 },
}));

mock.module("@feed/db", () => ({
  db: { select: () => ({ from: () => ({ where: async () => [] }) }) },
  and: () => undefined,
  balanceTransactions: {},
  count: () => undefined,
  eq: () => undefined,
  inArray: () => undefined,
  npcTrades: {},
}));

mock.module("@feed/engine", () => ({
  FEE_CONFIG: {
    TRADING_FEE_RATE: 0,
    PLATFORM_SHARE: 0,
    REFERRER_SHARE: 0,
    MIN_FEE_AMOUNT: 0,
  },
  WalletService: {
    debit: async () => undefined,
    credit: async () => undefined,
    recordPnL: async () => undefined,
    getBalance: async () => 0,
  },
}));

mock.module("@feed/shared", () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
  MarketQuerySchema: {
    merge: () => ({
      partial: () => ({ safeParse: () => ({ success: true, data: {} }) }),
    }),
  },
  NotFoundError,
  PredictionMarketIdSchema: { parse: (v: { id: string }) => v },
  toISOOrNull: () => null,
}));

mock.module("../_position-snapshot", () => ({
  buildPredictionUserPositionSnapshot: () => null,
}));
mock.module("../_resolution-audit", () => ({
  getPublicResolutionAudit: async () => null,
}));

const { GET } = await import("./route");

function makeRequest(): NextRequest {
  return {
    url: "https://feed.test/api/markets/predictions/mkt-1",
    method: "GET",
    headers: new Headers(),
    cookies: { get: () => undefined },
  } as unknown as NextRequest;
}

const ctx = { params: Promise.resolve({ id: "mkt-1" }) };

describe("GET /api/markets/predictions/[id] — error paths", () => {
  beforeEach(() => {
    mockGetMarket.mockReset();
    mockEnsureMarketExists.mockReset();
    mockGetMarket.mockResolvedValue(null);
  });

  it("returns a 404 with the canonical body when the market genuinely does not exist", async () => {
    mockEnsureMarketExists.mockRejectedValue(
      new NotFoundError("Market", "mkt-1"),
    );
    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Market not found" });
  });

  it("propagates a real infra fault as a 500 instead of masking it as a fabricated 404", async () => {
    mockEnsureMarketExists.mockRejectedValue(
      new Error("connection terminated"),
    );
    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(500);
    expect(res.status).not.toBe(404);
  });
});
