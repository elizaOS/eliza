/**
 * POST /api/v1/user/wallets/rpc untrusted JSON body contract.
 *
 * Hono 4.13 `c.req.json()` is a bare `JSON.parse`. The handler catch maps
 * SyntaxError through `failureResponse` to HTTP 500 instead of a caller 400.
 * Server-wallet RPC must not verify a signature or execute on garbage.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const WALLET = "0x1111111111111111111111111111111111111111";

const verifyWalletSignature = mock(async () => {
  throw new Error("verifyWalletSignature must not run");
});
const executeServerWalletRpc = mock(async () => {
  throw new Error("executeServerWalletRpc must not run");
});

mock.module("@/lib/auth/wallet-auth", () => ({
  verifyWalletSignature,
}));

mock.module("@/lib/services/server-wallets", () => ({
  executeServerWalletRpc,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: mock((c: { json: (body: unknown, status: number) => unknown }) =>
    c.json({ success: false, error: "An unexpected error occurred" }, 500),
  ),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

const { default: app } = await import("./route");

function post(raw: string) {
  return app.fetch(
    new Request("http://test.local/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Wallet-Address": WALLET,
      },
      body: raw,
    }),
  );
}

const canonical = JSON.stringify({
  clientAddress: WALLET,
  payload: { method: "eth_blockNumber", params: [] },
  signature: "0xabc",
  timestamp: 1_700_000_000,
  nonce: "n1",
});

describe("POST /api/v1/user/wallets/rpc JSON body", () => {
  beforeEach(() => {
    verifyWalletSignature.mockClear();
    executeServerWalletRpc.mockClear();
    verifyWalletSignature.mockImplementation(async () => {
      throw new Error("verifyWalletSignature must not run");
    });
    executeServerWalletRpc.mockImplementation(async () => {
      throw new Error("executeServerWalletRpc must not run");
    });
  });

  test.each(["", "   ", "{", "not-json"])(
    "rejects malformed wallet RPC body %j with 400",
    async (raw) => {
      const res = await post(raw);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        success: false,
        error: "Invalid JSON body",
      });
      expect(verifyWalletSignature).not.toHaveBeenCalled();
      expect(executeServerWalletRpc).not.toHaveBeenCalled();
    },
  );

  test.each(['["eth_call"]', '"eth_call"', "null", "12"])(
    "rejects non-object wallet RPC body %s with 400",
    async (raw) => {
      const res = await post(raw);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        success: false,
        error: "Invalid JSON body",
      });
      expect(verifyWalletSignature).not.toHaveBeenCalled();
      expect(executeServerWalletRpc).not.toHaveBeenCalled();
    },
  );

  test("still 400s a parseable object missing fields via zod", async () => {
    const res = await post("{}");

    expect(res.status).toBe(400);
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("Validation error");
    expect(verifyWalletSignature).not.toHaveBeenCalled();
    expect(executeServerWalletRpc).not.toHaveBeenCalled();
  });

  test("still executes a canonical signed object body", async () => {
    verifyWalletSignature.mockResolvedValue({
      wallet_address: WALLET,
    });
    executeServerWalletRpc.mockResolvedValue({ result: "0x1" });

    const res = await post(canonical);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: { result: "0x1" },
    });
    expect(verifyWalletSignature).toHaveBeenCalledTimes(1);
    expect(executeServerWalletRpc).toHaveBeenCalledTimes(1);
    expect(executeServerWalletRpc.mock.calls[0]?.[0]).toMatchObject({
      clientAddress: WALLET,
      signature: "0xabc",
    });
  });
});
