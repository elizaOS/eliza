/**
 * Drives the OxaPay manual-confirmation route through its real Hono handler
 * with deterministic authentication and a recorded payment service, proving
 * a row the expiry cron already marked `expired` still reaches provider
 * verification: a payment OxaPay reports paid is confirmed, and one it does
 * not keeps the route's "Payment has expired" answer.
 */
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const USER = { id: "user-1", organization_id: "org-1" };
const PAYMENT_ID = "00000000-0000-4000-8000-000000000002";
const EVM_TX_HASH = `0x${"2".repeat(64)}`;

const payment = {
  id: PAYMENT_ID,
  organization_id: USER.organization_id,
  user_id: USER.id,
  status: "expired",
  network: "ERC20",
};
const verification = {
  calls: [] as unknown[][],
  result: { success: true, message: "Payment confirmed successfully" },
};

mock.module("@elizaos/cloud-shared/auth", () => ({
  requireUserWithOrg: async () => USER,
}));
mock.module(
  "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare",
  () => ({
    RateLimitPresets: { STANDARD: {}, STRICT: {} },
    moneyRateLimit: () => async (_c: unknown, next: () => Promise<void>) =>
      next(),
  }),
);
mock.module("@elizaos/cloud-shared/db/repositories/crypto-payments", () => ({
  cryptoPaymentsRepository: {
    findById: async (id: string) => (id === PAYMENT_ID ? payment : undefined),
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/crypto-payments", () => ({
  cryptoPaymentsService: {
    verifyAndConfirmByTxHash: async (...input: unknown[]) => {
      verification.calls.push(input);
      return verification.result;
    },
  },
}));
mock.module("@elizaos/cloud-shared/lib/utils/logger", () => ({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  redact: {
    paymentId: (value: string) => value,
    ip: (value: string) => value,
    userId: (value: string) => value,
    orgId: (value: string) => value,
  },
}));

const { default: confirmRoute } = await import(
  "../crypto/payments/[id]/confirm/route"
);
const app = new Hono<AppEnv>().route(
  "/crypto/payments/:id/confirm",
  confirmRoute,
);

afterAll(() => mock.restore());

beforeEach(() => {
  verification.calls.length = 0;
  verification.result = {
    success: true,
    message: "Payment confirmed successfully",
  };
});

function confirm() {
  return app.request(`/crypto/payments/${PAYMENT_ID}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transactionHash: EVM_TX_HASH }),
  });
}

test("an expired payment the provider reports paid is confirmed", async () => {
  const response = await confirm();

  expect(response.status).toBe(200);
  const payload = (await response.json()) as {
    success?: boolean;
    status?: string;
  };
  expect(payload.success).toBe(true);
  expect(payload.status).toBe("confirmed");
  expect(verification.calls).toEqual([[PAYMENT_ID, EVM_TX_HASH]]);
});

test("an expired payment the provider does not confirm stays expired", async () => {
  verification.result = {
    success: false,
    message: "Payment not yet confirmed by blockchain. Current status: Expired",
  };

  const response = await confirm();

  expect(response.status).toBe(400);
  const payload = (await response.json()) as Record<string, unknown>;
  expect(payload).toEqual({ error: "Payment has expired" });
  expect(verification.calls).toEqual([[PAYMENT_ID, EVM_TX_HASH]]);
});
