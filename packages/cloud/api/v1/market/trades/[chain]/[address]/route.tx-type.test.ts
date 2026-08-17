/**
 * GET /api/v1/market/trades/:chain/:address `tx_type` is token-trade
 * type identity, not leftover tax on market-candles OHLCV type.
 * Stock develop forwarded unknown tokens to the paid market-data
 * provider, so `tx_type=SWAP` / `buy` / `1e2` billed a wrong (or
 * empty) trade series instead of a 400.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type {
  ProxyRequestBody,
  ServiceConfig,
  ServiceHandler,
} from "@/lib/services/proxy/types";

const SOLANA_TOKEN = "So11111111111111111111111111111111111111112";

const executeWithBody = mock(
  async (
    _config: ServiceConfig,
    _work: ServiceHandler,
    _request: Request,
    _body: ProxyRequestBody,
  ) => Response.json({ success: true }),
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

const route = (await import("./route")).default;
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

  test("accepts tx_type=swap as the swap trade series", async () => {
    const response = await trades("?tx_type=swap");
    expect(response.status).toBe(200);
    expect(executeWithBody).toHaveBeenCalledTimes(1);
    const body = executeWithBody.mock.calls[0][3] as {
      params: Record<string, string>;
    };
    expect(body.params.tx_type).toBe("swap");
  });

  test("accepts tx_type=add as the add-liquidity series", async () => {
    const response = await trades("?tx_type=add");
    expect(response.status).toBe(200);
    expect(executeWithBody.mock.calls[0][3]).toMatchObject({
      params: { tx_type: "add" },
    });
  });

  test("accepts tx_type=all as the unfiltered trade series", async () => {
    const response = await trades("?tx_type=all");
    expect(response.status).toBe(200);
    expect(executeWithBody.mock.calls[0][3]).toMatchObject({
      params: { tx_type: "all" },
    });
  });

  test.each(["SWAP", "buy", "sell", "foo", "1e2"])(
    "rejects tx_type=%s before executeWithBody",
    async (token) => {
      const response = await trades(`?tx_type=${encodeURIComponent(token)}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid tx_type");
      expect(executeWithBody).not.toHaveBeenCalled();
    },
  );
});
