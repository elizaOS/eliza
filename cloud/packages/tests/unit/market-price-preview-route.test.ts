import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

// Shared no-op rate limit config used in the mock below.
const NOOP_RATE_LIMIT = { windowMs: 60_000, maxRequests: 30 };

describe("price preview route", () => {
  beforeEach(() => {
    mock.restore();
    restoreEnv();
  });

  afterEach(() => {
    mock.restore();
    restoreEnv();
  });

  test("proxies public price preview requests through the shared market-data helper", async () => {
    const handlePublicMarketDataPreviewRequest = mock(async () => {
      const r = Response.json({
        success: true,
        data: { value: 0.33, updateUnixTime: 1713890000 },
      });
      r.headers.set("Cache-Control", "public, max-age=15, stale-while-revalidate=45");
      return r;
    });

    // Mock the entire market-preview module with ALL its exports so that
    // the incomplete mock does not cause SyntaxErrors in later test files
    // (Bun's mock.module replacements persist across files in a bulk run).
    mock.module("@/lib/services/market-preview", () => ({
      handlePublicMarketDataPreviewRequest,
      PUBLIC_MARKET_PREVIEW_CORS_METHODS: "GET, OPTIONS",
      PUBLIC_MARKET_OVERVIEW_CACHE_CONTROL: "public, max-age=30, stale-while-revalidate=60",
      PUBLIC_MARKET_DATA_CACHE_CONTROL: "public, max-age=15, stale-while-revalidate=45",
      PUBLIC_WALLET_OVERVIEW_RATE_LIMIT: NOOP_RATE_LIMIT,
      PUBLIC_PREDICTIONS_RATE_LIMIT: NOOP_RATE_LIMIT,
      PUBLIC_MARKET_PRICE_RATE_LIMIT: NOOP_RATE_LIMIT,
      PUBLIC_MARKET_TOKEN_RATE_LIMIT: NOOP_RATE_LIMIT,
      PUBLIC_MARKET_PORTFOLIO_RATE_LIMIT: NOOP_RATE_LIMIT,
      loadPublicWalletMarketOverview: async () => {
        throw new Error("not mocked");
      },
      loadPublicPredictionPreview: async () => {
        throw new Error("not mocked");
      },
      wrapWalletOverviewPreviewResponse: () => new Response("{}"),
      wrapPredictionPreviewResponse: () => new Response("{}"),
      __resetPublicMarketPreviewCacheForTests: () => {},
    }));

    // No need to mock cors — the real applyCorsHeaders adds Access-Control-Allow-Origin: *.
    const { GET } = await import(
      new URL(
        `../../../apps/api/v1/market/preview/price/[chain]/[address]/route.ts?test=${Date.now()}`,
        import.meta.url,
      ).href
    );

    const response = await GET(
      new Request(
        "https://elizacloud.ai/api/v1/market/preview/price/base/0xD17De9A07b52F856010B372117DF2dFD1910C589",
        {
          headers: { "x-forwarded-for": "203.0.113.12" },
        },
      ),
      {
        params: Promise.resolve({
          chain: "base",
          address: "0xD17De9A07b52F856010B372117DF2dFD1910C589",
        }),
      },
    );

    expect(handlePublicMarketDataPreviewRequest).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=15, stale-while-revalidate=45",
    );
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { value: 0.33, updateUnixTime: 1713890000 },
    });
  });
});
