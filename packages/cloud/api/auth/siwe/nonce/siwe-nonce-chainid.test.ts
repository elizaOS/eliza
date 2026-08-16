/**
 * SIWE nonce chainId contract at the HTTP boundary.
 *
 * The real route must reject prefix-coercible garbage before issueNonce /
 * Redis setex. This file stubs the rate limiter so failures cannot be blamed
 * on middleware, and records setex so every 400 is proven write-free.
 */

import { describe, expect, mock, test } from "bun:test";

const setex = mock(async (_key: string, _ttl: number, _value: string) => "OK");

mock.module("@/lib/cache/redis-factory", () => ({
  buildRedisClient: () => ({ setex }),
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STRICT: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { warn: mock(() => undefined) },
}));

const { default: app } = await import("./route");

function getNonce(query = "") {
  return app.request(
    `/${query}`,
    { method: "GET" },
    {
      NEXT_PUBLIC_APP_URL: "https://staging.elizacloud.ai",
    },
  );
}

describe("GET /api/auth/siwe/nonce — chainId contract", () => {
  test.each([
    ["1", "Ethereum mainnet", 1],
    ["137", "Polygon", 137],
    ["8453", "Base", 8453],
    ["2147483648", "above signed 32-bit", 2_147_483_648],
    [
      "9007199254740991",
      "JavaScript safe-integer max",
      Number.MAX_SAFE_INTEGER,
    ],
  ] as const)(
    "canonical chainId %s (%s) succeeds and persists the offered binding",
    async (value, _label, chainId) => {
      setex.mockClear();
      const res = await getNonce(`?chainId=${value}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const body = (await res.json()) as { chainId: number; nonce: string };
      expect(body.chainId).toBe(chainId);
      expect(body.nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(setex).toHaveBeenCalledTimes(1);
      const stored = setex.mock.calls[0]?.[2];
      expect(JSON.parse(String(stored))).toMatchObject({ chainId });
    },
  );

  test("missing chainId defaults to 1 and persists that binding", async () => {
    setex.mockClear();
    const res = await getNonce();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chainId: number };
    expect(body.chainId).toBe(1);
    expect(setex).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(setex.mock.calls[0]?.[2]))).toMatchObject({
      chainId: 1,
    });
  });

  test("empty chainId defaults to 1 and persists that binding", async () => {
    setex.mockClear();
    const res = await getNonce("?chainId=");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chainId: number };
    expect(body.chainId).toBe(1);
    expect(setex).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(setex.mock.calls[0]?.[2]))).toMatchObject({
      chainId: 1,
    });
  });

  test.each([
    ["not-a-number", "junk"],
    ["1e4", "scientific notation"],
    ["0x10", "hex"],
    ["137abc", "trailing junk"],
    ["-1", "signed"],
    ["+1", "signed plus"],
    ["0", "zero"],
    ["080", "leading zero"],
    ["1.5", "fractional"],
    [" 1", "leading whitespace"],
    ["1 ", "trailing whitespace"],
    ["1 0", "internal whitespace"],
    ["9007199254740992", "above JavaScript safe-integer max"],
    ["9007199254740993", "unsafe integer that rounds"],
  ] as const)(
    "returns 400 invalid_chain_id and writes no nonce for %s (%s)",
    async (value) => {
      setex.mockClear();
      const res = await getNonce(`?chainId=${encodeURIComponent(value)}`);
      expect(res.status).toBe(400);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      await expect(res.json()).resolves.toEqual({
        error: "Invalid SIWE chainId",
        code: "invalid_chain_id",
      });
      expect(setex).not.toHaveBeenCalled();
    },
  );
});
