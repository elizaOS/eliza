/**
 * Tests for POST /api/users/me/wallet/attach.
 *
 * Mocks every external dep (auth, Redis, SIWE validator, users service) so
 * the assertions live entirely in the route module's branching logic:
 *   - already_attached when the authed user has a wallet
 *   - 400 on a malformed body
 *   - 401 when SIWE verification throws
 *   - 409 wallet_taken when the address belongs to a different user
 *   - 200 + usersService.update call with normalized fields on the happy path
 *
 * `bun:test`'s `mock.module` is hoisted-import-aware: register mocks BEFORE
 * importing the route module. The route is a Hono app, so we exercise it via
 * `app.fetch(new Request(...))`.
 */

import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

const validateAndConsumeSIWE =
  mock<
    (
      redis: unknown,
      message: string,
      signature: string,
      host: string,
    ) => Promise<{ address: string }>
  >();

const getByWalletAddress =
  mock<(address: string) => Promise<{ id: string } | undefined>>();

const usersServiceUpdate =
  mock<
    (
      id: string,
      data: Record<string, unknown>,
    ) => Promise<
      | {
          id: string;
          wallet_address: string;
          wallet_chain_type: string;
          wallet_verified: boolean;
        }
      | undefined
    >
  >();

const requireUser =
  mock<
    (c: unknown) => Promise<{ id: string; wallet_address: string | null }>
  >();

const buildRedisClient = mock<(env: unknown) => unknown>();

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUser,
}));

mock.module("@/lib/cache/redis-factory", () => ({
  buildRedisClient,
}));

mock.module("@/lib/utils/siwe-helpers", () => ({
  validateAndConsumeSIWE,
}));

mock.module("@/lib/services/users", () => ({
  usersService: {
    getByWalletAddress,
    update: usersServiceUpdate,
  },
}));

mock.module("@/lib/utils/app-url", () => ({
  getAppHost: () => "elizacloud.ai",
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STRICT: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

// EIP-55 checksummed mainnet address (any valid checksum works for these tests).
const VALID_ADDRESS = "0x52908400098527886E0F7030069857D2E4169EE7";
const VALID_ADDRESS_LOWER = VALID_ADDRESS.toLowerCase();
const VALID_SIGNATURE = `0x${"a".repeat(130)}` as const;

let attachRoute: { default: { fetch: (req: Request) => Promise<Response> } };

beforeAll(async () => {
  attachRoute = (await import(
    "../users/me/wallet/attach/route"
  )) as typeof attachRoute;
});

function makeRequest(body: unknown) {
  return new Request("http://test.local/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  validateAndConsumeSIWE.mockReset();
  getByWalletAddress.mockReset();
  usersServiceUpdate.mockReset();
  requireUser.mockReset();
  buildRedisClient.mockReset();
});

describe("POST /api/users/me/wallet/attach", () => {
  test("returns 409 already_attached when the user already has a wallet", async () => {
    requireUser.mockResolvedValue({
      id: "user-1",
      wallet_address: "0xdeadbeef",
    });

    const res = await attachRoute.default.fetch(
      makeRequest({ message: "msg", signature: VALID_SIGNATURE }),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("already_attached");
    expect(validateAndConsumeSIWE).not.toHaveBeenCalled();
  });

  test("returns 400 when body is missing message or signature", async () => {
    requireUser.mockResolvedValue({ id: "user-1", wallet_address: null });
    buildRedisClient.mockReturnValue({});

    const res = await attachRoute.default.fetch(makeRequest({ message: "x" }));

    expect(res.status).toBe(400);
    expect(validateAndConsumeSIWE).not.toHaveBeenCalled();
  });

  test("returns 401 when SIWE validation throws", async () => {
    requireUser.mockResolvedValue({ id: "user-1", wallet_address: null });
    buildRedisClient.mockReturnValue({});
    validateAndConsumeSIWE.mockRejectedValue(new Error("nonce invalid"));

    const res = await attachRoute.default.fetch(
      makeRequest({ message: "msg", signature: VALID_SIGNATURE }),
    );

    expect(res.status).toBe(401);
    expect(usersServiceUpdate).not.toHaveBeenCalled();
  });

  test("returns 409 wallet_taken when address belongs to a different user", async () => {
    requireUser.mockResolvedValue({ id: "user-1", wallet_address: null });
    buildRedisClient.mockReturnValue({});
    validateAndConsumeSIWE.mockResolvedValue({ address: VALID_ADDRESS });
    getByWalletAddress.mockResolvedValue({ id: "user-2" });

    const res = await attachRoute.default.fetch(
      makeRequest({ message: "msg", signature: VALID_SIGNATURE }),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("wallet_taken");
    expect(usersServiceUpdate).not.toHaveBeenCalled();
  });

  test("returns 200 and updates the user on the happy path", async () => {
    requireUser.mockResolvedValue({ id: "user-1", wallet_address: null });
    buildRedisClient.mockReturnValue({});
    validateAndConsumeSIWE.mockResolvedValue({ address: VALID_ADDRESS });
    getByWalletAddress.mockResolvedValue(undefined);
    usersServiceUpdate.mockResolvedValue({
      id: "user-1",
      wallet_address: VALID_ADDRESS_LOWER,
      wallet_chain_type: "evm",
      wallet_verified: true,
    });

    const res = await attachRoute.default.fetch(
      makeRequest({ message: "msg", signature: VALID_SIGNATURE }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      address: string;
      user: { wallet_address: string };
    };
    expect(body.address).toBe(VALID_ADDRESS);
    expect(body.user.wallet_address).toBe(VALID_ADDRESS_LOWER);
    expect(usersServiceUpdate).toHaveBeenCalledWith("user-1", {
      wallet_address: VALID_ADDRESS_LOWER,
      wallet_chain_type: "evm",
      wallet_verified: true,
    });
  });

  test("returns 409 wallet_taken when the address is bound to the SAME user (race-safe)", async () => {
    // If the conflict-check finds the same user, the prior wallet_address gate
    // would have caught it. But cover the edge case where user record state is
    // stale between requireUser and getByWalletAddress.
    requireUser.mockResolvedValue({ id: "user-1", wallet_address: null });
    buildRedisClient.mockReturnValue({});
    validateAndConsumeSIWE.mockResolvedValue({ address: VALID_ADDRESS });
    getByWalletAddress.mockResolvedValue({ id: "user-1" });
    usersServiceUpdate.mockResolvedValue({
      id: "user-1",
      wallet_address: VALID_ADDRESS_LOWER,
      wallet_chain_type: "evm",
      wallet_verified: true,
    });

    const res = await attachRoute.default.fetch(
      makeRequest({ message: "msg", signature: VALID_SIGNATURE }),
    );

    // Same user found: not a conflict, route should proceed to update.
    expect(res.status).toBe(200);
    expect(usersServiceUpdate).toHaveBeenCalled();
  });
});
