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

interface ProxyBody {
  method: string;
  params: Record<string, string>;
}

const preparedBodies: ProxyBody[] = [];
const executePreflight = mock(async (_c: unknown, preflight: () => unknown) => {
  const prepared = await preflight();
  if (prepared instanceof Response) return prepared;
  preparedBodies.push((prepared as { body: ProxyBody }).body);
  return Response.json({ success: true });
});

mock.module("@/api-app/lib/guarded-paid-proxy", () => ({
  executeGuardedPaidProxyWithPreflight: executePreflight,
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

const { default: route, OHLCV_TYPES } = await import("./route");
const app = new Hono().route("/api/v1/market/candles/:chain/:address", route);

function candles(query = "") {
  return app.request(`/api/v1/market/candles/solana/${SOLANA_TOKEN}${query}`);
}

describe("GET /api/v1/market/candles OHLCV interval identity", () => {
  beforeEach(() => {
    executePreflight.mockClear();
    preparedBodies.length = 0;
  });

  test.each(["", "?type="])(
    "accepts %s as the provider-default candle interval",
    async (query) => {
      const response = await candles(query);
      expect(response.status).toBe(200);
      expect(executePreflight).toHaveBeenCalledTimes(1);
      const body = preparedBodies[0];
      expect(body.method).toBe("getOHLCV");
      expect(body.params.address).toBe(SOLANA_TOKEN);
      expect(body.params.type).toBeUndefined();
    },
  );

  test.each([...OHLCV_TYPES])(
    "accepts type=%s as a canonical OHLCV interval",
    async (type) => {
      const response = await candles(`?type=${type}`);
      expect(response.status).toBe(200);
      expect(executePreflight).toHaveBeenCalledTimes(1);
      expect(preparedBodies[0]).toMatchObject({
        params: { type },
      });
    },
  );

  test.each(["1h", "1d", "HOUR", "daily", "foo", "1e2"])(
    "rejects type=%s before executeWithBody",
    async (token) => {
      const response = await candles(`?type=${encodeURIComponent(token)}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid type");
      expect(executePreflight).toHaveBeenCalledTimes(1);
      expect(preparedBodies).toHaveLength(0);
    },
  );
});
