/**
 * GET /api/v1/market/candles/:chain/:address `type` is OHLCV interval
 * identity, not leftover tax on analytics periods, analytics export
 * type, or token-lookup chain. Stock develop forwarded unknown tokens
 * to the paid market-data provider, so `type=1h` / `1d` / `HOUR`
 * billed a wrong (or empty) candle series instead of a 400.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const SOLANA_TOKEN = "So11111111111111111111111111111111111111112";

const executeWithBody = mock(async () => Response.json({ success: true }));

mock.module("@/lib/services/proxy/engine", () => ({
  executeWithBody,
}));
mock.module("@/lib/services/proxy/cors", () => ({
  applyCorsHeaders: (response: Response) => response,
  handleCorsOptions: () => new Response(null, { status: 204 }),
}));
mock.module("@/lib/services/proxy/services/address-validation", () => ({
  isValidChain: () => true,
  isValidAddress: () => true,
}));
mock.module("@/lib/services/proxy/services/market-data", () => ({
  marketDataConfig: { id: "market-data" },
  marketDataHandler: {},
}));

const route = (await import("./route")).default;
const app = new Hono().route(
  "/api/v1/market/candles/:chain/:address",
  route,
);

function candles(query = "") {
  return app.request(
    `/api/v1/market/candles/solana/${SOLANA_TOKEN}${query}`,
  );
}

describe("GET /api/v1/market/candles OHLCV interval identity", () => {
  beforeEach(() => {
    executeWithBody.mockClear();
  });

  test.each(["", "?type="])(
    "accepts %s as the provider-default candle interval",
    async (query) => {
      const response = await candles(query);
      expect(response.status).toBe(200);
      expect(executeWithBody).toHaveBeenCalledTimes(1);
      const body = executeWithBody.mock.calls[0][3] as {
        method: string;
        params: Record<string, string>;
      };
      expect(body.method).toBe("getOHLCV");
      expect(body.params.address).toBe(SOLANA_TOKEN);
      expect(body.params.type).toBeUndefined();
    },
  );

  test("accepts type=1H as the hourly OHLCV interval", async () => {
    const response = await candles("?type=1H");
    expect(response.status).toBe(200);
    expect(executeWithBody).toHaveBeenCalledTimes(1);
    const body = executeWithBody.mock.calls[0][3] as {
      params: Record<string, string>;
    };
    expect(body.params.type).toBe("1H");
  });

  test("accepts type=1D as the daily OHLCV interval", async () => {
    const response = await candles("?type=1D");
    expect(response.status).toBe(200);
    expect(executeWithBody.mock.calls[0][3]).toMatchObject({
      params: { type: "1D" },
    });
  });

  test.each(["1h", "1d", "HOUR", "daily", "foo", "1e2"])(
    "rejects type=%s before executeWithBody",
    async (token) => {
      const response = await candles(`?type=${encodeURIComponent(token)}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid type");
      expect(executeWithBody).not.toHaveBeenCalled();
    },
  );
});
