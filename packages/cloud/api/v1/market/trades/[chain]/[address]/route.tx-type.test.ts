/**
 * GET /api/v1/market/trades/:chain/:address `tx_type` is token-trade
 * type identity, not leftover tax on market-candles OHLCV type.
 * Stock develop forwarded unknown tokens to the paid market-data
 * provider, so `tx_type=SWAP` / `buy` / `1e2` billed a wrong (or
 * empty) trade series instead of a 400.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const SOLANA_TOKEN = "So11111111111111111111111111111111111111112";
const EXPECTED_TOKEN_TRADE_TYPES = ["swap", "add", "remove", "all"] as const;

type ExecuteWithBody =
  typeof import("@/lib/services/proxy/engine").executeWithBody;

const executeWithBody = mock(async (..._args: Parameters<ExecuteWithBody>) =>
  Response.json({ success: true }),
);

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

const { default: route, TOKEN_TRADE_TYPES } = await import("./route");
const app = new Hono().route("/api/v1/market/trades/:chain/:address", route);

function trades(query = "") {
  return app.request(`/api/v1/market/trades/solana/${SOLANA_TOKEN}${query}`);
}

describe("GET /api/v1/market/trades token-trade type identity", () => {
  beforeEach(() => {
    executeWithBody.mockClear();
  });

  test.each(["", "?tx_type="])(
    "accepts %s as the provider-default trade type",
    async (query) => {
      const response = await trades(query);
      expect(response.status).toBe(200);
      expect(executeWithBody).toHaveBeenCalledTimes(1);
      const body = executeWithBody.mock.calls[0][3] as {
        method: string;
        params: Record<string, string>;
      };
      expect(body.method).toBe("getTokenTrades");
      expect(body.params.address).toBe(SOLANA_TOKEN);
      expect(body.params.tx_type).toBeUndefined();
    },
  );

  test("keeps the canonical Birdeye token-trade contract exhaustive", () => {
    expect(TOKEN_TRADE_TYPES).toEqual(EXPECTED_TOKEN_TRADE_TYPES);
    expect(Object.isFrozen(TOKEN_TRADE_TYPES)).toBe(true);
  });

  test.each([...EXPECTED_TOKEN_TRADE_TYPES])(
    "accepts tx_type=%s as a canonical Birdeye trade series",
    async (txType) => {
      const response = await trades(`?tx_type=${txType}`);
      expect(response.status).toBe(200);
      expect(executeWithBody).toHaveBeenCalledTimes(1);
      expect(executeWithBody.mock.calls[0][3]).toMatchObject({
        params: { tx_type: txType },
      });
    },
  );

  test.each(["SWAP", "buy", "sell", "foo", "1e2"])(
    "rejects tx_type=%s before executeWithBody",
    async (token) => {
      const response = await trades(`?tx_type=${encodeURIComponent(token)}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: string;
        details: string;
      };
      expect(body.error).toBe("Invalid tx_type");
      expect(body.details).toContain("swap, add, remove, all");
      expect(executeWithBody).not.toHaveBeenCalled();
    },
  );
});
