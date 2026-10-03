/**
 * POST /api/crypto/direct-payments/:id/confirm malformed-JSON boundary.
 *
 * Deterministic harness: real Hono route with real Zod validation; only
 * session auth, the money rate limiter, the payment repository, and the
 * confirmation service are stubbed. No database rows are mutated.
 */

import { afterAll, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";

const organizationId = randomUUID();
const userId = randomUUID();
const paymentId = randomUUID();
const caller = { id: userId, organization_id: organizationId };

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => caller,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  moneyRateLimit: () => async (_c: unknown, next: () => Promise<void>) =>
    next(),
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  RateLimitPresets: { STRICT: {}, STANDARD: {} },
}));

const confirmCalls: Array<unknown> = [];

mock.module("@/db/repositories/crypto-payments", () => ({
  cryptoPaymentsRepository: {
    findById: async (id: string) => ({
      id,
      organization_id: organizationId,
      user_id: userId,
      payment_address: "0x0000000000000000000000000000000000000001",
      token_address: null,
      token: "USDC",
      network: "evm",
      expected_amount: "10",
      received_amount: null,
      credits_to_add: "500",
      transaction_hash: null,
      block_number: null,
      status: "pending",
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      updated_at: new Date("2026-01-01T00:00:00.000Z"),
      confirmed_at: null,
      expires_at: new Date("2026-01-02T00:00:00.000Z"),
      metadata: { direct_network: "evm" },
    }),
  },
}));

mock.module("@/lib/services/direct-wallet-payments", () => ({
  directWalletPaymentsService: {
    confirmPayment: async (params: unknown) => {
      confirmCalls.push(params);
      return {
        alreadyConfirmed: false,
        payment: { id: paymentId, credits_to_add: "500" },
      };
    },
  },
}));

const { default: route } = await import(
  "../crypto/direct-payments/[id]/confirm/route"
);

afterAll(() => {
  mock.restore();
});

test("malformed JSON answers 400 without confirming", async () => {
  confirmCalls.length = 0;
  const response = await route.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  expect(response.status).toBe(400);
  expect(confirmCalls).toHaveLength(0);
});

test("valid confirmation still succeeds", async () => {
  confirmCalls.length = 0;
  const response = await route.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      transactionHash: `0x${"a".repeat(64)}`,
      payerSignature: "sig",
    }),
  });
  expect(response.status).toBe(200);
  expect(confirmCalls).toHaveLength(1);
});
