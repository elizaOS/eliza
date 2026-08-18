/**
 * GET /api/v1/market/trades/:chain/:address previously forwarded raw
 * `limit`/`offset` query strings straight to the paid market-data provider
 * (`if (limit) requestParams.limit = limit`). Any string survived: negative,
 * fractional, scientific-notation, hex, or wildly over-limit values all went
 * upstream unclamped. This drives the real Hono route (not the implementation
 * source) and asserts the exact forwarded `limit`/`offset` payload.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const SOLANA_TOKEN = "So11111111111111111111111111111111111111112";

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

const { default: route } = await import("./route");
const app = new Hono().route("/api/v1/market/trades/:chain/:address", route);

function trades(query: string) {
  return app.request(`/api/v1/market/trades/solana/${SOLANA_TOKEN}${query}`);
}

async function forwardedParams(query: string) {
  const response = await trades(query);
  expect(response.status).toBe(200);
  const body = executeWithBody.mock.calls.at(-1)?.[3] as {
    params: Record<string, string>;
  };
  return body.params;
}

describe("GET /api/v1/market/trades limit/offset clamp", () => {
  beforeEach(() => {
    executeWithBody.mockClear();
  });

  test("omits limit/offset when absent, matching provider defaults", async () => {
    const params = await forwardedParams("");
    expect(params.limit).toBeUndefined();
    expect(params.offset).toBeUndefined();
  });

  test("forwards a valid in-range limit/offset unchanged", async () => {
    const params = await forwardedParams("?limit=25&offset=10");
    expect(params.limit).toBe("25");
    expect(params.offset).toBe("10");
  });

  test("clamps an over-limit request to the max instead of forwarding it raw", async () => {
    const params = await forwardedParams("?limit=999999");
    expect(params.limit).toBe("100");
  });

  test.each(["1e2", "0x10", "5.9", "-5", "5junk", "Infinity", "NaN"])(
    "falls back to the default for a malformed limit=%s instead of forwarding it raw",
    async (malformed) => {
      const params = await forwardedParams(
        `?limit=${encodeURIComponent(malformed)}`,
      );
      expect(params.limit).toBe("50");
    },
  );

  test.each(["1e2", "0x10", "5.9", "-5", "5junk"])(
    "falls back to the default for a malformed offset=%s instead of forwarding it raw",
    async (malformed) => {
      const params = await forwardedParams(
        `?offset=${encodeURIComponent(malformed)}`,
      );
      expect(params.offset).toBe("0");
    },
  );

  test("empty-string limit/offset are treated as absent, not as zero", async () => {
    const params = await forwardedParams("?limit=&offset=");
    expect(params.limit).toBeUndefined();
    expect(params.offset).toBeUndefined();
  });
});
